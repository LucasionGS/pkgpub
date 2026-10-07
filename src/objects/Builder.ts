import * as vscode from "vscode";
import fsp from "node:fs/promises";
import Path from "node:path";
import Settings from "../Settings";
import { runChecked } from "../Utilities";
import type Pkgbuild from "./Pkgbuild";

/**
 * Runs makepkg on a copy of a PKGBUILD in the pkgpub data folder, so the project never gets `src/`, `pkg/`,
 * downloaded sources or built packages in it.
 *
 * Layout of `<dataDirectory>/build/<pkgbase>/`:
 * - `staging/`: fresh copy of the PKGBUILD and its local files on every run; makepkg's `$startdir`, and its
 *   `src/` and `pkg/` unless `BUILDDIR` is set in makepkg.conf
 * - `sources/`: `SRCDEST`, kept between runs so downloads and VCS clones are reused
 * - `packages/`: `PKGDEST` and `SRCPKGDEST`
 * - `logs/`: `LOGDEST`
 */
export class Builder {
  constructor(public readonly pkgbuild: Pkgbuild) { }

  public get root(): string {
    return Settings.buildDirectory(this.pkgbuild.pkgbase);
  }

  public get stagingDir(): string {
    return Path.join(this.root, "staging");
  }

  public get packagesDir(): string {
    return Path.join(this.root, "packages");
  }

  public get stagedPkgbuild(): string {
    return Path.join(this.stagingDir, "PKGBUILD");
  }

  /**
   * Environment that sends all of makepkg's output into the build folder.
   */
  public env(): Record<string, string> {
    return {
      SRCDEST: Path.join(this.root, "sources"),
      PKGDEST: this.packagesDir,
      SRCPKGDEST: this.packagesDir,
      LOGDEST: Path.join(this.root, "logs"),
    };
  }

  /**
   * Copy the PKGBUILD and its local files into a clean staging folder.
   */
  public async stage() {
    await this.pkgbuild.saveIfDirty();
    const files = await this.pkgbuild.getLocalFiles();

    await fsp.rm(this.stagingDir, { recursive: true, force: true });
    for (const dir of [this.stagingDir, ...Object.values(this.env())]) await fsp.mkdir(dir, { recursive: true });

    await fsp.copyFile(this.pkgbuild.path, this.stagedPkgbuild);
    for (const file of files) {
      await fsp.copyFile(file.path, Path.join(this.stagingDir, file.name));
    }
  }

  /**
   * Stage and run makepkg in a terminal task, so prompts like sudo's password work.
   * @param args Arguments for makepkg, on top of the `pkgpub.makepkgArgs` setting.
   * @returns makepkg's exit code, or `undefined` if the task was terminated.
   */
  public async build(args: string[]): Promise<number | undefined> {
    await this.stage();

    const task = new vscode.Task(
      { type: "pkgpub", pkgbase: this.pkgbuild.pkgbase },
      vscode.TaskScope.Workspace,
      `makepkg ${this.pkgbuild.pkgbase}`,
      "pkgpub",
      new vscode.ProcessExecution("makepkg", [...args, ...Settings.makepkgArgs], {
        cwd: this.stagingDir,
        env: this.env(),
      }),
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true, focus: true };

    const execution = await vscode.tasks.executeTask(task);
    return await new Promise((resolve) => {
      const listener = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution !== execution) return;
        listener.dispose();
        resolve(e.exitCode);
      });
    });
  }

  /**
   * Run `updpkgsums` on a staged copy.
   * @returns The PKGBUILD text with updated checksums.
   */
  public async updateChecksums(): Promise<string> {
    await this.stage();
    await runChecked("updpkgsums", ["--nocolor"], "Failed to update the checksums. Check that every source can be downloaded", {
      cwd: this.stagingDir,
      env: this.env(),
    });
    return await fsp.readFile(this.stagedPkgbuild, "utf8");
  }

  /**
   * Fetch and extract the sources of a staged copy so makepkg runs `pkgver()` and writes the result into it.
   * Skips `prepare()` and dependency checks.
   * @returns The PKGBUILD text with the updated `pkgver` (and `pkgrel` reset to 1 if the version changed).
   */
  public async runPkgver(): Promise<string> {
    await this.stage();
    await runChecked("makepkg", ["--nobuild", "--noprepare", "--nodeps", "--force", "--nocolor"], "Failed to run pkgver()", {
      cwd: this.stagingDir,
      env: this.env(),
    });
    return await fsp.readFile(this.stagedPkgbuild, "utf8");
  }

  /**
   * The staged PKGBUILD's text after a build, which makepkg may have changed when running `pkgver()`.
   */
  public async readStagedPkgbuild(): Promise<string | null> {
    return await fsp.readFile(this.stagedPkgbuild, "utf8").catch(() => null);
  }

  /**
   * Package files in the packages folder, newest first.
   */
  public async listPackages(): Promise<string[]> {
    const names = await fsp.readdir(this.packagesDir).catch(() => [] as string[]);
    const files = await Promise.all(names
      .filter(n => /\.pkg\.tar(\.\w+)?$/.test(n))
      .map(async n => ({ path: Path.join(this.packagesDir, n), time: (await fsp.stat(Path.join(this.packagesDir, n))).mtimeMs })));
    return files.sort((a, b) => b.time - a.time).map(f => f.path);
  }

  /**
   * Delete the whole build folder, including cached sources.
   */
  public async clean() {
    await fsp.rm(this.root, { recursive: true, force: true });
  }
}

export default Builder;
