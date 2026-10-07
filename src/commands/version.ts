import * as vscode from "vscode";
import Builder from "../objects/Builder";
import Pkgbuild from "../objects/Pkgbuild";
import type { PackageRegistry, PackageState } from "../PackageRegistry";
import ProjectConfig from "../ProjectConfig";
import SrcInfo from "../SrcInfo";
import { run } from "../Utilities";
import VersionSource from "../VersionSource";
import { withProgress } from "./common";

interface ActionItem extends vscode.QuickPickItem {
  action?: () => Promise<void>;
}

/**
 * Copy `pkgver` and `pkgrel` from a staged PKGBUILD that makepkg updated by running `pkgver()` into the project's
 * PKGBUILD, the way makepkg would have if it ran in the project.
 */
export async function applyStagedVersion(pkgbuild: Pkgbuild, stagedText: string): Promise<boolean> {
  let text = await pkgbuild.readText();
  for (const name of ["pkgver", "pkgrel"]) {
    const value = Pkgbuild.getVariable(stagedText, name);
    if (value !== null && Pkgbuild.getVariable(text, name) !== null) text = Pkgbuild.setVariable(text, name, value);
  }
  return await pkgbuild.writeText(text);
}

/**
 * Fetch the sources and run `pkgver()` in the build folder, then write the computed version into the PKGBUILD.
 */
export async function runPkgver(registry: PackageRegistry, state: PackageState) {
  const { pkgbuild } = state;
  const staged = await withProgress(`Running pkgver() for ${pkgbuild.pkgbase}...`, () => new Builder(pkgbuild).runPkgver());
  await applyStagedVersion(pkgbuild, staged);
  await registry.reload(pkgbuild.path);
}

async function writeVersion(registry: PackageRegistry, pkgbuild: Pkgbuild, pkgver: string, pkgrel: string) {
  let text = await pkgbuild.readText();
  text = Pkgbuild.setVariable(text, "pkgver", pkgver);
  text = Pkgbuild.setVariable(text, "pkgrel", pkgrel);
  await pkgbuild.writeText(text);
  await registry.reload(pkgbuild.path);
}

/**
 * Ask how the version should change and apply the answer to the PKGBUILD.
 * @param mode `publish` adds a "Keep" option as the default.
 * @returns `false` when the user cancelled.
 */
export async function promptVersion(registry: PackageRegistry, state: PackageState, mode: "publish" | "set"): Promise<boolean> {
  const { pkgbuild } = state;
  const srcinfo = pkgbuild.srcinfo;
  if (!srcinfo) throw new Error(`The PKGBUILD could not be read: ${pkgbuild.error ?? "unknown error"}`);

  const current = SrcInfo.fullVersion(srcinfo);
  const nextRel = `${Math.floor(parseFloat(srcinfo.pkgrel) || 0) + 1}`;
  const keep: ActionItem = { label: `$(check) Keep ${current}`, description: "Publish the version as it is" };
  const bump: ActionItem = {
    label: `$(add) ${srcinfo.pkgver}-${nextRel}`,
    description: "Bump pkgrel, for changes to the packaging only",
    action: () => writeVersion(registry, pkgbuild, srcinfo.pkgver, nextRel),
  };
  const items: ActionItem[] = [];

  if (pkgbuild.hasPkgverFunction) {
    const runItem: ActionItem = {
      label: "$(sync) Run pkgver()",
      description: "Fetch the sources and let pkgver() compute the version",
      action: () => runPkgver(registry, state),
    };
    items.push(...(mode === "publish" ? [keep, runItem, bump] : [runItem, bump]));
    if (mode === "set") {
      items.push({
        label: "$(symbol-function) Regenerate pkgver()...",
        description: "Change where pkgver() gets the version from",
        action: () => generatePkgver(registry, state),
      });
    }
  }
  else {
    const config = await ProjectConfig.getPackage(pkgbuild);
    const detected = await withProgress("Looking for version sources...", () => VersionSource.detect(pkgbuild));

    let configured: VersionSource.Detected | null = null;
    if (config.versionSource) {
      const version = await VersionSource.read(config.versionSource, pkgbuild);
      if (version) configured = { config: config.versionSource, version };
    }

    const sourceItem = (source: VersionSource.Detected, icon: string): ActionItem => {
      const pkgver = VersionSource.toPkgver(source.version);
      const isCurrent = pkgver === srcinfo.pkgver;
      return {
        label: `$(${icon}) ${pkgver}-${isCurrent ? srcinfo.pkgrel : "1"}`,
        description: `from ${VersionSource.describe(source.config)}${isCurrent ? " (current)" : ""}`,
        action: async () => {
          await ProjectConfig.updatePackage(pkgbuild, { versionSource: source.config });
          if (!isCurrent) await writeVersion(registry, pkgbuild, pkgver, "1");
        },
      };
    };

    const isSame = (a: VersionSource.Config, b: VersionSource.Config) => a.type === b.type && a.path === b.path && a.command === b.command;
    const others = detected.filter(d => !configured || !isSame(d.config, configured.config));
    const configuredChanged = configured && VersionSource.toPkgver(configured.version) !== srcinfo.pkgver;

    if (configured && configuredChanged) items.push(sourceItem(configured, "arrow-up"));
    if (mode === "publish") items.push(keep);
    if (configured && !configuredChanged) items.push(sourceItem(configured, "versions"));
    items.push(bump);
    if (others.length) {
      items.push({ label: "Other version sources", kind: vscode.QuickPickItemKind.Separator });
      items.push(...others.map(d => sourceItem(d, "versions")));
    }
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: "$(edit) Enter a version...",
      action: () => enterVersion(registry, pkgbuild, srcinfo),
    });
    items.push({
      label: "$(symbol-function) Generate pkgver() instead...",
      description: "Compute the version during the build",
      action: () => generatePkgver(registry, state),
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `${mode === "publish" ? "Publish" : "Set the version of"} ${pkgbuild.pkgbase} (currently ${current})`,
    placeHolder: "Version",
  });
  if (!picked) return false;
  await picked.action?.();
  return true;
}

