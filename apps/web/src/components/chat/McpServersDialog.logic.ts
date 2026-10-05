import type { ProviderMcpServer, ProviderMcpServerStatus } from "@t3tools/contracts";

/** A sign-in the user is finishing in a browser, keyed by server name. */
export interface McpSignIn {
  readonly url: string;
  /** The final redirect can be pasted back for a browser that cannot reach the server host. */
  readonly acceptsCallback: boolean;
  /** The server's status when the sign-in started; only a change away from it can finish it. */
  readonly fromStatus: ProviderMcpServerStatus;
}

/** Drops sign-ins whose server has since connected, been disabled, or gone away. */
export function settleMcpSignIns(
  signIns: ReadonlyMap<string, McpSignIn>,
  servers: ReadonlyArray<ProviderMcpServer>,
): ReadonlyMap<string, McpSignIn> {
  const next = new Map(signIns);
  for (const [name, signIn] of signIns) {
    const server = servers.find((candidate) => candidate.name === name);
    if (
      server === undefined ||
      (server.status !== signIn.fromStatus &&
        (server.status === "connected" || server.status === "disabled"))
    ) {
      next.delete(name);
    }
  }
  return next.size === signIns.size ? signIns : next;
}

/** Status only changes without a request from this dialog while a server connects or signs in. */
export function mcpServersNeedPolling(
  servers: ReadonlyArray<ProviderMcpServer> | null,
  signIns: ReadonlyMap<string, McpSignIn>,
): boolean {
  return signIns.size > 0 || (servers?.some((server) => server.status === "pending") ?? false);
}

/**
 * The sign-in page to open, or null for anything but a web page. The URL comes from the MCP
 * server's own OAuth metadata, and a tab reserved by the web build shares this app's origin.
 */
export function mcpSignInUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
