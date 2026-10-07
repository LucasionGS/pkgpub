import VersionSource from "./VersionSource";

/**
 * Renders new PKGBUILDs from a set of fields, with build steps for common build systems following the Arch
 * packaging guidelines.
 */
export namespace PkgbuildTemplate {
  export enum BuildSystem {
    Custom = "custom",
    Npm = "npm",
    Pnpm = "pnpm",
    Yarn = "yarn",
    Bun = "bun",
    Deno = "deno",
    Go = "go",
    Cargo = "cargo",
    Python = "python",
    Dart = "dart",
    Make = "make",
    CMake = "cmake",
    Meson = "meson",
  }

  export enum SourceKind {
    /** Tarball of a tagged release. */
    Release = "release",
    /** Latest commit of the git repository, as a `-git` package. */
    Git = "git",
  }

  export interface Options {
    kind: SourceKind;
    maintainer: string;
    pkgname: string;
    pkgver: string;
    pkgrel: string;
    pkgdesc: string;
    url: string;
    /**
     * SPDX license identifier.
     */
    license: string;
    arch: string[];
    depends: string[];
    makedepends: string[];
    buildSystem: BuildSystem;
    /**
     * Name of the command installed to `/usr/bin`.
     */
    executable: string;
    /**
     * Build system specific entry point, see `ProjectInfo.Data.entry`.
     */
    entry: string;
    /**
     * The `source` entry.
     */
    source: string;
    /**
     * Folder inside `$srcdir` the sources extract to.
     */
    srcDir: string;
    /**
     * Git packages only: where `pkgver()` gets the version.
     */
    pkgverSource: VersionSource.Config | null;
    /**
     * License file to install, or `null`.
     */
    licenseFile: string | null;
    hasBuildScript: boolean;
    isElectron: boolean;
    pythonBackend?: string;
  }

  /**
   * What a build system contributes to a PKGBUILD.
   */
  export interface BuildSystemTemplate {
    label: string;
    makedepends: (o: Partial<Options>) => string[];
    depends: (o: Partial<Options>) => string[];
    arch: (o: Partial<Options>) => string[];
    options?: string[];
    /**
     * Function bodies, without indentation or the `cd` into the sources.
     */
    functions: (o: Options) => Partial<Record<"prepare" | "build" | "check" | "package", string[]>>;
  }

  function installBinary(o: Options, from = o.executable): string[] {
    return [`install -Dm755 "${from}" "$pkgdir/usr/bin/${o.executable}"`];
  }