async function enterVersion(registry: PackageRegistry, pkgbuild: Pkgbuild, srcinfo: SrcInfo.Data) {
  const input = await vscode.window.showInputBox({
    title: `Version of ${pkgbuild.pkgbase}`,
    prompt: "pkgver, or pkgver-pkgrel. A new pkgver resets pkgrel to 1.",
    value: srcinfo.pkgver,
    validateInput: (value) => {
      const pkgver = value.trim().replace(/-\d+(\.\d+)?$/, "");
      if (!pkgver) return "Enter a version.";
      if (/[-:/\s]/.test(pkgver)) return "pkgver can't contain hyphens, colons, slashes or spaces.";
      return null;
    },
  });
  if (input === undefined) return;

  const match = input.trim().match(/^(.+?)(?:-(\d+(?:\.\d+)?))?$/)!;
  const pkgver = match[1];
  const pkgrel = match[2] ?? (pkgver === srcinfo.pkgver ? srcinfo.pkgrel : "1");
  await writeVersion(registry, pkgbuild, pkgver, pkgrel);
}

/**
 * Ask where the version should come from and write a `pkgver()` function that reads it during the build.
 */
export async function generatePkgver(registry: PackageRegistry, state: PackageState) {
  const { pkgbuild } = state;
  const srcinfo = pkgbuild.srcinfo;
  if (!srcinfo) throw new Error(`The PKGBUILD could not be read: ${pkgbuild.error ?? "unknown error"}`);

  const config = await ProjectConfig.getPackage(pkgbuild);
  const previous = config.versionSource;
  const detected = await VersionSource.detect(pkgbuild);
  const vcsDirs = srcinfo.sources.filter(SrcInfo.isVcs).map(SrcInfo.getFilename);
  const isVcsPackage = vcsDirs.length > 0 || srcinfo.pkgbase.endsWith("-git");

  // Source type
  type TypeItem = vscode.QuickPickItem & { type: VersionSource.Type };
  const typeItems: TypeItem[] = [
    { type: "git-revision", label: "$(git-commit) Git revision count", description: "r42.abc1234", detail: "Counts the commits of the git source. Good for -git packages without release tags." },
    { type: "git-tag", label: "$(tag) Latest git tag", description: "1.2.0.r3.gabc1234", detail: "The latest tag of the git source plus the commits since it, via git describe." },
    ...Object.keys(VersionSource.FILE_TYPES).map((type): TypeItem => ({
      type: type as VersionSource.Type,
      label: `$(file-code) ${type}`,
      description: detected.find(d => d.config.type === type)?.version ?? "",
      detail: `Reads the version field of ${type} in the sources.`,
    })),
    { type: "command", label: "$(terminal) Custom command", detail: "Any shell command that prints the version, run inside the sources." },
  ];
  const typePick = vscode.window.createQuickPick<TypeItem>();
  typePick.title = `Generate pkgver() for ${pkgbuild.pkgbase}`;
  typePick.placeholder = "Where should pkgver() get the version from?";
  typePick.items = typeItems;
  typePick.matchOnDetail = true;
  const preselected = typeItems.find(i => i.type === previous?.type);
  if (preselected) typePick.activeItems = [preselected];
  const typeItem = await new Promise<TypeItem | undefined>((resolve) => {
    typePick.onDidAccept(() => resolve(typePick.selectedItems[0]));
    typePick.onDidHide(() => resolve(undefined));
    typePick.show();
  });
  typePick.dispose();
  if (!typeItem) return;

  const source: VersionSource.Config = { type: typeItem.type };

  // File path and revision suffix
  if (VersionSource.FILE_TYPES[source.type]) {
    const found = detected.find(d => d.config.type === source.type);
    const defaultPath = previous?.type === source.type && previous.path
      ? previous.path
      : found ? await pathInRepository(pkgbuild, found.config.path!) : source.type;
    const path = await vscode.window.showInputBox({
      title: `Path of ${source.type} inside the sources`,
      prompt: "Relative to the source folder pkgver() runs in.",
      value: defaultPath,
      validateInput: (value) => value.trim() ? null : "Enter a path.",
    });
    if (path === undefined) return;
    source.path = path.trim();

    const versionOnly = { label: "Version only", description: "1.2.0", append: false };
    const withRevision = { label: "Version + git revision", description: "1.2.0.r42.abc1234, recommended for -git packages", append: true };
    const suffix = await vscode.window.showQuickPick(isVcsPackage ? [withRevision, versionOnly] : [versionOnly, withRevision], {
      title: "Append the git revision?",
    });
    if (!suffix) return;
    source.appendRevision = suffix.append;
  }
  else if (source.type === "command") {
    const command = await vscode.window.showInputBox({
      title: "Command that prints the version",
      prompt: "Runs in bash inside the source folder. Its output becomes pkgver.",
      value: previous?.command ?? "",
      validateInput: (value) => value.trim() ? null : "Enter a command.",
    });
    if (command === undefined) return;
    source.command = command.trim();
  }

  // Folder inside $srcdir
  const srcDir = await pickSrcDir(srcinfo, vcsDirs, previous?.srcDir);
  if (srcDir === undefined) return;
  source.srcDir = srcDir;

  let text = await pkgbuild.readText();
  text = Pkgbuild.setPkgverFunction(text, srcDir, VersionSource.pkgverBody(source));
  if (VersionSource.needsGit(source)) text = Pkgbuild.addMakedepend(text, "git");
  await pkgbuild.writeText(text);
  await ProjectConfig.updatePackage(pkgbuild, { versionSource: source });
  await registry.reload(pkgbuild.path);

  const warning = VersionSource.needsGit(source) && vcsDirs.length === 0
    ? " The sources have no git checkout, so the git commands in it will fail until you add a git source."
    : "";
  const action = await vscode.window.showInformationMessage(
    `Generated pkgver() reading the ${VersionSource.describe(source)}.${warning}`,
    "Run pkgver()",
  );
  if (action === "Run pkgver()") await runPkgver(registry, state);
}

