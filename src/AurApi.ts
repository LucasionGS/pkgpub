import Settings from "./Settings";

/**
 * Client for the public AUR RPC interface.
 */
export namespace AurApi {
  export interface PackageInfo {
    ID: number;
    Name: string;
    PackageBase: string;
    Version: string;
    Description: string | null;
    Maintainer: string | null;
    CoMaintainers?: string[];
    NumVotes: number;
    Popularity: number;
    OutOfDate: number | null;
    LastModified: number;
  }

  interface InfoResponse {
    resultcount: number;
    results: PackageInfo[];
    type: string;
    error?: string;
  }

  /**
   * Look up packages by name. Packages that don't exist on the AUR are left out of the result.
   */
  export async function info(names: string[]): Promise<PackageInfo[]> {
    if (names.length === 0) return [];
    const query = names.map(n => `arg[]=${encodeURIComponent(n)}`).join("&");
    const res = await fetch(`https://${Settings.AUR_HOST}/rpc/v5/info?${query}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`The AUR RPC returned ${res.status} - ${res.statusText}`);

    const body = await res.json() as InfoResponse;
    if (body.type === "error") throw new Error(`The AUR RPC returned an error: ${body.error}`);
    return body.results;
  }

  /**
   * Web page of a package base.
   */
  export function pageUrl(pkgbase: string): string {
    return `https://${Settings.AUR_HOST}/pkgbase/${encodeURIComponent(pkgbase)}`;
  }
}

export default AurApi;
