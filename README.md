# pkgpub - PKGBUILD Publisher

Build and publish the PKGBUILDs in your projects to the AUR without leaving VS Code, and without `src/`, `pkg/` and tarballs piling up next to your code.

## Key Features

- **PKGBUILD generator**: No PKGBUILD yet? Fill out a form and get one. The name, version, description, URL, license, maintainer and build system are read from your project, and a live preview shows the result as you type.
- **Automatic detection**: Every `PKGBUILD` in the workspace shows up in the pkgpub sidebar, with its local version, the version on the AUR and whether you can push to it.
- **Clean builds**: Builds run on a copy in `~/.pkgpub/build/<pkgbase>/`. Downloads, `src/`, `pkg/` and the built packages all live there, and your project stays exactly as it was.
- **Build & Install**: One click runs `makepkg -si` in a terminal, so you can test the package on your own machine first.
- **Publish to the AUR**: pkgpub settles the version, updates checksums, regenerates `.SRCINFO`, copies everything into an AUR checkout, shows you a diff, and pushes once you confirm.
- **Access check**: Before you try to push, pkgpub asks the AUR whether your SSH key can. This also works for packages you co-maintain, and new packages are created on their first publish.
- **Your own SSH key**: Point pkgpub at the key on your AUR account (`~/.ssh/id_ed25519_aur`, say). It's only used for AUR traffic, so your GitHub setup stays out of it.
- **Versions from your project**: Set `pkgver` from `package.json`, `deno.json`, `ipm-package.yaml`, `Cargo.toml` or the latest git tag. pkgpub remembers the choice and offers the new version the next time you publish.
- **pkgver() generator**: For VCS packages, pkgpub can write a `pkgver()` for you that uses the git revision count, `git describe`, a version file in the sources (optionally with the git revision appended) or any command.
- **CodeLens & status bar**: Build, Publish and Set Version buttons sit at the top of every PKGBUILD, and the status bar shows how the open package compares to the AUR.

## Getting started

1. Add your SSH public key to your AUR account under *My Account*.
2. Run **pkgpub: Select AUR SSH Key** and pick the matching private key, or choose "Use my SSH setup" if `~/.ssh/config` already handles `aur.archlinux.org`.
3. Open a project with a PKGBUILD and hit **Publish** in the sidebar or at the top of the file.

pkgpub needs `makepkg` and `updpkgsums` (both part of `pacman`), `git` and `ssh`, so it's meant for Arch Linux and its friends.

## Creating a PKGBUILD

Click **Create PKGBUILD** in the empty pkgpub sidebar or its title bar, or right-click a folder in the Explorer. The form is filled in from what the project already says about itself:

- **Manifests**: `package.json`, `deno.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pubspec.yaml` and `ipm-package.yaml` give the name, version, description, URL, license and command name.
- **License file**: `LICENSE` or `COPYING` gives the SPDX identifier, and pkgpub offers to install the file.
- **Git**: the remote gives the repository, your git config gives the maintainer, and the latest tag gives the version.
- **GitHub**: the repository's description and license fill any gaps.

Each auto-filled field says where its value came from. Change whatever you like, and clear a field to get the detected value back.

Choose between a **release tarball** and a **`-git` package** that builds the latest commit. For `-git` packages, pkgpub writes a `pkgver()` for you. The build steps come from presets for npm, pnpm, yarn, Bun, Deno, Go, Rust, Python, Dart, Make, CMake and Meson. They follow the Arch packaging guidelines, and anything pkgpub can't know is marked with a `TODO` comment. After creating the file, pkgpub remembers the version source, so publishing later offers the new version.

## Publishing, step by step

1. **Access**: The AUR is asked whether your key can push. If it can't, you're told which account it's logged in as.
2. **Version**: Keep it, take the new version from your version source, bump `pkgrel`, or type one in. With a `pkgver()` function you can also run it to compute the version.
3. **Checksums**: `updpkgsums` runs on the build copy, and the new sums are written back into your PKGBUILD. `SKIP` entries stay `SKIP`. You can turn this off with `pkgpub.updateChecksums`.
4. **Diff**: The AUR checkout in `~/.pkgpub/aur/<pkgbase>/` is reset to what the AUR has, and your files go on top. That's the PKGBUILD, a fresh `.SRCINFO`, local sources, install scripts, changelogs and any `extraFiles`. Files that aren't part of the package anymore are removed. A diff of everything opens.
5. **Confirm**: Enter the commit message, confirm, and pkgpub commits and pushes.

Cancelling at any point leaves the AUR untouched.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pkgpub.sshKey` | *(empty)* | Private key for the AUR. Empty uses your normal SSH setup. |
| `pkgpub.dataDirectory` | `~/.pkgpub` | Where AUR checkouts (`aur/`) and build folders (`build/`) go. |
| `pkgpub.exclude` | `node_modules`, `.git`, `.aur`, `out`, `dist` | Globs to skip when looking for PKGBUILDs. |
| `pkgpub.makepkgArgs` | `[]` | Extra `makepkg` arguments for builds, like `--nocheck`. |
| `pkgpub.updateChecksums` | `true` | Run `updpkgsums` before publishing. |
| `pkgpub.commitMessage` | `Update to {version}` | Default AUR commit message. `{version}` and `{pkgbase}` are replaced. |
| `pkgpub.codeLens` | `true` | Show the action buttons at the top of PKGBUILDs. |

### Project settings: `.pkgpub/config.json`

Per-project choices are stored at the root of the workspace folder, so you can commit them. pkgpub writes this file when you pick a version source or generate a `pkgver()`. You can also edit it by hand, and VS Code completes it from the schema.

```json
{
  "packages": {
    "packaging/aur/podium/PKGBUILD": {
      "versionSource": { "type": "package.json", "path": "package.json" },
      "extraFiles": [".gitignore"],
      "commitMessage": "Update to {version}"
    }
  }
}
```

## Technical bits

- Builds run `makepkg --syncdeps --force [--install]` as a VS Code task in `build/<pkgbase>/staging/`, with `SRCDEST`, `PKGDEST`, `SRCPKGDEST` and `LOGDEST` pointed into the build folder. Sources are cached between builds. If makepkg updates `pkgver` through `pkgver()`, the new value is written back into your PKGBUILD, like an in-place build would do.
- Package metadata comes from `makepkg --printsrcinfo`, which sources the PKGBUILD. That's why pkgpub stays disabled in untrusted workspaces.
- Access is checked with `ssh aur@aur.archlinux.org list-repos`. For packages you don't own, pkgpub starts `git-receive-pack` and closes it right away. The AUR checks permissions before anything can be pushed.
- The AUR checkout is managed by pkgpub: every publish resets it to the AUR's `master`, so don't keep your own work in it.

## Building and installing locally

You'll need Node.js 22 (see `.nvmrc`) and npm.

```sh
npm install
npm run package                               # compiles and builds pkgpub-<version>.vsix
code --install-extension pkgpub-0.1.0.vsix    # use the version that was just built
```

Reload VS Code afterwards, with **Developer: Reload Window** or by restarting it. You can also install the `.vsix` from the Extensions view: open the `...` menu and choose **Install from VSIX...**.

To update, bump `version` in `package.json`, then package and install again. The new version replaces the old one. To remove it, run `code --uninstall-extension ionnet.pkgpub`.

## Development

```sh
npm install
npm run watch     # or press F5 to launch an Extension Development Host
npm run lint
npm run package   # builds pkgpub-<version>.vsix
```
