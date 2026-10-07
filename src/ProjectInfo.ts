import fsp from "node:fs/promises";
import Path from "node:path";
import PkgbuildTemplate from "./PkgbuildTemplate";
import { exists, run } from "./Utilities";

/**
 * Reads what a project already says about itself (manifests, license file, git), to pre-fill a new PKGBUILD.
 */
export namespace ProjectInfo {
  export interface Data {
    name?: string;
    version?: string;
    description?: string;
    url?: string;
    /**
     * Web URL of the source repository, which release tarballs and git sources come from. Can differ from `url`
     * when the project has its own homepage.
     */
    repository?: string;
    /**
     * SPDX license identifier.
     */
    license?: string;
    /**
     * `Name <email>` from the git config.
     */
    maintainer?: string;
    buildSystem: PkgbuildTemplate.BuildSystem;
    /**
     * Name of the installed command.
     */
    executable?: string;
    /**
     * Build system specific entry point: the `bin` script of a Node package, the main module of a Deno project,
     * the Dart file to compile, or the Go package path.
     */
    entry?: string;
    /**
     * License file name in the project root, like `LICENSE`.
     */
    licenseFile?: string;
    /**
     * Whether the latest git tag starts with `v`, which decides the release tarball URL.
     */
    tagPrefix: string;
    hasTags: boolean;
    hasBuildScript: boolean;
    isElectron: boolean;
    /**
     * Python build backend package, like `python-setuptools`.
     */
    pythonBackend?: string;
    /**
     * Where each field was found, keyed by field name, for showing next to the form fields.
     */
    hints: Record<string, string>;
  }