/**
 * Ask which folder inside `$srcdir` pkgver() should run in. Uses the only git source without asking.
 */
async function pickSrcDir(srcinfo: SrcInfo.Data, vcsDirs: string[], previous?: string): Promise<string | undefined> {
  if (vcsDirs.length === 1 && (!previous || previous === vcsDirs[0])) return vcsDirs[0];

  const candidates = [...new Set([
    ...(previous ? [previous] : []),
    ...vcsDirs,
    "$pkgname-$pkgver",
    "$pkgname",
  ])];
  const items: vscode.QuickPickItem[] = [
    ...candidates.map(dir => ({ label: dir, description: vcsDirs.includes(dir) ? "git source" : "" })),
    { label: "$(edit) Other..." },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Folder inside $srcdir that pkgver() runs in",
    placeHolder: srcinfo.sources.length ? `Sources: ${srcinfo.sources.join(", ")}` : undefined,
  });
  if (!picked) return undefined;
  if (!picked.label.startsWith("$(edit)")) return picked.label;

  return await vscode.window.showInputBox({
    title: "Folder inside $srcdir that pkgver() runs in",
    prompt: "Shell variables like $pkgname work.",
  });
}

/**
 * Path of a project file relative to its git repository's root, which is where it ends up in a git source.
 */
async function pathInRepository(pkgbuild: Pkgbuild, workspacePath: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--show-prefix"], { cwd: pkgbuild.workspaceRoot, quiet: true });
  const prefix = result.code === 0 ? result.stdout.trim() : "";
  return `${prefix}${workspacePath}`;
}