  function nodeTemplate(label: string, manager: "npm" | "pnpm" | "yarn" | "bun"): BuildSystemTemplate {
    const install = {
      npm: `npm ci --cache "$srcdir/npm-cache"`,
      pnpm: "pnpm install --frozen-lockfile",
      yarn: "yarn install --frozen-lockfile",
      bun: "bun install --frozen-lockfile",
    }[manager];
    const prune = { npm: "npm prune --omit=dev", pnpm: "pnpm prune --prod", yarn: null, bun: null }[manager];

    return {
      label,
      makedepends: () => [manager],
      depends: (o) => o.isElectron ? [] : [manager === "bun" ? "bun" : "nodejs"],
      arch: (o) => o.isElectron ? ["x86_64"] : ["any"],
      functions: (o) => {
        const entry = o.entry.replace(/^\.\//, "");
        const pkg: string[] = [];
        if (o.isElectron) {
          pkg.push(
            "# This is an Electron app. Consider installing its packaged build (electron-builder or Forge output)",
            "# into /opt/$pkgname with a wrapper in /usr/bin instead of the sources below.",
          );
        }
        if (prune) pkg.push(prune);
        pkg.push(
          `install -d "$pkgdir/usr/lib/$pkgname"`,
          `cp -r --no-preserve=ownership . "$pkgdir/usr/lib/$pkgname/"`,
        );
        if (o.kind === SourceKind.Git) pkg.push(`rm -rf "$pkgdir/usr/lib/$pkgname/.git"`);
        if (entry) {
          pkg.push(
            `chmod 755 "$pkgdir/usr/lib/$pkgname/${entry}"`,
            `install -d "$pkgdir/usr/bin"`,
            `ln -s "/usr/lib/$pkgname/${entry}" "$pkgdir/usr/bin/${o.executable}"`,
          );
        }
        else {
          pkg.push(`# TODO: add a launcher for ${o.executable} in "$pkgdir/usr/bin"`);
        }
        return {
          prepare: [install],
          build: o.hasBuildScript ? [`${manager} run build`] : undefined,
          package: pkg,
        };
      },
    };
  }

  export const BUILD_SYSTEMS: Record<BuildSystem, BuildSystemTemplate> = {
    [BuildSystem.Custom]: {
      label: "Other / custom",
      makedepends: () => [],
      depends: () => [],
      arch: () => ["x86_64"],
      functions: (o) => ({
        build: ["# TODO: build the project"],
        package: [
          `# TODO: install the files into "$pkgdir", for example:`,
          `# install -Dm755 ${o.executable || "binary"} "$pkgdir/usr/bin/${o.executable || "binary"}"`,
        ],
      }),
    },
    [BuildSystem.Npm]: nodeTemplate("Node.js (npm)", "npm"),
    [BuildSystem.Pnpm]: nodeTemplate("Node.js (pnpm)", "pnpm"),
    [BuildSystem.Yarn]: nodeTemplate("Node.js (yarn)", "yarn"),
    [BuildSystem.Bun]: nodeTemplate("Bun", "bun"),
    [BuildSystem.Deno]: {
      label: "Deno (deno compile)",
      makedepends: () => ["deno"],
      depends: () => [],
      arch: () => ["x86_64"],
      // Stripping breaks compiled Deno binaries
      options: ["!strip"],
      functions: (o) => ({
        build: [
          `export DENO_DIR="$srcdir/deno-cache"`,
          `deno compile --allow-all --output "${o.executable}" "${o.entry || "main.ts"}"`,
        ],
        package: installBinary(o),
      }),
    },
    [BuildSystem.Go]: {
      label: "Go",
      makedepends: () => ["go"],
      depends: () => [],
      arch: () => ["x86_64", "aarch64"],
      functions: (o) => ({
        build: [
          `export CGO_CPPFLAGS="$CPPFLAGS"`,
          `export CGO_CFLAGS="$CFLAGS"`,
          `export CGO_CXXFLAGS="$CXXFLAGS"`,
          `export CGO_LDFLAGS="$LDFLAGS"`,
          `export GOFLAGS="-buildmode=pie -trimpath -ldflags=-linkmode=external -mod=readonly -modcacherw"`,
          `go build -o "${o.executable}" ${o.entry || "."}`,
        ],
        package: installBinary(o),
      }),
    },
    [BuildSystem.Cargo]: {
      label: "Rust (cargo)",
      makedepends: () => ["cargo"],
      depends: () => ["gcc-libs", "glibc"],
      arch: () => ["x86_64", "aarch64"],
      functions: (o) => ({
        prepare: [
          "export RUSTUP_TOOLCHAIN=stable",
          `cargo fetch --locked --target "$(rustc -vV | sed -n 's/host: //p')"`,
        ],
        build: [
          "export RUSTUP_TOOLCHAIN=stable",
          "export CARGO_TARGET_DIR=target",
          "cargo build --frozen --release --all-features",
        ],
        check: [
          "export RUSTUP_TOOLCHAIN=stable",
          "cargo test --frozen --all-features",
        ],
        package: installBinary(o, `target/release/${o.executable}`),
      }),
    },
    [BuildSystem.Python]: {
      label: "Python (pyproject.toml)",
      makedepends: (o) => ["python-build", "python-installer", "python-wheel", o.pythonBackend ?? "python-setuptools"],
      depends: () => ["python"],
      arch: () => ["any"],
      functions: () => ({
        build: ["python -m build --wheel --no-isolation"],
        package: [`python -m installer --destdir="$pkgdir" dist/*.whl`],
      }),
    },
    [BuildSystem.Dart]: {
      label: "Dart (dart compile)",
      makedepends: () => ["dart"],
      depends: () => [],
      arch: () => ["x86_64"],
      // Stripping breaks compiled Dart executables
      options: ["!strip"],
      functions: (o) => ({
        prepare: ["dart pub get"],
        build: [`dart compile exe "${o.entry || `bin/${o.executable}.dart`}" -o "${o.executable}"`],
        package: installBinary(o),
      }),
    },
    [BuildSystem.Make]: {
      label: "Make",
      makedepends: () => [],
      depends: () => [],
      arch: () => ["x86_64"],
      functions: () => ({
        build: ["make"],
        package: [`make DESTDIR="$pkgdir" PREFIX=/usr install`],
      }),
    },
    [BuildSystem.CMake]: {
      label: "CMake",
      makedepends: () => ["cmake"],
      depends: () => [],
      arch: () => ["x86_64"],
      functions: () => ({
        build: [
          "cmake -B build -S . -DCMAKE_BUILD_TYPE=None -DCMAKE_INSTALL_PREFIX=/usr -Wno-dev",
          "cmake --build build",
        ],
        package: [`DESTDIR="$pkgdir" cmake --install build`],
      }),
    },
    [BuildSystem.Meson]: {
      label: "Meson",
      makedepends: () => ["meson"],
      depends: () => [],
      arch: () => ["x86_64"],
      functions: () => ({
        build: [
          "arch-meson . build",
          "meson compile -C build",
        ],
        package: [`meson install -C build --destdir "$pkgdir"`],
      }),
    },
  };

  /**
   * The default `source` entry for a package.
   * @param repository Repository to download from. When it's the same as `url`, the entry uses `$url`.
   * @param tagPrefix What release tags start with, usually `v`.
   */
  export function defaultSource(kind: SourceKind, url: string, repository: string, tagPrefix: string): string {
    const from = repository || url;
    const base = !from ? "https://example.com/project" : from === url ? "$url" : from;
    if (kind === SourceKind.Git) return `$pkgname::git+${base}.git`;
    // GitHub, Codeberg and Gitea all serve tag tarballs at /archive/<tag>.tar.gz
    return `$pkgname-$pkgver.tar.gz::${base}/archive/${from.includes("github.com") ? "refs/tags/" : ""}${tagPrefix}$pkgver.tar.gz`;
  }

  /**
   * The default folder the sources extract to inside `$srcdir`.
   */
  export function defaultSrcDir(kind: SourceKind, repository: string, pkgname: string): string {
    if (kind === SourceKind.Git) return "$pkgname";
    // Tag tarballs extract to <repository name>-<version without the v>
    const repo = repository.replace(/\/$/, "").split("/").pop() ?? "";
    return !repo || repo === pkgname ? "$pkgname-$pkgver" : `${repo}-$pkgver`;
  }

  /**
   * Problems that would make the PKGBUILD invalid or unpublishable. Empty when everything is fine.
   */
  export function validate(o: Options): string[] {
    const errors: string[] = [];
    if (!/^[a-z0-9@_+][a-z0-9@._+-]*$/.test(o.pkgname)) errors.push("The name must be lowercase and only contain letters, digits and @._+- (not starting with - or .).");
    if (!o.pkgver) errors.push("Enter a version.");
    else if (/[-:/\s]/.test(o.pkgver)) errors.push("The version can't contain hyphens, colons, slashes or spaces.");
    if (!/^\d+(\.\d+)?$/.test(o.pkgrel)) errors.push("The release (pkgrel) must be a number, like 1.");
    if (!o.pkgdesc.trim()) errors.push("Enter a description.");
    if (o.arch.length === 0) errors.push("Enter at least one architecture, like x86_64 or any.");
    if (o.arch.includes("any") && o.arch.length > 1) errors.push("The architecture \"any\" can't be combined with others.");
    if (!o.source.trim()) errors.push("Enter a source.");
    if (o.kind === SourceKind.Git && !o.pkgname.endsWith("-git")) errors.push("Packages built from git should end with -git, per the AUR guidelines.");
    return errors;
  }

  function quote(value: string): string {
    return `"${value.replace(/[\\"`]/g, "\\$&")}"`;
  }

  function array(items: string[], quoteChar = "'"): string {
    return `(${items.map(i => `${quoteChar}${i}${quoteChar}`).join(" ")})`;
  }

  /**
   * Render the PKGBUILD text.
   */
  export function render(o: Options): string {
    const indent = "  ";
    const template = BUILD_SYSTEMS[o.buildSystem];
    const lines: string[] = [];

    if (o.maintainer.trim()) lines.push(`# Maintainer: ${o.maintainer.trim()}`);
    lines.push(
      `pkgname=${o.pkgname}`,
      `pkgver=${o.pkgver}`,
      `pkgrel=${o.pkgrel}`,
      // $ is escaped too, since the description is plain text
      `pkgdesc=${quote(o.pkgdesc.trim()).replace(/\$/g, "\\$")}`,
      `arch=${array(o.arch)}`,
    );
    if (o.url.trim()) lines.push(`url=${quote(o.url.trim())}`);
    if (o.license.trim()) lines.push(`license=${array([o.license.trim()])}`);
    if (o.depends.length) lines.push(`depends=${array(o.depends)}`);
    if (o.makedepends.length) lines.push(`makedepends=${array(o.makedepends)}`);
    if (o.kind === SourceKind.Git) {
      const base = o.pkgname.replace(/-git$/, "");
      lines.push(`provides=${array([base])}`, `conflicts=${array([base])}`);
    }
    if (template.options?.length) lines.push(`options=${array(template.options)}`);
    lines.push(`source=${array([o.source.trim()], "\"")}`, "sha256sums=('SKIP')");

    const fn = (name: string, body: string[]) => {
      lines.push("", `${name}() {`, `${indent}cd "${o.srcDir}"`, ...body.map(l => `${indent}${l}`), "}");
    };
    if (o.kind === SourceKind.Git && o.pkgverSource) fn("pkgver", VersionSource.pkgverBody(o.pkgverSource));

    const functions = template.functions(o);
    if (functions.prepare) fn("prepare", functions.prepare);
    if (functions.build) fn("build", functions.build);
    if (functions.check) fn("check", functions.check);
    const pkg = [...functions.package ?? []];
    if (o.licenseFile) pkg.push(`install -Dm644 "${o.licenseFile}" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"`);
    fn("package", pkg);

    return `${lines.join("\n")}\n`;
  }
}

export default PkgbuildTemplate;
