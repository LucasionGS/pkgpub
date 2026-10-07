import fsp from "node:fs/promises";
import Path from "node:path";
import Settings from "../Settings";
import { exists, run, runChecked, RunResult } from "../Utilities";
import type Pkgbuild from "./Pkgbuild";

/**
 * A package's AUR git repository, checked out under the pkgpub data folder and managed entirely by pkgpub.
 */
export class AurRepo {
  /**
   * Package base names the AUR accepts.
   */
  public static readonly NAME_PATTERN = /^[a-z0-9@._+-]+$/;

  constructor(public readonly pkgbase: string) {
    if (!AurRepo.NAME_PATTERN.test(pkgbase)) {
      throw new Error(`"${pkgbase}" is not a valid AUR package name. Must match the regex: ${AurRepo.NAME_PATTERN.source}`);
    }
  }

  /**
   * Folder of the local checkout.
   */
  public get dir(): string {
    return Settings.aurDirectory(this.pkgbase);
  }

  /**
   * SSH URL of the AUR repository.
   */
  public get remote(): string {
    return `ssh://aur@${Settings.AUR_HOST}/${this.pkgbase}.git`;
  }

  private git(args: string[]): Promise<RunResult> {
    return run("git", ["-C", this.dir, ...args], {
      env: { GIT_SSH_COMMAND: Settings.gitSshCommand(), GIT_TERMINAL_PROMPT: "0" },
    });
  }

  private gitChecked(args: string[], failMessage: string): Promise<RunResult> {
    return runChecked("git", ["-C", this.dir, ...args], failMessage, {
      env: { GIT_SSH_COMMAND: Settings.gitSshCommand(), GIT_TERMINAL_PROMPT: "0" },
    });
  }

  /**
   * Clone the AUR repository, or bring an existing checkout back to exactly what the AUR has.
   * A package that doesn't exist yet gives an empty checkout; the first push creates it.
   */
  public async sync() {
    if (await exists(Path.join(this.dir, ".git"))) {
      await this.gitChecked(["remote", "set-url", "origin", this.remote], "Failed to update the AUR checkout's remote");
      await this.gitChecked(["fetch", "--prune", "origin"], `Failed to fetch ${this.remote}`);
      const hasMaster = (await this.git(["rev-parse", "-q", "--verify", "origin/master"])).code === 0;
      if (hasMaster) {
        await this.gitChecked(["reset", "-q", "--hard", "origin/master"], "Failed to reset the AUR checkout");
        await this.gitChecked(["clean", "-fdxq"], "Failed to clean the AUR checkout");
        return;
      }
      // Still empty on the AUR, so leftover local commits from a failed first push go away with a fresh clone
      await fsp.rm(this.dir, { recursive: true, force: true });
    }

    await fsp.mkdir(Path.dirname(this.dir), { recursive: true });
    await runChecked("git", ["-c", "init.defaultBranch=master", "clone", this.remote, this.dir], `Failed to clone ${this.remote}`, {
      env: { GIT_SSH_COMMAND: Settings.gitSshCommand(), GIT_TERMINAL_PROMPT: "0" },
    });
  }

