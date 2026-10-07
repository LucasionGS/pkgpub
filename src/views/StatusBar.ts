import * as vscode from "vscode";
import type { PackageRegistry } from "../PackageRegistry";
import { describeAur, packageTooltip } from "./presentation";

/**
 * Status bar item showing the package of the PKGBUILD in the active editor. Clicking it opens the package actions.
 */
export class StatusBar implements vscode.Disposable {
  private _item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly registry: PackageRegistry) {
    this._item.name = "pkgpub";
    this._item.command = "pkgpub.actions";
    this._disposables.push(
      this._item,
      registry.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    );
    this.update();
  }

  public update() {
    const path = vscode.window.activeTextEditor?.document.uri.fsPath;
    const state = path ? this.registry.get(path) : undefined;
    if (!state) {
      this._item.hide();
      return;
    }

    const aur = describeAur(state);
    this._item.text = `$(package) ${state.pkgbuild.pkgbase} ${state.pkgbuild.version ?? ""}${aur ? ` · ${aur}` : ""}`;
    this._item.tooltip = packageTooltip(state);
    this._item.show();
  }

  public dispose() {
    for (const disposable of this._disposables) disposable.dispose();
  }
}

export default StatusBar;
