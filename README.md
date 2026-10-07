# pkgpub - PKGBUILD Publisher

Build and publish the PKGBUILDs in your projects to the AUR without leaving VS Code, and without `src/`, `pkg/` and tarballs piling up next to your code.

## Key Features

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

## Development

```sh
npm install
npm run watch     # or press F5 to launch an Extension Development Host
npm run lint
npm run package   # builds pkgpub-<version>.vsix
```