  /**
   * Inspect a project folder.
   */
  export async function detect(dir: string): Promise<Data> {
    const data: Data = { buildSystem: PkgbuildTemplate.BuildSystem.Custom, tagPrefix: "v", hasTags: false, hasBuildScript: false, isElectron: false, hints: {} };
    const read = (name: string) => fsp.readFile(Path.join(dir, name), "utf8").catch(() => null);
    const set = <K extends keyof Data>(key: K, value: Data[K] | undefined | null, source: string) => {
      if (value === undefined || value === null || value === "" || data[key] !== undefined) return;
      data[key] = value;
      data.hints[key] = source;
    };
    let buildSystemFound = false;
    const setBuildSystem = (system: PkgbuildTemplate.BuildSystem, source: string) => {
      if (buildSystemFound) return;
      buildSystemFound = true;
      data.buildSystem = system;
      data.hints.buildSystem = source;
    };

    // Manifests, most specific first
    const cargo = await read("Cargo.toml");
    if (cargo) {
      const toml = parseToml(cargo);
      const pkg = toml["package"] ?? {};
      set("name", pkg.name, "Cargo.toml");
      set("version", pkg.version, "Cargo.toml");
      set("description", pkg.description, "Cargo.toml");
      set("license", pkg.license, "Cargo.toml");
      set("url", pkg.homepage ?? pkg.repository, "Cargo.toml");
      set("repository", pkg.repository, "Cargo.toml");
      set("executable", toml["bin"]?.name ?? pkg.name, "Cargo.toml");
      setBuildSystem(PkgbuildTemplate.BuildSystem.Cargo, "Cargo.toml");
    }

    const goMod = await read("go.mod");
    if (goMod) {
      // Example: module github.com/LucasionGS/hue-cli
      const module = goMod.match(/^module\s+(\S+)/m)?.[1];
      if (module) {
        const name = module.split("/").pop()!;
        set("name", name, "go.mod");
        if (/^(github\.com|gitlab\.com|codeberg\.org)\//.test(module)) {
          set("url", `https://${module}`, "go.mod");
          set("repository", `https://${module}`, "go.mod");
        }
        // Go projects with cmd/<binary>/main.go build that package
        const cmds = await fsp.readdir(Path.join(dir, "cmd"), { withFileTypes: true }).catch(() => []);
        const cmdDirs = cmds.filter(d => d.isDirectory()).map(d => d.name);
        const cmd = cmdDirs.includes(name) ? name : cmdDirs.length === 1 ? cmdDirs[0] : null;
        set("executable", cmd ?? name, cmd ? `cmd/${cmd}` : "go.mod");
        set("entry", cmd ? `./cmd/${cmd}` : ".", cmd ? `cmd/${cmd}` : "go.mod");
      }
      setBuildSystem(PkgbuildTemplate.BuildSystem.Go, "go.mod");
    }

    const pubspec = await read("pubspec.yaml");
    if (pubspec) {
      const yaml = parseYaml(pubspec);
      set("name", yaml.name, "pubspec.yaml");
      set("version", yaml.version, "pubspec.yaml");
      set("description", yaml.description, "pubspec.yaml");
      set("url", yaml.homepage ?? yaml.repository, "pubspec.yaml");
      set("repository", yaml.repository, "pubspec.yaml");
      const bins = await fsp.readdir(Path.join(dir, "bin")).catch(() => [] as string[]);
      const main = bins.find(b => b === `${yaml.name}.dart`) ?? bins.find(b => b.endsWith(".dart"));
      if (main) {
        set("executable", main.replace(/\.dart$/, ""), "bin/");
        set("entry", `bin/${main}`, "bin/");
      }
      setBuildSystem(PkgbuildTemplate.BuildSystem.Dart, "pubspec.yaml");
    }

    const denoName = await exists(Path.join(dir, "deno.json")) ? "deno.json" : await exists(Path.join(dir, "deno.jsonc")) ? "deno.jsonc" : null;
    if (denoName) {
      const deno = parseJson(await read(denoName));
      set("name", typeof deno.name === "string" ? deno.name.replace(/^@[^/]+\//, "") : undefined, denoName);
      set("version", deno.version, denoName);
      for (const entry of ["main.ts", "src/main.ts", "src/index.ts", "mod.ts", "index.ts"]) {
        if (await exists(Path.join(dir, entry))) {
          set("entry", entry, entry);
          break;
        }
      }
      setBuildSystem(PkgbuildTemplate.BuildSystem.Deno, denoName);
    }

    const packageJson = await read("package.json");
    if (packageJson) {
      const pkg = parseJson(packageJson);
      set("name", typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : undefined, "package.json");
      set("version", pkg.version, "package.json");
      set("description", pkg.description, "package.json");
      set("license", typeof pkg.license === "string" && pkg.license !== "UNLICENSED" ? pkg.license : undefined, "package.json");
      const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
      set("url", pkg.homepage ?? (repository ? normalizeGitUrl(repository) : undefined), "package.json");
      set("repository", repository ? normalizeGitUrl(repository) : undefined, "package.json");
      if (typeof pkg.bin === "string") {
        set("executable", pkg.name?.replace(/^@[^/]+\//, ""), "package.json bin");
        set("entry", pkg.bin, "package.json bin");
      }
      else if (pkg.bin && typeof pkg.bin === "object") {
        const [name, path] = Object.entries(pkg.bin)[0] as [string, string];
        set("executable", name, "package.json bin");
        set("entry", path, "package.json bin");
      }
      data.hasBuildScript = typeof pkg.scripts?.build === "string";
      data.isElectron = !!(pkg.dependencies?.electron ?? pkg.devDependencies?.electron);

      const manager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
      const system = manager === "pnpm" || await exists(Path.join(dir, "pnpm-lock.yaml")) ? PkgbuildTemplate.BuildSystem.Pnpm
        : manager === "yarn" || await exists(Path.join(dir, "yarn.lock")) ? PkgbuildTemplate.BuildSystem.Yarn
        : manager === "bun" || await exists(Path.join(dir, "bun.lockb")) || await exists(Path.join(dir, "bun.lock")) ? PkgbuildTemplate.BuildSystem.Bun
        : PkgbuildTemplate.BuildSystem.Npm;
      setBuildSystem(system, "package.json");
    }

    const pyproject = await read("pyproject.toml");
    if (pyproject) {
      const toml = parseToml(pyproject);
      const project = toml["project"] ?? {};
      set("name", project.name, "pyproject.toml");
      set("version", project.version, "pyproject.toml");
      set("description", project.description, "pyproject.toml");
      set("license", project.license, "pyproject.toml");
      const urls = toml["project.urls"] ?? {};
      set("url", urls.Homepage ?? urls.homepage ?? urls.Repository ?? urls.repository, "pyproject.toml");
      set("repository", urls.Repository ?? urls.repository ?? urls.Source, "pyproject.toml");
      const scripts = Object.keys(toml["project.scripts"] ?? {});
      if (scripts.length) set("executable", scripts[0], "pyproject.toml");
      const backend = toml["build-system"]?.["build-backend"] ?? "setuptools.build_meta";
      data.pythonBackend = backend.startsWith("hatchling") ? "python-hatchling"
        : backend.startsWith("poetry") ? "python-poetry-core"
        : backend.startsWith("flit") ? "python-flit-core"
        : backend.startsWith("pdm") ? "python-pdm-backend"
        : "python-setuptools";
      setBuildSystem(PkgbuildTemplate.BuildSystem.Python, "pyproject.toml");
    }

    const ipm = await read("ipm-package.yaml");
    if (ipm) {
      const yaml = parseYaml(ipm);
      set("name", yaml.name, "ipm-package.yaml");
      set("version", yaml.version, "ipm-package.yaml");
      set("description", yaml.description, "ipm-package.yaml");
    }

    if (await exists(Path.join(dir, "meson.build"))) setBuildSystem(PkgbuildTemplate.BuildSystem.Meson, "meson.build");
    if (await exists(Path.join(dir, "CMakeLists.txt"))) setBuildSystem(PkgbuildTemplate.BuildSystem.CMake, "CMakeLists.txt");
    if (await exists(Path.join(dir, "Makefile"))) setBuildSystem(PkgbuildTemplate.BuildSystem.Make, "Makefile");

    // License file
    for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "LICENCE"]) {
      const text = await read(name);
      if (text === null) continue;
      data.licenseFile = name;
      set("license", sniffLicense(text), name);
      break;
    }

    // Git
    const git = (...args: string[]) => run("git", args, { cwd: dir, quiet: true }).then(r => r.code === 0 ? r.stdout.trim() : "").catch(() => "");
    const remote = await git("remote", "get-url", "origin");
    if (remote) {
      // The actual remote beats whatever a manifest claims
      delete data.repository;
      set("repository", normalizeGitUrl(remote), "git remote");
      set("url", data.repository, "git remote");
    }
    const userName = await git("config", "user.name");
    const userEmail = await git("config", "user.email");
    if (userName) set("maintainer", userEmail ? `${userName} <${userEmail}>` : userName, "git config");
    const tag = await git("describe", "--tags", "--abbrev=0");
    data.hasTags = !!tag;
    data.tagPrefix = !tag || tag.startsWith("v") ? "v" : "";
    if (tag) set("version", tag.replace(/^v(?=\d)/, ""), "git tag");

    set("name", Path.basename(dir).toLowerCase(), "folder name");
    if (data.name) data.name = sanitizeName(data.name);
    set("executable", data.name, "package name");
    return data;
  }

  /**
   * Fill in a missing description and license from GitHub, when the project lives there.
   */
  export async function enrichFromGitHub(data: Data) {
    if (data.description && data.license) return;
    const repo = data.url?.match(/^https:\/\/github\.com\/([^/]+\/[^/#?]+)/)?.[1];
    if (!repo) return;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const body = await res.json() as { description?: string | null; license?: { spdx_id?: string } | null };
      if (!data.description && body.description) {
        data.description = body.description;
        data.hints.description = "GitHub";
      }
      const spdx = body.license?.spdx_id;
      if (!data.license && spdx && spdx !== "NOASSERTION") {
        data.license = spdx;
        data.hints.license = "GitHub";
      }
    } catch {
      // Offline or rate limited; the fields just stay empty
    }
  }

  /**
   * Turn a git remote into a web URL.
   * @example normalizeGitUrl("git@github.com:LucasionGS/podium.git") // "https://github.com/LucasionGS/podium"
   */
  export function normalizeGitUrl(remote: string): string {
    let url = remote.trim().replace(/^git\+/, "");
    const scp = url.match(/^[\w.-]+@([^:/]+):(.+)$/);
    if (scp) url = `https://${scp[1]}/${scp[2]}`;
    url = url.replace(/^ssh:\/\/[^@]+@/, "https://").replace(/^git:\/\//, "https://");
    return url.replace(/\.git$/, "").replace(/\/$/, "");
  }

  /**
   * Make a name valid for the AUR: lowercase, and only letters, digits and `@._+-`.
   */
  export function sanitizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9@._+-]+/g, "-").replace(/^[-.]+/, "");
  }

  /**
   * Guess the SPDX identifier of a license text.
   */
  export function sniffLicense(text: string): string | undefined {
    const head = text.slice(0, 3000);
    if (/MIT License|Permission is hereby granted, free of charge/i.test(head)) return "MIT";
    if (/Apache License/i.test(head) && /Version 2\.0/.test(head)) return "Apache-2.0";
    if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(head)) return "AGPL-3.0-or-later";
    if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(head)) return /Version 3/.test(head) ? "LGPL-3.0-or-later" : "LGPL-2.1-or-later";
    if (/GNU GENERAL PUBLIC LICENSE/i.test(head)) return /Version 3/.test(head) ? "GPL-3.0-or-later" : "GPL-2.0-or-later";
    if (/Mozilla Public License,? (Version )?2\.0/i.test(head)) return "MPL-2.0";
    if (/This is free and unencumbered software released into the public domain/i.test(head)) return "Unlicense";
    if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i.test(head)) {
      return /THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS/i.test(head) && !/copyright notice and this permission notice appear/i.test(head) ? "0BSD" : "ISC";
    }
    if (/Redistribution and use in source and binary forms/i.test(head)) {
      return /Neither the name/i.test(head) ? "BSD-3-Clause" : "BSD-2-Clause";
    }
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseJson(text: string | null): any {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // JSONC: drop comments and trailing commas, then try again
      try {
        return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1"));
      } catch {
        return {};
      }
    }
  }

  /**
   * Just enough TOML for manifests: string values and `{ text = "..." }` tables, grouped by `[section]`.
   */
  function parseToml(text: string): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};
    let section = "";
    for (const line of text.split("\n")) {
      const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
      if (header) {
        section = header[1].trim();
        // Only the first [[bin]] counts
        if (result[section] && line.trim().startsWith("[[")) section = `${section}#ignored`;
        result[section] ??= {};
        continue;
      }
      const pair = line.match(/^\s*([\w.-]+|"[^"]+")\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*text\s*=\s*"([^"]*)"\s*\})/);
      if (pair) {
        result[section] ??= {};
        result[section][pair[1].replace(/"/g, "")] = pair[2] ?? pair[3] ?? pair[4];
      }
    }
    return result;
  }

  /**
   * Just enough YAML for manifests: top-level `key: value` pairs.
   */
  function parseYaml(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const pair = line.match(/^([\w-]+):\s*(.+?)\s*$/);
      if (pair && !pair[2].startsWith("#")) result[pair[1]] = pair[2].replace(/^["'](.*)["']$/, "$1");
    }
    return result;
  }
}

export default ProjectInfo;
