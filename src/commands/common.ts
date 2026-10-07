import * as vscode from "vscode";
import Log from "../Log";
import type { PackageRegistry, PackageState } from "../PackageRegistry";
import type { PackageTreeNode } from "../views/PackageTree";

/**
 * What a command can be invoked with: a tree node, a PKGBUILD URI (CodeLens, editor title), or nothing
 * (command palette, status bar).
 */
export type CommandArgument = PackageTreeNode | vscode.Uri | undefined;

/**
 * Find the package a command should act on. Without an argument, uses the PKGBUILD in the active editor, or
 * asks when there are several packages.
 */
export async function resolvePackage(registry: PackageRegistry, arg: CommandArgument): Promise<PackageState | undefined> {
  if (arg instanceof vscode.Uri) return registry.get(arg.fsPath);
  if (arg && "state" in arg) return arg.state;

  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const state = active ? registry.get(active) : undefined;
  if (state) return state;

  const packages = registry.packages;
  if (packages.length === 0) {
    vscode.window.showWarningMessage("No PKGBUILD files were found in this workspace.");
    return undefined;
  }
  if (packages.length === 1) return packages[0];

  const picked = await vscode.window.showQuickPick(
    packages.map(s => ({ label: s.pkgbuild.pkgbase, description: s.pkgbuild.version ?? "", detail: s.pkgbuild.relativePath, state: s })),
    { title: "Select a package", matchOnDetail: true },
  );
  return picked?.state;
}

/**
 * Wrap a command so thrown errors are shown as notifications with a button to open the log.
 */
export function command<T extends unknown[]>(fn: (...args: T) => Promise<unknown>): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Log.info(`Error: ${message}`);
      const action = await vscode.window.showErrorMessage(message, "Show Log");
      if (action === "Show Log") Log.show();
    }
  };
}

/**
 * Run a task with a progress notification.
 */
export function withProgress<T>(title: string, task: (progress: vscode.Progress<{ message?: string }>) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}
