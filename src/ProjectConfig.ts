import fsp from "node:fs/promises";
import Path from "node:path";
import type Pkgbuild from "./objects/Pkgbuild";
import type VersionSource from "./VersionSource";

/**
 * Per-project pkgpub settings, stored in `.pkgpub/config.json` at the workspace folder root so they can be
 * committed with the project.
 */
export namespace ProjectConfig {
  export interface PackageConfig {
    /**
     * Where the version comes from. Remembered from the last "Set Version" or "Generate pkgver()".
     */
    versionSource?: VersionSource.Config;
    /**
     * Extra files next to the PKGBUILD to publish, like `.gitignore` or `LICENSE`. Local sources, install
     * scripts and changelogs are always published.
     */
    extraFiles?: string[];
    /**
     * AUR commit message for this package. `{version}` and `{pkgbase}` are replaced.
     */
    commitMessage?: string;
  }

  export interface Data {
    /**
     * Package settings keyed by the PKGBUILD's path relative to the workspace folder.
     */
    packages?: Record<string, PackageConfig>;
  }

  export function path(workspaceRoot: string): string {
    return Path.join(workspaceRoot, ".pkgpub", "config.json");
  }

  /**
   * Read a workspace folder's config. A missing file gives an empty config.
   * @throws When the file isn't valid JSON.
   */
  export async function load(workspaceRoot: string): Promise<Data> {
    const file = path(workspaceRoot);
    const text = await fsp.readFile(file, "utf8").catch(() => null);
    if (text === null) return {};
    try {
      return JSON.parse(text) as Data;
    } catch (error) {
      throw new Error(`${file} is not valid JSON. Fix or delete it. ${error instanceof Error ? error.message : ""}`);
    }
  }

  /**
   * Settings for one PKGBUILD.
   */
  export async function getPackage(pkgbuild: Pkgbuild): Promise<PackageConfig> {
    const data = await load(pkgbuild.workspaceRoot);
    return data.packages?.[pkgbuild.relativePath] ?? {};
  }

  /**
   * Merge settings into a PKGBUILD's entry and write the config file, creating `.pkgpub/` if needed.
   */
  export async function updatePackage(pkgbuild: Pkgbuild, patch: Partial<PackageConfig>) {
    const data = await load(pkgbuild.workspaceRoot);
    data.packages ??= {};
    data.packages[pkgbuild.relativePath] = { ...data.packages[pkgbuild.relativePath], ...patch };

    const file = path(pkgbuild.workspaceRoot);
    await fsp.mkdir(Path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

export default ProjectConfig;
