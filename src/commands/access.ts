import * as vscode from "vscode";
import fsp from "node:fs/promises";
import os from "node:os";
import Path from "node:path";
import AurRepo from "../objects/AurRepo";
import type { PackageRegistry, PackageState } from "../PackageRegistry";
import Settings from "../Settings";
import { exists } from "../Utilities";
import { describeAccess } from "../views/presentation";
import { withProgress } from "./common";

/**
 * Check again whether the configured SSH key can publish a package, and report the result.
 */
export async function checkAccess(registry: PackageRegistry, state: PackageState) {
  registry.invalidateAccess();
  await withProgress(`Checking AUR access for ${state.pkgbuild.pkgbase}...`, () => registry.refreshRemote([state]));

  const { access } = state;
  const text = `${state.pkgbuild.pkgbase}: ${describeAccess(access)}.${access.message ? ` ${access.message}` : ""}`;
  if (access.access === AurRepo.Access.Granted || access.access === AurRepo.Access.New) {
    vscode.window.showInformationMessage(text);
  }
  else if (access.access === AurRepo.Access.KeyRejected) {
    const action = await vscode.window.showErrorMessage(text, "Select SSH Key");
    if (action === "Select SSH Key") await selectSshKey(registry);
  }
  else {
    vscode.window.showWarningMessage(text);
  }
}

/**
 * Pick the SSH key used for the AUR from the keys in `~/.ssh`, or fall back to the normal SSH setup.
 */
export async function selectSshKey(registry: PackageRegistry) {
  const sshDir = Path.join(os.homedir(), ".ssh");
  const current = Settings.sshKey;

  type KeyItem = vscode.QuickPickItem & { key?: string | null };
  const items: KeyItem[] = [];
  const names = await fsp.readdir(sshDir).catch(() => [] as string[]);
  for (const name of names.sort()) {
    const path = Path.join(sshDir, name);
    if (name.endsWith(".pub") || !await exists(`${path}.pub`)) continue;
    const comment = (await fsp.readFile(`${path}.pub`, "utf8").catch(() => "")).trim().split(/\s+/).slice(2).join(" ");
    items.push({
      label: `$(key) ${name}`,
      description: `${comment}${path === current ? " (current)" : ""}`,
      key: path,
    });
  }
  // Prefer keys that look like they're meant for the AUR
  items.sort((a, b) => Number(/aur/i.test(b.label)) - Number(/aur/i.test(a.label)));
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(terminal) Use my SSH setup", description: `ssh-agent and ~/.ssh/config${current === null ? " (current)" : ""}`, key: null },
    { label: "$(folder-opened) Browse..." },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: "SSH key for the AUR",
    placeHolder: "The key whose public key is added to your AUR account",
  });
  if (!picked) return;

  let key = picked.key;
  if (key === undefined) {
    const uris = await vscode.window.showOpenDialog({
      title: "Select the private SSH key for the AUR",
      defaultUri: vscode.Uri.file(sshDir),
      canSelectMany: false,
    });
    if (!uris?.length) return;
    key = uris[0].fsPath;
  }

  await Settings.setSshKey(key);
  registry.invalidateAccess();
  await withProgress("Checking AUR access...", () => registry.refreshRemote());

  try {
    const repos = await AurRepo.listRepos();
    vscode.window.showInformationMessage(`The AUR accepted the key. It maintains ${repos.length} package${repos.length === 1 ? "" : "s"}.`);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}
