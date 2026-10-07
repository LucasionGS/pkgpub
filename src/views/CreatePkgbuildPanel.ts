import * as vscode from "vscode";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import Path from "node:path";
import Log from "../Log";
import Pkgbuild from "../objects/Pkgbuild";
import type { PackageRegistry } from "../PackageRegistry";
import PkgbuildTemplate from "../PkgbuildTemplate";
import ProjectConfig from "../ProjectConfig";
import ProjectInfo from "../ProjectInfo";
import { exists, run } from "../Utilities";
import VersionSource from "../VersionSource";

/**
 * A form for creating a new PKGBUILD, pre-filled from the project, with a live preview.
 */
export class CreatePkgbuildPanel {
  public static readonly VIEW_TYPE = "pkgpub.createPkgbuild";
  private static _current: CreatePkgbuildPanel | null = null;

  private _values: CreatePkgbuildPanel.FormValues;
  private _edited = new Set<string>();
  private _info!: ProjectInfo.Data;
  private _gitRoot: string | null = null;
  /**
   * The project folder's path inside its git repository, like `client/`, which is where its files end up in a git
   * source.
   */
  private _gitPrefix = "";
  private _pkgverCache = new Map<string, string>();
  /**
   * Version files in the project folder, like `package.json`.
   */
  private _versionFiles: string[] = [];
  private _disposables: vscode.Disposable[] = [];

