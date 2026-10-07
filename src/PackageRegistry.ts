import * as vscode from "vscode";
import AurApi from "./AurApi";
import Log from "./Log";
import AurRepo from "./objects/AurRepo";
import Pkgbuild from "./objects/Pkgbuild";
import Settings from "./Settings";
import { run } from "./Utilities";

/**
 * A detected PKGBUILD and what pkgpub knows about its AUR counterpart.
 */
export interface PackageState {
  pkgbuild: Pkgbuild;
  /**
   * The package on the AUR. `null` when it isn't published, `undefined` when not fetched (yet).
   */
  aur: AurApi.PackageInfo | null | undefined;
  /**
   * Why fetching AUR info failed, if it did.
   */
  aurError: string | null;
  access: AurRepo.AccessResult;
  /**
   * `vercmp` of the local version against the AUR version: `1` = local is newer, `0` = same, `-1` = AUR is newer.
   * `null` when either is unknown.
   */
  comparison: number | null;
}

/**
 * Finds the PKGBUILDs in the workspace, keeps them loaded while they change, and tracks their AUR status.
 */
export class PackageRegistry implements vscode.Disposable {
  private _packages = new Map<string, PackageState>();
  private _repos: Promise<string[]> | null = null;
  private _timers = new Map<string, NodeJS.Timeout>();
  private _disposables: vscode.Disposable[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();

  /**
   * Fires whenever a package or its AUR status changes.
   */
  public readonly onDidChange = this._onDidChange.event;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher("**/PKGBUILD");
    this._disposables.push(
      watcher,
      watcher.onDidCreate(() => this.debounce("scan", () => this.scan())),
      watcher.onDidDelete(() => this.debounce("scan", () => this.scan())),
      watcher.onDidChange((uri) => this.debounce(uri.fsPath, () => this.reload(uri.fsPath))),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      this._onDidChange,
    );
  }

  /**
   * Every detected package, sorted by name.
   */
  public get packages(): PackageState[] {
    return [...this._packages.values()].sort((a, b) => a.pkgbuild.pkgbase.localeCompare(b.pkgbuild.pkgbase));
  }

  /**
   * The package of a PKGBUILD path, if detected.
   */
  public get(path: string): PackageState | undefined {
    return this._packages.get(path);
  }

  /**
   * Rescan the workspace and fetch the AUR status of every package.
   */
  public async refresh() {
    this._repos = null;
    await this.scan();
    await this.refreshRemote();
  }

  /**
   * Look for PKGBUILD files, load new ones and drop removed ones. AUR status is fetched for new packages only.
   */
  public async scan() {
    const exclude = Settings.exclude.length ? `{${Settings.exclude.join(",")}}` : null;
    const found = new Map<string, string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/PKGBUILD"), exclude);
      for (const uri of uris) found.set(uri.fsPath, folder.uri.fsPath);
    }

    for (const path of this._packages.keys()) {
      if (!found.has(path)) this._packages.delete(path);
    }
    const added: PackageState[] = [];
    for (const [path, root] of found) {
      if (this._packages.has(path)) continue;
      const state: PackageState = {
        pkgbuild: new Pkgbuild(path, root),
        aur: undefined,
        aurError: null,
        access: { access: AurRepo.Access.Unknown },
        comparison: null,
      };
      this._packages.set(path, state);
      added.push(state);
    }

    await Promise.all(added.map(s => s.pkgbuild.load()));
    this._onDidChange.fire();
    if (added.length) void this.refreshRemote(added);
  }

  /**
   * Reload one PKGBUILD after it changed on disk.
   */
  public async reload(path: string) {
    const state = this._packages.get(path);
    if (!state) return;
    const oldBase = state.pkgbuild.pkgbase;
    await state.pkgbuild.load();
    if (state.pkgbuild.pkgbase !== oldBase) {
      void this.refreshRemote([state]);
    }
    else {
      state.comparison = await this.compare(state);
    }
    this._onDidChange.fire();
  }

  /**
   * Fetch AUR info and check push access for the given packages, or for all of them.
   */
  public async refreshRemote(states?: PackageState[]) {
    states ??= this.packages;
    const loaded = states.filter(s => s.pkgbuild.srcinfo);
    if (loaded.length === 0) return;

    for (const state of loaded) state.access = { access: AurRepo.Access.Unknown };
    try {
      const names = [...new Set(loaded.flatMap(s => s.pkgbuild.srcinfo!.pkgnames))];
      const infos = await AurApi.info(names);
      for (const state of loaded) {
        state.aur = infos.find(i => i.PackageBase === state.pkgbuild.pkgbase) ?? null;
        state.aurError = null;
        state.comparison = await this.compare(state);
      }
    } catch (error) {
      Log.info(`Failed to fetch AUR info: ${error instanceof Error ? error.message : error}`);
      for (const state of loaded) state.aurError = error instanceof Error ? error.message : String(error);
    }
    this._onDidChange.fire();

    await Promise.all(loaded.map(s => this.checkAccess(s)));
    this._onDidChange.fire();
  }

  /**
   * Find out whether the configured SSH key can publish a package, and store the result on its state.
   * @param fresh Ask the AUR again instead of using the cached list of the account's packages.
   */
  public async checkAccess(state: PackageState, fresh = false): Promise<AurRepo.AccessResult> {
    if (fresh) this._repos = null;
    const pkgbase = state.pkgbuild.pkgbase;

    let repos: string[];
    try {
      this._repos ??= AurRepo.listRepos();
      repos = await this._repos;
    } catch (error) {
      this._repos = null;
      const message = error instanceof Error ? error.message : String(error);
      state.access = { access: AurRepo.isKeyRejected(error) ? AurRepo.Access.KeyRejected : AurRepo.Access.Error, message };
      return state.access;
    }

    if (repos.includes(pkgbase)) {
      state.access = { access: AurRepo.Access.Granted };
    }
    else if (state.aur === null) {
      state.access = { access: AurRepo.Access.New };
    }
    else if (state.aur) {
      // Co-maintainers can push but aren't listed by list-repos
      state.access = await AurRepo.probePushAccess(pkgbase);
    }
    else {
      state.access = { access: AurRepo.Access.Error, message: state.aurError ?? "AUR info is unavailable." };
    }
    return state.access;
  }

  /**
   * Forget the cached AUR account info, for example after the SSH key changed.
   */
  public invalidateAccess() {
    this._repos = null;
  }

  private async compare(state: PackageState): Promise<number | null> {
    const local = state.pkgbuild.version;
    const remote = state.aur?.Version;
    if (!local || !remote) return null;
    if (local === remote) return 0;
    const result = await run("vercmp", [local, remote], { quiet: true }).catch(() => null);
    const value = result ? parseInt(result.stdout.trim()) : NaN;
    return isNaN(value) ? null : Math.sign(value);
  }

  private debounce(key: string, fn: () => unknown) {
    clearTimeout(this._timers.get(key));
    this._timers.set(key, setTimeout(() => {
      this._timers.delete(key);
      fn();
    }, 300));
  }

  public dispose() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    for (const disposable of this._disposables) disposable.dispose();
  }
}

export default PackageRegistry;
