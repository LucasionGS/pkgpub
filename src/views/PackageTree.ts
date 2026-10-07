import * as vscode from "vscode";
import type { PackageRegistry, PackageState } from "../PackageRegistry";
import ProjectConfig from "../ProjectConfig";
import VersionSource from "../VersionSource";
import { accessIcon, aurPage, describeAccess, describeAur, packageIcon, packageTooltip } from "./presentation";

export type PackageTreeNode = PackageTree.PackageNode | PackageTree.DetailNode;

/**
 * The "Packages" view: one node per detected PKGBUILD, with its AUR status as children.
 */
export class PackageTree implements vscode.TreeDataProvider<PackageTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly registry: PackageRegistry) {
    registry.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  public getTreeItem(node: PackageTreeNode): vscode.TreeItem {
    if (node.kind === "detail") return node.item;

    const { state } = node;
    const multiFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const item = new vscode.TreeItem(state.pkgbuild.pkgbase, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = state.pkgbuild.path;
    item.description = [
      state.pkgbuild.version ?? "invalid",
      describeAur(state),
      multiFolder ? state.pkgbuild.relativePath : "",
    ].filter(Boolean).join(" · ");
    item.iconPath = packageIcon(state);
    item.tooltip = packageTooltip(state);
    item.contextValue = "pkgpub.package";
    return item;
  }

  public async getChildren(node?: PackageTreeNode): Promise<PackageTreeNode[]> {
    if (!node) {
      return this.registry.packages.map(state => ({ kind: "package", state }));
    }
    if (node.kind !== "package") return [];

    const { state } = node;
    const { pkgbuild, aur } = state;
    const details: vscode.TreeItem[] = [];

    if (pkgbuild.error) {
      const item = new vscode.TreeItem("Error");
      item.description = pkgbuild.error.split("\n")[0];
      item.tooltip = pkgbuild.error;
      item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      details.push(item);
    }

    const local = new vscode.TreeItem("Version");
    local.description = `${pkgbuild.version ?? "?"}${pkgbuild.hasPkgverFunction ? " · pkgver()" : ""}`;
    local.iconPath = new vscode.ThemeIcon("tag");
    local.command = { title: "Set Version", command: "pkgpub.setVersion", arguments: [pkgbuild.uri] };
    details.push(local);

    const source = await ProjectConfig.getPackage(pkgbuild).then(c => c.versionSource).catch(() => undefined);
    const sourceItem = new vscode.TreeItem("Version source");
    sourceItem.description = source ? VersionSource.describe(source) : "not set";
    sourceItem.iconPath = new vscode.ThemeIcon(pkgbuild.hasPkgverFunction ? "symbol-function" : "versions");
    sourceItem.command = pkgbuild.hasPkgverFunction
      ? { title: "Generate pkgver()", command: "pkgpub.generatePkgver", arguments: [pkgbuild.uri] }
      : { title: "Set Version", command: "pkgpub.setVersion", arguments: [pkgbuild.uri] };
    details.push(sourceItem);

    const remote = new vscode.TreeItem("AUR");
    if (state.aurError) {
      remote.description = "unavailable";
      remote.tooltip = state.aurError;
    }
    else if (aur === undefined) {
      remote.description = "Loading...";
    }
    else if (aur === null) {
      remote.description = "Not published yet";
    }
    else {
      remote.description = `${aur.Version} · ${aur.Maintainer ?? "orphaned"} · ${aur.NumVotes} votes${aur.OutOfDate ? " · out of date" : ""}`;
      remote.command = { title: "Open on AUR", command: "vscode.open", arguments: [aurPage(state)] };
    }
    remote.iconPath = new vscode.ThemeIcon("cloud");
    details.push(remote);

    const access = new vscode.TreeItem("Access");
    access.description = describeAccess(state.access);
    access.tooltip = state.access.message;
    access.iconPath = accessIcon(state.access);
    access.command = { title: "Check AUR Access", command: "pkgpub.checkAccess", arguments: [pkgbuild.uri] };
    details.push(access);

    const file = new vscode.TreeItem("PKGBUILD");
    file.description = pkgbuild.relativePath;
    file.iconPath = new vscode.ThemeIcon("go-to-file");
    file.command = { title: "Open PKGBUILD", command: "vscode.open", arguments: [pkgbuild.uri] };
    details.push(file);

    return details.map(item => ({ kind: "detail", state, item }));
  }
}

export namespace PackageTree {
  export interface PackageNode {
    kind: "package";
    state: PackageState;
  }

  export interface DetailNode {
    kind: "detail";
    state: PackageState;
    item: vscode.TreeItem;
  }
}

export default PackageTree;
