import * as vscode from "vscode";
import Path from "node:path";
import { expandHome, shellQuote } from "./Utilities";

/**
 * Typed access to the `pkgpub.*` VS Code settings, and the paths derived from them.
 */
export class Settings {
  private constructor() { }

  public static readonly AUR_HOST = "aur.archlinux.org";

  private static get config() {
    return vscode.workspace.getConfiguration("pkgpub");
  }

  /**
   * Absolute path of the configured AUR SSH key, or `null` to use the normal SSH setup.
   */
  public static get sshKey(): string | null {
    const key = this.config.get<string>("sshKey", "").trim();
    return key ? expandHome(key) : null;
  }

  /**
   * Store the AUR SSH key globally. `null` clears it.
   */
  public static async setSshKey(path: string | null) {
    await this.config.update("sshKey", path ?? "", vscode.ConfigurationTarget.Global);
  }

  /**
   * Root of everything pkgpub writes to disk. Default is `~/.pkgpub`.
   */
  public static get dataDirectory(): string {
    return expandHome(this.config.get<string>("dataDirectory", "~/.pkgpub") || "~/.pkgpub");
  }

  /**
   * Git checkout of a package's AUR repository.
   */
  public static aurDirectory(pkgbase: string): string {
    return Path.join(this.dataDirectory, "aur", pkgbase);
  }

  /**
   * Isolated build folder of a package.
   */
  public static buildDirectory(pkgbase: string): string {
    return Path.join(this.dataDirectory, "build", pkgbase);
  }

  public static get exclude(): string[] {
    return this.config.get<string[]>("exclude", []);
  }

  public static get makepkgArgs(): string[] {
    return this.config.get<string[]>("makepkgArgs", []);
  }

  public static get updateChecksums(): boolean {
    return this.config.get<boolean>("updateChecksums", true);
  }

  public static get commitMessage(): string {
    return this.config.get<string>("commitMessage", "Update to {version}") || "Update to {version}";
  }

  public static get codeLens(): boolean {
    return this.config.get<boolean>("codeLens", true);
  }

  /**
   * SSH options that select the configured key. Empty when no key is set.
   */
  public static sshKeyArgs(): string[] {
    const key = this.sshKey;
    return key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : [];
  }

  /**
   * Value for `GIT_SSH_COMMAND`, so only git's AUR traffic uses the AUR key.
   */
  public static gitSshCommand(): string {
    const key = this.sshKey;
    return key ? `ssh -i ${shellQuote(key)} -o IdentitiesOnly=yes` : "ssh";
  }
}

export default Settings;