  /**
   * Open the form, or bring the open one to the front.
   * @param folder Project folder to create the PKGBUILD in. Default is the first workspace folder.
   */
  public static async show(extensionUri: vscode.Uri, registry: PackageRegistry, folder?: vscode.Uri) {
    const roots = vscode.workspace.workspaceFolders ?? [];
    if (roots.length === 0) throw new Error("Open a folder first. The PKGBUILD is created inside the workspace.");

    if (CreatePkgbuildPanel._current) {
      CreatePkgbuildPanel._current._panel.reveal();
      return;
    }

    const root = (folder && vscode.workspace.getWorkspaceFolder(folder)) ?? roots[0];
    const projectDir = folder?.fsPath ?? root.uri.fsPath;
    const panel = vscode.window.createWebviewPanel(CreatePkgbuildPanel.VIEW_TYPE, "Create PKGBUILD", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    CreatePkgbuildPanel._current = new CreatePkgbuildPanel(panel, extensionUri, registry, root.uri.fsPath, projectDir);
  }

  private constructor(
    private readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _registry: PackageRegistry,
    root: string,
    private _projectDir: string,
  ) {
    this._values = {
      root,
      folder: Path.relative(root, _projectDir).split(Path.sep).join("/"),
      kind: PkgbuildTemplate.SourceKind.Release,
      pkgname: "", pkgver: "", pkgrel: "", pkgdesc: "", url: "", license: "", maintainer: "", arch: "",
      buildSystem: PkgbuildTemplate.BuildSystem.Custom, executable: "", entry: "", depends: "", makedepends: "",
      source: "", srcDir: "", pkgverSource: "", installLicense: false,
    };

    _panel.iconPath = vscode.Uri.joinPath(_extensionUri, "media", "pkgpub.svg");
    _panel.webview.html = this.html();
    this._disposables.push(
      _panel.onDidDispose(() => this.dispose()),
      _panel.webview.onDidReceiveMessage((message: CreatePkgbuildPanel.Message) => this.handle(message)),
    );
  }

  private async handle(message: CreatePkgbuildPanel.Message) {
    try {
      if (message.type === "ready") {
        await this.detect();
        await this.derive();
        this.post({ type: "init", options: this.options(), hints: this._info.hints, licenseFile: this._info.licenseFile ?? null });
        await this.postUpdate();
      }
      else if (message.type === "change" || message.type === "create") {
        const rootChanged = message.values.root !== this._values.root;
        this._values = message.values;
        this._edited = new Set(message.edited);
        if (rootChanged) {
          this._projectDir = this._values.root;
          this._values.folder = "";
          await this.detect();
          this.post({ type: "init", options: this.options(), hints: this._info.hints, licenseFile: this._info.licenseFile ?? null });
        }
        await this.derive();
        const errors = await this.postUpdate(message.seq);
        if (message.type === "create" && errors.length === 0) await this.create();
      }
      else if (message.type === "reset") {
        this._edited.clear();
        await this.derive();
        await this.postUpdate(message.seq);
      }
      else if (message.type === "cancel") {
        this._panel.dispose();
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      Log.info(`Error: ${text}`);
      vscode.window.showErrorMessage(text);
    }
  }

  /**
   * Read the project and find its git repository.
   */
  private async detect() {
    this._info = await ProjectInfo.detect(this._projectDir);
    await ProjectInfo.enrichFromGitHub(this._info);
    const git = (...args: string[]) => run("git", args, { cwd: this._projectDir, quiet: true }).catch(() => null);
    const top = await git("rev-parse", "--show-toplevel");
    this._gitRoot = top?.code === 0 ? top.stdout.trim() : null;
    const prefix = await git("rev-parse", "--show-prefix");
    this._gitPrefix = prefix?.code === 0 ? prefix.stdout.trim() : "";
    this._pkgverCache.clear();
    this._versionFiles = [];
    for (const type of Object.keys(VersionSource.FILE_TYPES)) {
      if (await exists(Path.join(this._projectDir, type))) this._versionFiles.push(type);
    }
  }

  /**
   * Fill every field the user hasn't changed from the project info and the other fields.
   */
  private async derive() {
    const v = this._values;
    const info = this._info;
    const auto = (field: keyof CreatePkgbuildPanel.FormValues) => !this._edited.has(field);
    const isGit = v.kind === PkgbuildTemplate.SourceKind.Git;

    if (auto("pkgdesc")) v.pkgdesc = info.description ?? "";
    if (auto("url")) v.url = info.url ?? "";
    if (auto("license")) v.license = info.license ?? "";
    if (auto("maintainer")) v.maintainer = info.maintainer ?? "";
    if (auto("buildSystem")) v.buildSystem = info.buildSystem;
    if (auto("installLicense")) v.installLicense = !!info.licenseFile;
    if (auto("pkgrel")) v.pkgrel = "1";

    const base = (info.name ?? "").replace(/-git$/, "");
    if (auto("pkgname")) v.pkgname = isGit ? `${base}-git` : base;
    if (auto("executable")) v.executable = info.executable ?? base;
    if (auto("entry")) v.entry = v.buildSystem === info.buildSystem ? info.entry ?? "" : "";

    const template = PkgbuildTemplate.BUILD_SYSTEMS[v.buildSystem] ?? PkgbuildTemplate.BUILD_SYSTEMS.custom;
    const context: Partial<PkgbuildTemplate.Options> = { kind: v.kind, isElectron: info.isElectron, pythonBackend: info.pythonBackend };
    if (auto("arch")) v.arch = template.arch(context).join(" ");
    if (auto("depends")) v.depends = template.depends(context).join(" ");
    if (auto("makedepends")) v.makedepends = [...isGit ? ["git"] : [], ...template.makedepends(context)].join(" ");
    // Without a known repository, the URL field is assumed to be the repository
    const repository = info.repository ?? v.url;
    if (auto("source")) v.source = PkgbuildTemplate.defaultSource(v.kind, v.url, repository, info.tagPrefix);
    if (auto("srcDir")) v.srcDir = PkgbuildTemplate.defaultSrcDir(v.kind, repository, v.pkgname);

    const sources = this.pkgverSources();
    if (auto("pkgverSource") || !sources.some(s => s.value === v.pkgverSource)) {
      v.pkgverSource = info.hasTags ? "git-tag" : sources.find(s => VersionSource.FILE_TYPES[s.value])?.value ?? "git-revision";
    }
    if (auto("pkgver")) {
      v.pkgver = isGit ? await this.localPkgver(v.pkgverSource) : VersionSource.toPkgver(info.version ?? "0.1.0");
    }
  }

  /**
   * Version sources a generated `pkgver()` can use: git, plus version files the project has.
   */
  private pkgverSources(): { value: string; label: string }[] {
    const sources = [
      { value: "git-tag", label: "Latest git tag (1.2.0.r3.gabc1234)" },
      { value: "git-revision", label: "Git revision count (r42.abc1234)" },
    ];
    for (const type of this._versionFiles) {
      sources.push({ value: type, label: `${type} version + git revision (1.2.0.r42.abc1234)` });
    }
    return sources;
  }

  private pkgverConfig(key: string): VersionSource.Config {
    if (VersionSource.FILE_TYPES[key]) {
      return { type: key as VersionSource.Type, path: `${this._gitPrefix}${key}`, appendRevision: true, srcDir: this._values.srcDir };
    }
    return { type: key as VersionSource.Type, srcDir: this._values.srcDir };
  }

  /**
   * What the generated `pkgver()` prints for the local repository, so the PKGBUILD starts with a real version.
   */
  private async localPkgver(key: string): Promise<string> {
    const cached = this._pkgverCache.get(key);
    if (cached) return cached;
    let version = "0";
    if (this._gitRoot) {
      const body = VersionSource.pkgverBody(this.pkgverConfig(key)).join("\n");
      const result = await run("bash", ["-c", `set -o pipefail\n${body}`], { cwd: this._gitRoot, quiet: true }).catch(() => null);
      const output = result?.code === 0 ? result.stdout.trim() : "";
      if (output && !/[-:/\s]/.test(output)) version = output;
    }
    this._pkgverCache.set(key, version);
    return version;
  }

  private toOptions(): PkgbuildTemplate.Options {
    const v = this._values;
    const list = (text: string) => text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    return {
      kind: v.kind,
      maintainer: v.maintainer,
      pkgname: v.pkgname.trim(),
      pkgver: v.pkgver.trim(),
      pkgrel: v.pkgrel.trim(),
      pkgdesc: v.pkgdesc,
      url: v.url,
      license: v.license,
      arch: list(v.arch),
      depends: list(v.depends),
      makedepends: list(v.makedepends),
      buildSystem: v.buildSystem,
      executable: v.executable.trim() || v.pkgname.trim(),
      entry: v.entry.trim(),
      source: v.source,
      srcDir: v.srcDir.trim() || "$pkgname-$pkgver",
      pkgverSource: v.kind === PkgbuildTemplate.SourceKind.Git ? this.pkgverConfig(v.pkgverSource) : null,
      licenseFile: v.installLicense ? this._info.licenseFile ?? null : null,
      hasBuildScript: this._info.hasBuildScript,
      isElectron: this._info.isElectron,
      pythonBackend: this._info.pythonBackend,
    };
  }

  /**
   * Where the PKGBUILD will be written.
   */
  private target(): string {
    return Path.join(this._values.root, this._values.folder.trim(), "PKGBUILD");
  }

  /**
   * Send the current values, preview and validation errors to the form.
   */
  private async postUpdate(seq?: number): Promise<string[]> {
    const options = this.toOptions();
    const errors = PkgbuildTemplate.validate(options);
    const target = this.target();
    const relative = Path.relative(this._values.root, target);
    if (relative.startsWith("..") || Path.isAbsolute(this._values.folder.trim())) {
      errors.unshift("The folder must be inside the workspace folder.");
    }
    else if (await exists(target)) {
      errors.unshift(`A PKGBUILD already exists at ${relative}.`);
    }
    this.post({
      type: "update",
      values: this._values,
      edited: [...this._edited],
      preview: PkgbuildTemplate.render(options),
      errors,
      target: relative,
      seq,
    });
    return errors;
  }

  /**
   * Write the PKGBUILD, remember its version source and open it.
   */
  private async create() {
    const options = this.toOptions();
    const target = this.target();
    await fsp.mkdir(Path.dirname(target), { recursive: true });
    await fsp.writeFile(target, PkgbuildTemplate.render(options), { flag: "wx" });

    const pkgbuild = new Pkgbuild(target, this._values.root);
    let versionSource: VersionSource.Config | null = options.pkgverSource;
    if (!versionSource) {
      const hint = this._info.hints.version;
      if (hint && VersionSource.FILE_TYPES[hint]) {
        const path = Path.relative(this._values.root, Path.join(this._projectDir, hint)).split(Path.sep).join("/");
        versionSource = { type: hint as VersionSource.Type, path };
      }
      else if (hint === "git tag") {
        versionSource = { type: "git-tag" };
      }
    }
    if (versionSource) await ProjectConfig.updatePackage(pkgbuild, { versionSource });

    this._panel.dispose();
    await vscode.window.showTextDocument(pkgbuild.uri);
    await this._registry.scan();

    const action = await vscode.window.showInformationMessage(
      `Created ${pkgbuild.relativePath}. Check the TODO comments and the build steps, then try a build.`,
      "Build",
    );
    if (action === "Build") await vscode.commands.executeCommand("pkgpub.build", pkgbuild.uri);
  }

  private options() {
    return {
      roots: (vscode.workspace.workspaceFolders ?? []).map(f => ({ value: f.uri.fsPath, label: f.name })),
      buildSystems: Object.entries(PkgbuildTemplate.BUILD_SYSTEMS).map(([value, t]) => ({ value, label: t.label })),
      pkgverSources: this.pkgverSources(),
    };
  }

  private post(message: object) {
    void this._panel.webview.postMessage(message);
  }

  private html(): string {
    const webview = this._panel.webview;
    const nonce = crypto.randomBytes(16).toString("base64");
    const media = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", name));
    const field = (name: string, label: string, input: string, extra = "") => `
      <label class="field ${extra}" data-field="${name}">
        <span class="field__label">${label}<span class="field__hint" data-hint="${name}"></span></span>
        ${input}
      </label>`;
    const text = (name: string, placeholder = "") => `<input type="text" name="${name}" placeholder="${placeholder}" spellcheck="false">`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media("createPkgbuild.css")}">
  <title>Create PKGBUILD</title>
</head>
<body>
  <div class="layout">
    <form id="form" class="form" autocomplete="off">
      <header class="form__header">
        <h1>Create PKGBUILD</h1>
        <p class="muted">Fields are filled in from your project. Change anything; clearing a field brings the detected value back.</p>
      </header>

      <section>
        <h2>Location</h2>
        ${field("root", "Workspace folder", `<select name="root"></select>`, "multi-root-only")}
        ${field("folder", "Folder", text("folder", "workspace folder root"))}
      </section>

      <section>
        <h2>Package</h2>
        <div class="field" data-field="kind">
          <span class="field__label">Builds from</span>
          <div class="segmented">
            <label><input type="radio" name="kind" value="release"><span>Release tarball</span></label>
            <label><input type="radio" name="kind" value="git"><span>Latest git commit (-git)</span></label>
          </div>
        </div>
        <div class="row">
          ${field("pkgname", "Name", text("pkgname"), "grow")}
          ${field("pkgver", "Version", text("pkgver"))}
          ${field("pkgrel", "Release", text("pkgrel"), "narrow")}
        </div>
        <p class="note git-only">The version is computed by the generated pkgver() during the build. This is what it prints right now.</p>
        ${field("pkgdesc", "Description", text("pkgdesc"))}
        ${field("url", "URL", text("url", "https://github.com/user/project"))}
        <div class="row">
          ${field("license", "License (SPDX)", text("license", "MIT"), "grow")}
          ${field("arch", "Architectures", text("arch", "x86_64 aarch64"), "grow")}
        </div>
        ${field("maintainer", "Maintainer", text("maintainer", "Name <email>"))}
      </section>

      <section>
        <h2>Source</h2>
        ${field("source", "Source", text("source"))}
        ${field("srcDir", "Extracted folder", text("srcDir"))}
        ${field("pkgverSource", "pkgver() reads the version from", `<select name="pkgverSource"></select>`, "git-only")}
      </section>

      <section>
        <h2>Build</h2>
        <div class="row">
          ${field("buildSystem", "Build system", `<select name="buildSystem"></select>`, "grow")}
          ${field("executable", "Command name", text("executable"), "grow")}
        </div>
        ${field("entry", "Entry point", text("entry", "for example src/main.ts, ./cmd/tool or bin/cli.js"))}
        ${field("depends", "Dependencies", text("depends", "space separated"))}
        ${field("makedepends", "Build dependencies", text("makedepends", "space separated"))}
        <label class="check license-only"><input type="checkbox" name="installLicense"> Install <code id="license-file"></code> to /usr/share/licenses</label>
      </section>
    </form>

    <aside class="preview">
      <div class="preview__header">
        <span>Preview: <code id="target"></code></span>
      </div>
      <pre id="preview" class="preview__code"></pre>
      <ul id="errors" class="errors"></ul>
      <div class="actions">
        <button type="button" id="create" class="button">Create PKGBUILD</button>
        <button type="button" id="reset" class="button button--secondary">Reset to detected</button>
        <button type="button" id="cancel" class="button button--secondary">Cancel</button>
      </div>
    </aside>
  </div>
  <script nonce="${nonce}" src="${media("createPkgbuild.js")}"></script>
</body>
</html>`;
  }

  private dispose() {
    CreatePkgbuildPanel._current = null;
    for (const disposable of this._disposables) disposable.dispose();
  }
}

export namespace CreatePkgbuildPanel {
  export interface FormValues {
    root: string;
    folder: string;
    kind: PkgbuildTemplate.SourceKind;
    pkgname: string;
    pkgver: string;
    pkgrel: string;
    pkgdesc: string;
    url: string;
    license: string;
    maintainer: string;
    arch: string;
    buildSystem: PkgbuildTemplate.BuildSystem;
    executable: string;
    entry: string;
    depends: string;
    makedepends: string;
    source: string;
    srcDir: string;
    pkgverSource: string;
    installLicense: boolean;
  }

  export type Message =
    | { type: "ready" }
    | { type: "change" | "create"; values: FormValues; edited: string[]; seq: number }
    | { type: "reset"; seq: number }
    | { type: "cancel" };
}

export default CreatePkgbuildPanel;
