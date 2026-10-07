import * as vscode from "vscode";
import Path from "node:path";
import AurApi from "../AurApi";
import AurRepo from "../objects/AurRepo";
import Builder from "../objects/Builder";
import type { PackageRegistry, PackageState } from "../PackageRegistry";
import ProjectConfig from "../ProjectConfig";
import Settings from "../Settings";
import SrcInfo from "../SrcInfo";
import { exists } from "../Utilities";
import AurDiffProvider from "../views/AurDiffProvider";
import { withProgress } from "./common";
import { promptVersion } from "./version";

/**
 * Publish a package to the AUR: check access, settle the version and checksums, copy everything into the AUR
 * checkout, show the diff, and commit and push once confirmed.
 */
export async function publish(registry: PackageRegistry, state: PackageState) {
  const { pkgbuild } = state;
  await pkgbuild.saveIfDirty();
  await registry.reload(pkgbuild.path);
  if (!pkgbuild.srcinfo) throw new Error(`The PKGBUILD could not be read: ${pkgbuild.error ?? "unknown error"}`);

  // Access
  await withProgress(`Checking AUR access for ${pkgbuild.pkgbase}...`, () => registry.refreshRemote([state]));
  const access = state.access;
  if (access.access === AurRepo.Access.KeyRejected) {
    const action = await vscode.window.showErrorMessage(access.message ?? "The AUR rejected the SSH key.", "Select SSH Key");
    if (action === "Select SSH Key") await vscode.commands.executeCommand("pkgpub.selectSshKey");
    return;
  }
  if (access.access === AurRepo.Access.Denied) {
    throw new Error(`${access.message ?? "No push access."} Ask the maintainer (${state.aur?.Maintainer ?? "nobody"}) to add you as a co-maintainer.`);
  }
  if (access.access !== AurRepo.Access.Granted && access.access !== AurRepo.Access.New) {
    throw new Error(`Couldn't check access to the AUR: ${access.message ?? "unknown error"}`);
  }

  // Version and checksums
  if (!await promptVersion(registry, state, "publish")) return;
  if (Settings.updateChecksums && pkgbuild.hasChecksummedSources()) {
    const text = await withProgress(`Updating checksums of ${pkgbuild.pkgbase}...`, () => new Builder(pkgbuild).updateChecksums());
    await pkgbuild.writeText(text);
  }
  await registry.reload(pkgbuild.path);
  const srcinfo = pkgbuild.srcinfo;
  if (!srcinfo) throw new Error(`The PKGBUILD could not be read: ${pkgbuild.error ?? "unknown error"}`);
  const version = SrcInfo.fullVersion(srcinfo);

  // Stage into the AUR checkout
  const config = await ProjectConfig.getPackage(pkgbuild);
  const files = [{ name: "PKGBUILD", path: pkgbuild.path }, ...await pkgbuild.getLocalFiles()];
  for (const name of config.extraFiles ?? []) {
    const path = Path.join(pkgbuild.dir, name);
    if (!await exists(path)) throw new Error(`"${name}" is listed in extraFiles in .pkgpub/config.json, but doesn't exist next to the PKGBUILD.`);
    files.push({ name, path });
  }

  const repo = new AurRepo(pkgbuild.pkgbase);
  const changes = await withProgress(`Preparing the AUR checkout of ${pkgbuild.pkgbase}...`, async () => {
    await repo.sync();
    return await repo.stage(files, srcinfo.text);
  });
  if (changes.length === 0) {
    vscode.window.showInformationMessage(`${pkgbuild.pkgbase} ${version} is already up to date on the AUR.`);
    return;
  }

  // Review
  await AurDiffProvider.show(pkgbuild.pkgbase, changes);
  const template = config.commitMessage ?? Settings.commitMessage;
  const message = await vscode.window.showInputBox({
    title: `Publish ${pkgbuild.pkgbase} ${version} to the AUR`,
    prompt: "Commit message. Review the diff, then press Enter to continue or Escape to cancel.",
    value: template.replace(/\{version\}/g, version).replace(/\{pkgbase\}/g, pkgbuild.pkgbase),
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? null : "Enter a commit message.",
  });
  if (message === undefined) {
    await repo.discard();
    return;
  }

  const notes: string[] = [];
  if (access.access === AurRepo.Access.New) notes.push(`This creates the package "${pkgbuild.pkgbase}" on the AUR.`);
  if (state.aur && state.comparison === 0) notes.push(`The version is still ${version}, the same as on the AUR. AUR helpers won't offer this as an update. Bump pkgrel if the package itself changed.`);
  if (state.aur && state.comparison === -1) notes.push(`The AUR has a newer version (${state.aur.Version}) than this one.`);
  const statusNames = { A: "added", M: "modified", D: "deleted" };
  const detail = [
    ...changes.map(c => `${c.name} (${statusNames[c.status] ?? c.status})`),
    "",
    `Commit: ${message.trim()}`,
    ...(notes.length ? ["", ...notes] : []),
  ].join("\n");
  const confirm = await vscode.window.showWarningMessage(`Push ${pkgbuild.pkgbase} ${version} to the AUR?`, { modal: true, detail }, "Publish");
  if (confirm !== "Publish") {
    await repo.discard();
    return;
  }

  // Publish
  await withProgress(`Publishing ${pkgbuild.pkgbase} ${version}...`, async () => {
    await repo.commit(message.trim());
    await repo.push();
  });
  void registry.refreshRemote([state]);

  const action = await vscode.window.showInformationMessage(`Published ${pkgbuild.pkgbase} ${version} to the AUR.`, "Open on AUR");
  if (action === "Open on AUR") await vscode.env.openExternal(vscode.Uri.parse(AurApi.pageUrl(pkgbuild.pkgbase)));
}
