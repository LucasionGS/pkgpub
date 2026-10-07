import * as vscode from "vscode";
import AurApi from "../AurApi";
import AurRepo from "../objects/AurRepo";
import type { PackageState } from "../PackageRegistry";

/**
 * Short text for an access check result.
 */
export function describeAccess(result: AurRepo.AccessResult): string {
  switch (result.access) {
    case AurRepo.Access.Unknown: return "Checking...";
    case AurRepo.Access.Granted: return "Push access";
    case AurRepo.Access.New: return "New package, publishing creates it";
    case AurRepo.Access.Denied: return result.user ? `No push access as ${result.user}` : "No push access";
    case AurRepo.Access.KeyRejected: return "SSH key rejected";
    case AurRepo.Access.Error: return "Couldn't check";
  }
}

export function accessIcon(result: AurRepo.AccessResult): vscode.ThemeIcon {
  switch (result.access) {
    case AurRepo.Access.Unknown: return new vscode.ThemeIcon("loading~spin");
    case AurRepo.Access.Granted: return new vscode.ThemeIcon("unlock", new vscode.ThemeColor("charts.green"));
    case AurRepo.Access.New: return new vscode.ThemeIcon("add", new vscode.ThemeColor("charts.blue"));
    case AurRepo.Access.Denied: return new vscode.ThemeIcon("lock", new vscode.ThemeColor("charts.red"));
    case AurRepo.Access.KeyRejected: return new vscode.ThemeIcon("key", new vscode.ThemeColor("charts.red"));
    case AurRepo.Access.Error: return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
  }
}

/**
 * Short text comparing the local version with the AUR, like `AUR 1.2.0-1` or `not on AUR`.
 */
export function describeAur(state: PackageState): string {
  if (state.aurError) return "AUR unavailable";
  if (state.aur === undefined) return "";
  if (state.aur === null) return "not on AUR";
  if (state.comparison === 0) return "up to date";
  return `AUR ${state.aur.Version}`;
}

/**
 * Icon summarising a package: red when broken, yellow when the local version is ahead of the AUR, green when
 * they match.
 */
export function packageIcon(state: PackageState): vscode.ThemeIcon {
  if (state.pkgbuild.error) return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
  if (state.aur === null) return new vscode.ThemeIcon("package", new vscode.ThemeColor("charts.blue"));
  if (state.comparison === 0) return new vscode.ThemeIcon("package", new vscode.ThemeColor("charts.green"));
  if (state.comparison === 1) return new vscode.ThemeIcon("package", new vscode.ThemeColor("charts.yellow"));
  if (state.comparison === -1) return new vscode.ThemeIcon("package", new vscode.ThemeColor("charts.orange"));
  return new vscode.ThemeIcon("package");
}

/**
 * Hover text with everything known about a package.
 */
export function packageTooltip(state: PackageState): vscode.MarkdownString {
  const { pkgbuild, aur } = state;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${pkgbuild.pkgbase}** \`${pkgbuild.version ?? "?"}\`\n\n`);
  md.appendMarkdown(`${pkgbuild.relativePath}\n\n`);
  if (pkgbuild.error) md.appendMarkdown(`$(error) ${pkgbuild.error}\n\n`);
  if (aur) {
    md.appendMarkdown(`AUR: \`${aur.Version}\`, maintained by ${aur.Maintainer ?? "nobody (orphaned)"}, ${aur.NumVotes} votes`);
    if (aur.OutOfDate) md.appendMarkdown(", **flagged out of date**");
    md.appendMarkdown("\n\n");
  }
  else if (aur === null) {
    md.appendMarkdown("Not on the AUR yet.\n\n");
  }
  md.appendMarkdown(`Access: ${describeAccess(state.access)}`);
  if (state.access.message) md.appendMarkdown(`, ${state.access.message}`);
  md.supportThemeIcons = true;
  return md;
}

/**
 * The AUR web page of a package.
 */
export function aurPage(state: PackageState): vscode.Uri {
  return vscode.Uri.parse(AurApi.pageUrl(state.pkgbuild.pkgbase));
}
