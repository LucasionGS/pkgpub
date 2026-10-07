/**
 * Parser for `.SRCINFO` files, as printed by `makepkg --printsrcinfo`.
 */
export namespace SrcInfo {
  export interface Data {
    pkgbase: string;
    pkgnames: string[];
    pkgver: string;
    pkgrel: string;
    epoch: string | null;
    /**
     * Every `source` entry, including architecture specific ones (`source_x86_64`) and those of split packages.
     */
    sources: string[];
    /**
     * Every file referenced by an `install` or `changelog` field.
     */
    extraFiles: string[];
    makedepends: string[];
    /**
     * The `.SRCINFO` text itself.
     */
    text: string;
  }

  /**
   * Parse the text of a `.SRCINFO` file.
   * @throws When the text has no `pkgbase` section.
   */
  export function parse(text: string): Data {
    // Example:
    // pkgbase = toxen3
    // 	pkgver = 2.12.2
    // 	source = toxen3-2.12.2.tar.gz::https://github.com/...
    //
    // pkgname = toxen3
    const data: Data = {
      pkgbase: "",
      pkgnames: [],
      pkgver: "",
      pkgrel: "",
      epoch: null,
      sources: [],
      extraFiles: [],
      makedepends: [],
      text,
    };
    let inBase = false;

    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const match = line.match(/^([\w-]+) = (.*)$/);
      if (!match) continue;
      const [, key, value] = match;

      if (key === "pkgbase") {
        data.pkgbase = value;
        inBase = true;
      }
      else if (key === "pkgname") {
        data.pkgnames.push(value);
        inBase = false;
      }
      else if (key === "pkgver" && inBase) {
        data.pkgver = value;
      }
      else if (key === "pkgrel" && inBase) {
        data.pkgrel = value;
      }
      else if (key === "epoch" && inBase) {
        data.epoch = value;
      }
      else if (key === "source" || key.startsWith("source_")) {
        if (!data.sources.includes(value)) data.sources.push(value);
      }
      else if (key === "install" || key === "changelog") {
        if (!data.extraFiles.includes(value)) data.extraFiles.push(value);
      }
      else if (key === "makedepends" || key.startsWith("makedepends_")) {
        data.makedepends.push(value);
      }
    }

    if (!data.pkgbase) throw new Error("The .SRCINFO has no pkgbase. Make sure the PKGBUILD sets `pkgname`.");
    return data;
  }

  /**
   * The full version string, `[epoch:]pkgver-pkgrel`.
   */
  export function fullVersion(data: Pick<Data, "epoch" | "pkgver" | "pkgrel">): string {
    return `${data.epoch ? `${data.epoch}:` : ""}${data.pkgver}-${data.pkgrel}`;
  }

  /**
   * The protocol of a source entry, mirroring makepkg's `get_protocol`. Local files return `"local"`.
   */
  export function getProtocol(source: string): string {
    if (source.includes("://")) {
      const url = source.includes("::") ? source.slice(source.indexOf("::") + 2) : source;
      return url.slice(0, url.indexOf("://")).split("+")[0];
    }
    return "local";
  }

  /**
   * The file or folder name makepkg uses for a source entry, mirroring makepkg's `get_filename`.
   */
  export function getFilename(source: string): string {
    if (source.includes("::")) return source.slice(0, source.indexOf("::"));
    const protocol = getProtocol(source);
    if (["git", "hg", "svn", "bzr", "fossil"].includes(protocol)) {
      let name = source.split("#")[0].split("?")[0].replace(/\/$/, "");
      name = name.slice(name.lastIndexOf("/") + 1);
      if (protocol === "git") name = name.replace(/\.git.*$/, "");
      if (protocol === "fossil") name += ".fossil";
      return name;
    }
    return source.slice(source.lastIndexOf("/") + 1);
  }

  /**
   * Whether a source entry is checked out from a version control system.
   */
  export function isVcs(source: string): boolean {
    return ["git", "hg", "svn", "bzr", "fossil"].includes(getProtocol(source));
  }
}

export default SrcInfo;
