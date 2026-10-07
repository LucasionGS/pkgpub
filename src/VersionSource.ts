import fsp from "node:fs/promises";
import Path from "node:path";
import type Pkgbuild from "./objects/Pkgbuild";
import { exists, run } from "./Utilities";

/**
 * Where a package's version comes from. Used both to fill in `pkgver=` before publishing, and to generate a
 * `pkgver()` function that computes it during the build.
 */
export namespace VersionSource {
  export type Type = "package.json" | "deno.json" | "ipm-package.yaml" | "Cargo.toml" | "git-tag" | "git-revision" | "command";

  /**
   * A version source as stored in `.pkgpub/config.json`.
   */
  export interface Config {
    type: Type;
    /**
     * Version file to read. Relative to the workspace folder when setting `pkgver=`, or to `srcDir` inside a
     * generated `pkgver()`.
     */
    path?: string;
    /**
     * Shell command that prints the version, for the `command` type.
     */
    command?: string;
    /**
     * `pkgver()` only: append the git revision count and commit (`1.2.0.r42.abc1234`), for `-git` packages.
     */
    appendRevision?: boolean;
    /**
     * `pkgver()` only: folder inside `$srcdir` the function runs in.
     */
    srcDir?: string;
  }

  export interface Detected {
    config: Config;
    version: string;
  }

  interface FileType {
    /**
     * Read the version from the file's text.
     */
    read(text: string): string | null;
    /**
     * Shell pipeline that prints the version of the file at `path`, for use inside `pkgver()`.
     */
    shell(path: string): string;
  }

  const JSON_VERSION: FileType = {
    read: (text) => {
      try {
        const version = JSON.parse(text).version;
        return typeof version === "string" ? version : null;
      } catch {
        // deno.json may be JSONC; the top-level version is still on its own line
        return text.match(/^\s*"version"\s*:\s*"([^"]+)"/m)?.[1] ?? null;
      }
    },
    shell: (path) => `sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\\1/p' "${path}" | head -n1`,
  };

  /**
   * Version files pkgpub knows how to read.
   */
  export const FILE_TYPES: Record<string, FileType> = {
    "package.json": JSON_VERSION,
    "deno.json": JSON_VERSION,
    "ipm-package.yaml": {
      read: (text) => text.match(/^version:\s*["']?([^"'\s]+)/m)?.[1] ?? null,
      shell: (path) => `sed -nE "s/^version:[[:space:]]*[\\"']?([^\\"' ]+).*/\\1/p" "${path}" | head -n1`,
    },
    "Cargo.toml": {
      read: (text) => text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1] ?? null,
      shell: (path) => `sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\\1/p' "${path}" | head -n1`,
    },
  };

  /**
   * Human readable name of a source.
   */
  export function describe(config: Config): string {
    switch (config.type) {
      case "git-tag": return "latest git tag";
      case "git-revision": return "git revision count";
      case "command": return `command \`${config.command ?? ""}\``;
      default: return config.path ?? config.type;
    }
  }

  /**
   * Turn a version from a project file or tag into a valid `pkgver`, which can't contain `-`, `:`, `/` or spaces.
   * @example toPkgver("v2.0.0-alpha.1") // "2.0.0_alpha.1"
   */
  export function toPkgver(version: string): string {
    return version.trim().replace(/^v(?=\d)/, "").replace(/[-:/\s]/g, "_");
  }

  /**
   * Find the version sources available to a PKGBUILD: version files in its folder and every parent folder up to
   * the workspace root, plus the latest git tag.
   */
  export async function detect(pkgbuild: Pkgbuild): Promise<Detected[]> {
    const found: Detected[] = [];
    let dir = pkgbuild.dir;
    while (true) {
      for (const type of Object.keys(FILE_TYPES) as Type[]) {
        const file = Path.join(dir, type);
        if (!await exists(file)) continue;
        const config: Config = { type, path: Path.relative(pkgbuild.workspaceRoot, file).split(Path.sep).join("/") };
        const version = await read(config, pkgbuild);
        if (version) found.push({ config, version });
      }
      if (dir === pkgbuild.workspaceRoot || !dir.startsWith(pkgbuild.workspaceRoot)) break;
      dir = Path.dirname(dir);
    }

    const tag = await read({ type: "git-tag" }, pkgbuild);
    if (tag) found.push({ config: { type: "git-tag" }, version: tag });
    return found;
  }

  /**
   * Read the current version from a source in the project, or `null` if it has none.
   */
  export async function read(config: Config, pkgbuild: Pkgbuild): Promise<string | null> {
    const fileType = FILE_TYPES[config.type];
    if (fileType) {
      if (!config.path) return null;
      const text = await fsp.readFile(Path.join(pkgbuild.workspaceRoot, config.path), "utf8").catch(() => null);
      return text === null ? null : fileType.read(text);
    }

    if (config.type === "git-tag") {
      const result = await run("git", ["describe", "--tags", "--abbrev=0"], { cwd: pkgbuild.dir, quiet: true });
      return result.code === 0 ? result.stdout.trim() || null : null;
    }
    if (config.type === "git-revision") {
      const count = await run("git", ["rev-list", "--count", "HEAD"], { cwd: pkgbuild.dir, quiet: true });
      const hash = await run("git", ["rev-parse", "--short=7", "HEAD"], { cwd: pkgbuild.dir, quiet: true });
      return count.code === 0 && hash.code === 0 ? `r${count.stdout.trim()}.${hash.stdout.trim()}` : null;
    }
    if (config.type === "command" && config.command) {
      const result = await run("bash", ["-c", config.command], { cwd: pkgbuild.workspaceRoot });
      return result.code === 0 ? result.stdout.trim() || null : null;
    }
    return null;
  }

  /**
   * Lines of a `pkgver()` function body (after the `cd` into `srcDir`) that print the version from a source.
   */
  export function pkgverBody(config: Config): string[] {
    const revision = `"$(git rev-list --count HEAD)" "$(git rev-parse --short=7 HEAD)"`;
    const fileType = FILE_TYPES[config.type];
    if (fileType) {
      const version = `${fileType.shell(config.path ?? config.type)} | tr - _`;
      return config.appendRevision
        ? [`printf "%s.r%s.%s" "$(${version})" ${revision}`]
        : [version];
    }

    switch (config.type) {
      case "git-tag": return ["git describe --long --tags --abbrev=7 | sed 's/^v//;s/\\([^-]*-g\\)/r\\1/;s/-/./g'"];
      case "git-revision": return [`printf "r%s.%s" ${revision}`];
      case "command": return [config.command ?? "echo 0"];
    }
    return [];
  }

  /**
   * Whether the generated `pkgver()` runs git, so `git` must be in `makedepends`.
   */
  export function needsGit(config: Config): boolean {
    return config.type === "git-tag" || config.type === "git-revision" || !!config.appendRevision;
  }
}

export default VersionSource;
