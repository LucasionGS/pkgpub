import * as vscode from "vscode";
import AurRepo from "../objects/AurRepo";

/**
 * Serves files of an AUR checkout for the publish diff, either as the AUR has them (`?HEAD`) or as they're
 * about to be pushed (`?WORK`). Missing files are empty, so added and deleted files diff cleanly.
 */
export class AurDiffProvider implements vscode.TextDocumentContentProvider {
  public static readonly SCHEME = "pkgpub-aur";

  /**
   * URI of a file in a package's AUR checkout.
   * @param side `HEAD` for the published version, `WORK` for the staged one.
   * @param stamp Makes the URI unique per publish, so VS Code doesn't show a cached document from a previous one.
   */
  public static uri(pkgbase: string, name: string, side: "HEAD" | "WORK", stamp: number): vscode.Uri {
    return vscode.Uri.from({ scheme: AurDiffProvider.SCHEME, path: `/${pkgbase}/${name}`, query: `${side}-${stamp}` });
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [, pkgbase, ...rest] = uri.path.split("/");
    const repo = new AurRepo(pkgbase);
    const name = rest.join("/");
    const content = uri.query.startsWith("HEAD") ? await repo.headContent(name) : await repo.workingContent(name);
    return content ?? "";
  }

  /**
   * Open a multi-file diff of the staged changes in a package's AUR checkout.
   */
  public static async show(pkgbase: string, changes: AurRepo.Change[]) {
    const stamp = Date.now();
    const resources = changes.map(change => [
      AurDiffProvider.uri(pkgbase, change.name, "WORK", stamp),
      AurDiffProvider.uri(pkgbase, change.name, "HEAD", stamp),
      AurDiffProvider.uri(pkgbase, change.name, "WORK", stamp),
    ]);
    await vscode.commands.executeCommand("vscode.changes", `AUR: ${pkgbase} (pending push)`, resources);
  }
}

export default AurDiffProvider;
