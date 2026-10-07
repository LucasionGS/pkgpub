import * as vscode from "vscode";
import { checkAccess, selectSshKey } from "./commands/access";
import { build, clean, openAurCheckout, openBuildFolder } from "./commands/build";
import { command, CommandArgument, resolvePackage } from "./commands/common";
import { publish } from "./commands/publish";
import { generatePkgver, promptVersion } from "./commands/version";
import Log from "./Log";
import PackageRegistry, { PackageState } from "./PackageRegistry";
import { run } from "./Utilities";
import AurDiffProvider from "./views/AurDiffProvider";
import CreatePkgbuildPanel from "./views/CreatePkgbuildPanel";
import PackageTree from "./views/PackageTree";
import PkgbuildCodeLens from "./views/PkgbuildCodeLens";
import { aurPage } from "./views/presentation";
import StatusBar from "./views/StatusBar";

export async function activate(context: vscode.ExtensionContext) {
  const registry = new PackageRegistry();
  const codeLens = new PkgbuildCodeLens(registry);

  context.subscriptions.push(
    registry,
    Log.channel(),
    new StatusBar(registry),
    vscode.window.createTreeView("pkgpub.packages", { treeDataProvider: new PackageTree(registry), showCollapseAll: true }),
    vscode.languages.registerCodeLensProvider({ pattern: "**/PKGBUILD" }, codeLens),
    vscode.workspace.registerTextDocumentContentProvider(AurDiffProvider.SCHEME, new AurDiffProvider()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pkgpub.exclude")) void registry.scan();
      if (e.affectsConfiguration("pkgpub.sshKey")) {
        registry.invalidateAccess();
        void registry.refreshRemote();
      }
    }),
  );

  // Commands that act on one package
  const packageCommands: Record<string, (state: PackageState) => Thenable<unknown>> = {
    "pkgpub.build": (state) => build(registry, state, false),
    "pkgpub.buildInstall": (state) => build(registry, state, true),
    "pkgpub.publish": (state) => publish(registry, state),
    "pkgpub.setVersion": (state) => promptVersion(registry, state, "set"),
    "pkgpub.generatePkgver": (state) => generatePkgver(registry, state),
    "pkgpub.checkAccess": (state) => checkAccess(registry, state),
    "pkgpub.clean": (state) => clean(state),
    "pkgpub.openBuildFolder": (state) => openBuildFolder(state),
    "pkgpub.openAurCheckout": (state) => openAurCheckout(state),
    "pkgpub.openAurPage": (state) => vscode.env.openExternal(aurPage(state)),
    "pkgpub.openPkgbuild": (state) => vscode.window.showTextDocument(state.pkgbuild.uri),
    "pkgpub.actions": (state) => showActions(state),
  };
  for (const [id, fn] of Object.entries(packageCommands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, command(async (arg: CommandArgument) => {
      const state = await resolvePackage(registry, arg);
      if (state) await fn(state);
    })));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pkgpub.refresh", command(() => registry.refresh())),
    vscode.commands.registerCommand("pkgpub.selectSshKey", command(() => selectSshKey(registry))),
    vscode.commands.registerCommand("pkgpub.createPkgbuild", command((folder?: vscode.Uri) => {
      return CreatePkgbuildPanel.show(context.extensionUri, registry, folder instanceof vscode.Uri ? folder : undefined);
    })),
  );

  const makepkg = await run("makepkg", ["--version"], { quiet: true }).catch(() => null);
  if (!makepkg || makepkg.code !== 0) {
    vscode.window.showWarningMessage("pkgpub needs makepkg, which comes with pacman on Arch Linux. Building and publishing won't work without it.");
  }
  void registry.refresh();
}

/**
 * Quick pick of everything pkgpub can do with a package.
 */
async function showActions(state: PackageState) {
  const { pkgbuild } = state;
  const actions = [
    { label: "$(tools) Build", command: "pkgpub.build" },
    { label: "$(desktop-download) Build and Install", command: "pkgpub.buildInstall" },
    { label: "$(cloud-upload) Publish to AUR", command: "pkgpub.publish" },
    { label: "$(tag) Set Version", command: "pkgpub.setVersion" },
    { label: "$(symbol-function) Generate pkgver()", command: "pkgpub.generatePkgver" },
    { label: "$(key) Check AUR Access", command: "pkgpub.checkAccess" },
    { label: "$(link-external) Open on AUR", command: "pkgpub.openAurPage" },
    { label: "$(folder-opened) Open Build Folder", command: "pkgpub.openBuildFolder" },
    { label: "$(repo) Open AUR Checkout Folder", command: "pkgpub.openAurCheckout" },
    { label: "$(trash) Clean Build Folder", command: "pkgpub.clean" },
  ];
  const picked = await vscode.window.showQuickPick(actions, { title: `${pkgbuild.pkgbase} ${pkgbuild.version ?? ""}` });
  if (picked) await vscode.commands.executeCommand(picked.command, pkgbuild.uri);
}

export function deactivate() { }
