import * as vscode from "vscode";
import fsp from "node:fs/promises";
import Path from "node:path";
import SrcInfo from "../SrcInfo";
import { exists, run } from "../Utilities";

/**
 * A PKGBUILD file found in the workspace, together with the metadata makepkg reports for it.
 */
export class Pkgbuild {
  /**
   * Matches the start of a `pkgver()` function.
   */
  public static readonly PKGVER_FUNCTION = /^[ \t]*(?:function[ \t]+)?pkgver[ \t]*\([ \t]*\)[ \t]*\{?/m;

  /**
   * Parsed output of `makepkg --printsrcinfo`. `null` until loaded, or when loading failed.
   */
  public srcinfo: SrcInfo.Data | null = null;
  /**
   * Why loading failed, if it did.
   */
  public error: string | null = null;
  /**
   * Whether the PKGBUILD defines a `pkgver()` function that computes the version during the build.
   */
  public hasPkgverFunction = false;

  constructor(
    /** Absolute path of the PKGBUILD file. */
    public readonly path: string,
    /** Root of the workspace folder that contains it. */
    public readonly workspaceRoot: string,
  ) { }

  public get uri(): vscode.Uri {
    return vscode.Uri.file(this.path);
  }

  /**
   * The folder containing the PKGBUILD, which makepkg treats as `$startdir`.
   */
  public get dir(): string {
    return Path.dirname(this.path);
  }

  /**
   * Path of the PKGBUILD relative to its workspace folder, always with forward slashes.
   */
  public get relativePath(): string {
    return Path.relative(this.workspaceRoot, this.path).split(Path.sep).join("/");
  }

  /**
   * Name of the AUR repository this PKGBUILD publishes to. Falls back to the folder name until loaded.
   */
  public get pkgbase(): string {
    return this.srcinfo?.pkgbase ?? Path.basename(this.dir);
  }

  /**
   * The full local version, `[epoch:]pkgver-pkgrel`, or `null` when not loaded.
   */
  public get version(): string | null {
    return this.srcinfo ? SrcInfo.fullVersion(this.srcinfo) : null;
  }

  /**
   * Read the PKGBUILD and ask makepkg for its metadata.
   */
  public async load(): Promise<this> {
    try {
      const text = await this.readText();
      this.hasPkgverFunction = Pkgbuild.PKGVER_FUNCTION.test(text);

      const result = await run("makepkg", ["--printsrcinfo"], { cwd: this.dir, quiet: true });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "makepkg --printsrcinfo failed.");
      }
      this.srcinfo = SrcInfo.parse(result.stdout);
      this.error = null;
    } catch (error) {
      this.srcinfo = null;
      this.error = error instanceof Error ? error.message : String(error);
    }
    return this;
  }

  public async readText(): Promise<string> {
    return await fsp.readFile(this.path, "utf8");
  }

  /**
   * Files next to the PKGBUILD that the package needs: local sources, install scripts and changelogs.
   * @throws When a referenced file is missing.
   */
  public async getLocalFiles(): Promise<Pkgbuild.LocalFile[]> {
    if (!this.srcinfo) throw new Error(`The PKGBUILD could not be read: ${this.error ?? "unknown error"}`);

    const names = new Set<string>();
    for (const source of this.srcinfo.sources) {
      if (SrcInfo.getProtocol(source) === "local") names.add(SrcInfo.getFilename(source));
    }
    for (const file of this.srcinfo.extraFiles) names.add(file);

    const files: Pkgbuild.LocalFile[] = [];
    for (const name of names) {
      const path = Path.join(this.dir, name);
      if (!await exists(path)) {
        throw new Error(`The PKGBUILD references "${name}", but it doesn't exist next to the PKGBUILD in ${this.dir}.`);
      }
      files.push({ name, path });
    }
    return files;
  }

  /**
   * Whether any source is downloaded from a URL that isn't version control, meaning its checksum matters.
   */
  public hasChecksummedSources(): boolean {
    return this.srcinfo?.sources.some(s => !SrcInfo.isVcs(s)) ?? false;
  }

  /**
   * Replace the PKGBUILD's content through the editor, so the change can be undone, and save it.
   * Only the part that changed is replaced. Returns whether anything changed.
   */
  public async writeText(text: string): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(this.uri);
    const current = doc.getText();
    if (current === text) return false;

    let start = 0;
    while (start < current.length && start < text.length && current[start] === text[start]) start++;
    let end = 0;
    while (
      end < current.length - start && end < text.length - start
      && current[current.length - 1 - end] === text[text.length - 1 - end]
    ) end++;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.uri,
      new vscode.Range(doc.positionAt(start), doc.positionAt(current.length - end)),
      text.slice(start, text.length - end),
    );
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    return true;
  }

  /**
   * Save the PKGBUILD if it's open with unsaved changes.
   */
  public async saveIfDirty() {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.path);
    if (doc?.isDirty) await doc.save();
  }

  /**
   * Read a plain variable assignment like `pkgver=1.2.0` from PKGBUILD text.
   */
  public static getVariable(text: string, name: string): string | null {
    const match = text.match(new RegExp(`^${name}=(['"]?)([^'"\\s#]*)\\1`, "m"));
    return match ? match[2] : null;
  }

  /**
   * Set a plain variable assignment in PKGBUILD text, keeping its quotes and any trailing comment.
   * @throws When the variable isn't assigned in the text.
   */
  public static setVariable(text: string, name: string, value: string): string {
    const pattern = new RegExp(`^${name}=(['"]?)([^'"\\s#]*)\\1`, "m");
    if (!pattern.test(text)) throw new Error(`The PKGBUILD doesn't assign \`${name}\`. Add a \`${name}=\` line first.`);
    return text.replace(pattern, (_, quote: string) => `${name}=${quote}${value}${quote}`);
  }

  /**
   * The indentation the PKGBUILD uses inside functions. Default is two spaces.
   */
  public static detectIndent(text: string): string {
    const match = text.match(/\(\)\s*\{[^\n]*\n([ \t]+)\S/);
    return match ? match[1] : "  ";
  }

  /**
   * Insert or replace the `pkgver()` function in PKGBUILD text.
   * @param srcDir Folder inside `$srcdir` to run the function in.
   * @param body Lines of the function after the `cd`, without indentation.
   */
  public static setPkgverFunction(text: string, srcDir: string, body: string[]): string {
    const indent = Pkgbuild.detectIndent(text);
    const fn = [
      "pkgver() {",
      `${indent}cd "$srcdir/${srcDir}"`,
      ...body.map(line => `${indent}${line}`),
      "}",
    ].join("\n");

    const existing = text.match(Pkgbuild.PKGVER_FUNCTION);
    if (existing?.index !== undefined) {
      // The function ends at the first closing brace in column 0
      const close = text.slice(existing.index).match(/^\}[ \t]*$/m);
      if (close?.index === undefined) throw new Error("Couldn't find the end of the existing pkgver() function. Make sure its closing `}` is at the start of a line.");
      const end = existing.index + close.index + close[0].length;
      return text.slice(0, existing.index) + fn + text.slice(end);
    }

    // pkgver() conventionally goes before the other functions
    const next = text.match(/^(?:function[ \t]+)?(?:prepare|build|check|package\w*)[ \t]*\(\)/m);
    if (next?.index !== undefined) {
      return `${text.slice(0, next.index)}${fn}\n\n${text.slice(next.index)}`;
    }
    return `${text.replace(/\n*$/, "")}\n\n${fn}\n`;
  }

  /**
   * Add a package to `makedepends` in PKGBUILD text, creating the array if needed. Does nothing if it's
   * already there.
   */
  public static addMakedepend(text: string, dependency: string): string {
    const array = text.match(/^makedepends=\(([^)]*)\)/m);
    if (array) {
      if (new RegExp(`(^|[\\s'"(])${dependency}(['"\\s)<>=]|$)`).test(array[1])) return text;
      const quote = array[1].includes("\"") && !array[1].includes("'") ? "\"" : "'";
      const items = array[1].trim();
      const replacement = `makedepends=(${items ? `${items} ` : ""}${quote}${dependency}${quote})`;
      return text.replace(array[0], replacement);
    }

    const anchor = text.match(/^(?:depends|source)=/m);
    const line = `makedepends=('${dependency}')\n`;
    if (anchor?.index === undefined) return `${line}${text}`;
    // Put it after depends=(...), or before source=(...)
    if (anchor[0].startsWith("depends")) {
      const close = text.indexOf(")", anchor.index);
      const lineEnd = text.indexOf("\n", close);
      const at = lineEnd === -1 ? text.length : lineEnd + 1;
      return text.slice(0, at) + line + text.slice(at);
    }
    return text.slice(0, anchor.index) + line + text.slice(anchor.index);
  }
}

export namespace Pkgbuild {
  export interface LocalFile {
    /**
     * Name of the file next to the PKGBUILD.
     */
    name: string;
    /**
     * Absolute path of the file.
     */
    path: string;
  }
}

export default Pkgbuild;