  /**
   * Replace the checkout's content with the given files and `.SRCINFO`, and stage everything.
   * Files the AUR has that aren't part of the package anymore are removed.
   * @returns The staged changes, empty when the AUR is already up to date.
   */
  public async stage(files: Pkgbuild.LocalFile[], srcinfo: string): Promise<AurRepo.Change[]> {
    for (const file of files) {
      if (file.name.includes("/")) {
        throw new Error(`"${file.name}" is in a subfolder, but AUR repositories can't contain subfolders. Move it next to the PKGBUILD.`);
      }
    }

    const wanted = new Set([".SRCINFO", ...files.map(f => f.name)]);
    const tracked = (await this.git(["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
    for (const name of tracked) {
      if (!wanted.has(name)) await fsp.rm(Path.join(this.dir, name), { force: true });
    }
    for (const file of files) {
      await fsp.copyFile(file.path, Path.join(this.dir, file.name));
    }
    await fsp.writeFile(Path.join(this.dir, ".SRCINFO"), srcinfo);

    await this.gitChecked(["add", "-A"], "Failed to stage files in the AUR checkout");
    const status = await this.gitChecked(["status", "--porcelain=v1", "--no-renames", "-z"], "Failed to read the AUR checkout's status");

    // Example: "M  PKGBUILD\0A  fix.patch\0"
    return status.stdout.split("\0").filter(Boolean).map(entry => ({
      status: entry[0] as AurRepo.Change["status"],
      name: entry.slice(3),
    }));
  }

  /**
   * Content of a file in the last commit, or `null` if it isn't there.
   */
  public async headContent(name: string): Promise<string | null> {
    const result = await run("git", ["-C", this.dir, "show", `HEAD:${name}`], { quiet: true });
    return result.code === 0 ? result.stdout : null;
  }

  /**
   * Content of a file in the working tree, or `null` if it isn't there.
   */
  public async workingContent(name: string): Promise<string | null> {
    return await fsp.readFile(Path.join(this.dir, name), "utf8").catch(() => null);
  }

  public async commit(message: string) {
    const result = await this.git(["commit", "-q", "-m", message]);
    if (result.code !== 0) {
      throw new Error(`Failed to commit to the AUR checkout. If git says it doesn't know who you are, set \`user.name\` and \`user.email\` with \`git config --global\`. ${result.stderr.trim()}`);
    }
  }

  /**
   * Push the checkout's commits to the AUR.
   * @throws With the AUR's own explanation when it rejects the push.
   */
  public async push() {
    const result = await this.git(["push", "origin", "HEAD:master"]);
    if (result.code !== 0) {
      // The AUR explains rejections in "remote: error: ..." lines
      const remote = result.stderr.split("\n").filter(l => /^remote: (error|fatal)/.test(l)).map(l => l.replace(/^remote:\s*/, ""));
      throw new Error(`The AUR rejected the push: ${remote.join(" ") || result.stderr.trim()}`);
    }
  }

  /**
   * Undo staged and uncommitted changes, so the checkout matches its last commit again.
   */
  public async discard() {
    if (!await exists(Path.join(this.dir, ".git"))) return;
    await this.git(["reset", "-q", "--hard"]);
    await this.git(["clean", "-fdxq"]);
  }

  /**
   * Arguments for running a command on the AUR's SSH interface without any interactive prompts.
   */
  private static sshArgs(command: string): string[] {
    return [
      ...Settings.sshKeyArgs(),
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-o", "StrictHostKeyChecking=accept-new",
      `aur@${Settings.AUR_HOST}`,
      command,
    ];
  }

  /**
   * List the package bases the SSH key's account maintains.
   * @throws When the AUR can't be reached or rejects the key. Check `AurRepo.isKeyRejected(error)`.
   */
  public static async listRepos(): Promise<string[]> {
    const result = await run("ssh", AurRepo.sshArgs("list-repos"), { quiet: true });
    if (result.code !== 0) throw AurRepo.sshError(result);

    // Example (a * marks packages flagged out of date):
    //  toxen3
    // *podium
    return result.stdout.split("\n").map(l => l.slice(1).trim()).filter(Boolean);
  }

  /**
   * Find out whether the SSH key can push to an existing package. Works for co-maintainers too, which
   * `list-repos` doesn't include.
   */
  public static async probePushAccess(pkgbase: string): Promise<AurRepo.AccessResult> {
    if (!AurRepo.NAME_PATTERN.test(pkgbase)) return { access: AurRepo.Access.Error, message: `"${pkgbase}" is not a valid AUR package name.` };

    // The AUR checks write access before git-receive-pack starts. With stdin closed it advertises the refs and
    // exits without changing anything.
    const result = await run("ssh", AurRepo.sshArgs(`git-receive-pack '/${pkgbase}.git'`), { quiet: true });
    const denied = result.stderr.match(/permission denied: (\S+)/);
    if (denied) {
      return { access: AurRepo.Access.Denied, user: denied[1], message: `The AUR account "${denied[1]}" can't push to ${pkgbase}.` };
    }
    if (/report-status|refs\/heads\//.test(result.stdout)) return { access: AurRepo.Access.Granted };
    if (AurRepo.isKeyRejectedText(result.stderr)) {
      return { access: AurRepo.Access.KeyRejected, message: "The AUR rejected the SSH key. Make sure its public key is added to your AUR account." };
    }
    return { access: AurRepo.Access.Error, message: result.stderr.trim() || "Unknown error while checking access." };
  }

  /**
   * Whether an error from `listRepos()` means the AUR didn't accept the SSH key.
   */
  public static isKeyRejected(error: unknown): boolean {
    return error instanceof Error && AurRepo.isKeyRejectedText(error.message);
  }

  private static isKeyRejectedText(text: string) {
    return /Permission denied \(publickey|no such identity|Load key .*: invalid format|Too many authentication failures/i.test(text);
  }

  private static sshError(result: RunResult): Error {
    const text = result.stderr.trim();
    if (AurRepo.isKeyRejectedText(text)) {
      const key = Settings.sshKey;
      return new Error(`The AUR rejected the SSH key${key ? ` ${key}` : ""} (Permission denied (publickey)). Add its public key to your AUR account under "My Account", or select another key.`);
    }
    return new Error(`Could not reach the AUR over SSH: ${text || `ssh exited with code ${result.code}`}`);
  }
}

export namespace AurRepo {
  export enum Access {
    /** Not checked yet. */
    Unknown = "unknown",
    /** The key can push to the package. */
    Granted = "granted",
    /** The package exists, and the key's account isn't a maintainer or co-maintainer. */
    Denied = "denied",
    /** The package doesn't exist yet, and the first push will create it. */
    New = "new",
    /** The AUR didn't accept the SSH key. */
    KeyRejected = "key-rejected",
    /** The check itself failed, for example without a network connection. */
    Error = "error",
  }

  export interface AccessResult {
    access: Access;
    /**
     * AUR account name, when the AUR revealed it.
     */
    user?: string;
    message?: string;
  }

  export interface Change {
    /**
     * Git status letter: `A`dded, `M`odified or `D`eleted.
     */
    status: "A" | "M" | "D";
    name: string;
  }
}

export default AurRepo;
