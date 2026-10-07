import * as vscode from "vscode";
import Path from "node:path";
import AurRepo from "../objects/AurRepo";
import Builder from "../objects/Builder";
import type { PackageRegistry, PackageState } from "../PackageRegistry";
import { exists } from "../Utilities";
import { applyStagedVersion } from "./version";

/**
 * Build a package with makepkg in its isolated build folder.
 * @param install Install the built package with pacman afterwards.
 */
export async function build(registry: PackageRegistry, state: PackageState, install: boolean) {
  const { pkgbuild } = state;
  if (pkgbuild.error) throw new Error(`The PKGBUILD could not be read: ${pkgbuild.error}`);

  const builder = new Builder(pkgbuild);
  const code = await builder.build(["--syncdeps", "--force", ...(install ? ["--install"] : [])]);
  if (code === undefined) return;
  if (code !== 0) {
    vscode.window.showErrorMessage(`makepkg failed for ${pkgbuild.pkgbase} with exit code ${code}. See the terminal for details.`);
    return;
  }

  // makepkg writes the result of pkgver() into the staged copy; carry it over like an in-place build would
  if (pkgbuild.hasPkgverFunction) {
    const staged = await builder.readStagedPkgbuild();
    if (staged && await applyStagedVersion(pkgbuild, staged)) await registry.reload(pkgbuild.path);
  }

  const [latest] = await builder.listPackages();
  const name = latest ? Path.basename(latest) : pkgbuild.pkgbase;
  const action = await vscode.window.showInformationMessage(install ? `Built and installed ${name}.` : `Built ${name}.`, "Open Folder");
  if (action === "Open Folder") await vscode.env.openExternal(vscode.Uri.file(builder.packagesDir));
}

/**
 * Delete a package's build folder, after asking.
 */
export async function clean(state: PackageState) {
  const builder = new Builder(state.pkgbuild);
  if (!await exists(builder.root)) {
    vscode.window.showInformationMessage(`${state.pkgbuild.pkgbase} has no build folder.`);
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete the build folder of ${state.pkgbuild.pkgbase}?`,
    { modal: true, detail: `${builder.root}\n\nThis includes downloaded sources and built packages.` },
    "Delete",
  );
  if (confirm !== "Delete") return;
  await builder.clean();
  vscode.window.showInformationMessage(`Deleted ${builder.root}.`);
}

/**
 * Open a package's build folder in the file manager.
 */
export async function openBuildFolder(state: PackageState) {
  const builder = new Builder(state.pkgbuild);
  if (!await exists(builder.root)) {
    vscode.window.showInformationMessage(`${state.pkgbuild.pkgbase} hasn't been built yet.`);
    return;
  }
  await vscode.env.openExternal(vscode.Uri.file(await exists(builder.packagesDir) ? builder.packagesDir : builder.root));
}

/**
 * Open a package's AUR checkout in the file manager.
 */
export async function openAurCheckout(state: PackageState) {
  const repo = new AurRepo(state.pkgbuild.pkgbase);
  if (!await exists(repo.dir)) {
    vscode.window.showInformationMessage(`${state.pkgbuild.pkgbase} hasn't been published from this machine yet.`);
    return;
  }
  await vscode.env.openExternal(vscode.Uri.file(repo.dir));
}
