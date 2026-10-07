import * as vscode from "vscode";
import type { PackageRegistry } from "../PackageRegistry";
import Settings from "../Settings";
import { describeAccess, describeAur } from "./presentation";

/**
 * Build and publish actions at the top of every detected PKGBUILD.
 */
export class PkgbuildCodeLens implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly registry: PackageRegistry) {
    registry.onDidChange(() => this._onDidChangeCodeLenses.fire());
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!Settings.codeLens) return [];
    const state = this.registry.get(document.uri.fsPath);
    if (!state) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    const uri = document.uri;
    const lens = (title: string, command: string, tooltip?: string) => new vscode.CodeLens(range, { title, command, tooltip, arguments: [uri] });

    const lenses = [
      lens("$(tools) Build", "pkgpub.build", "Build in an isolated folder with makepkg"),
      lens("$(desktop-download) Build & Install", "pkgpub.buildInstall", "Build with makepkg and install the result"),
      lens("$(cloud-upload) Publish", "pkgpub.publish", "Publish to the AUR"),
    ];
    if (state.pkgbuild.hasPkgverFunction) {
      lenses.push(lens("$(symbol-function) pkgver()", "pkgpub.generatePkgver", "Regenerate the pkgver() function"));
    }
    else {
      lenses.push(
        lens("$(tag) Set Version", "pkgpub.setVersion"),
        lens("$(symbol-function) Generate pkgver()", "pkgpub.generatePkgver"),
      );
    }

    const aur = describeAur(state);
    if (aur) {
      lenses.push(lens(`${aur} · ${describeAccess(state.access)}`, "pkgpub.checkAccess", "Check AUR access again"));
    }
    return lenses;
  }
}

export default PkgbuildCodeLens;
