import type { ProviderMcpServer, ProviderMcpServerStatus } from "@t3tools/contracts";

const ATTENTION_RANK = {
  "needs-auth": 0,
  failed: 1,
  pending: 2,
  connected: 3,
  disabled: 4,
} as const satisfies Record<ProviderMcpServerStatus, number>;

/** Server names with the ones that need the user first, otherwise in the provider's order. */
export function mcpServerDisplayOrder(
  servers: ReadonlyArray<ProviderMcpServer>,
): ReadonlyArray<string> {
  return servers
    .map((server, index) => ({ server, index }))
    .toSorted(
      (a, b) =>
        ATTENTION_RANK[a.server.status] - ATTENTION_RANK[b.server.status] || a.index - b.index,
    )
    .map(({ server }) => server.name);
}

/**
 * Sorts by an order fixed when the list first loaded, so a row stays put while the user acts on
 * it. Servers that appeared later go last.
 */
export function orderMcpServers(
  servers: ReadonlyArray<ProviderMcpServer>,
  order: ReadonlyArray<string>,
): ReadonlyArray<ProviderMcpServer> {
  const position = new Map(order.map((name, index) => [name, index]));
  const rank = (server: ProviderMcpServer, index: number) =>
    position.get(server.name) ?? order.length + index;
  return servers
    .map((server, index) => ({ server, rank: rank(server, index) }))
    .toSorted((a, b) => a.rank - b.rank)
    .map(({ server }) => server);
}

/** A sign-in the user is finishing in a browser, keyed by server name. */
export interface McpSignIn {
  readonly url: string;
  /**
   * The provider listens for the final redirect, so the sign-in can finish without the user, and
   * the redirect can be pasted back for a browser that cannot reach the server host. Otherwise
   * (claude.ai connectors) it finishes only when the user reconnects.
   */
  readonly acceptsCallback: boolean;
}

/** Drops sign-ins whose server has since connected, been disabled, or gone away. */
export function settleMcpSignIns(
  signIns: ReadonlyMap<string, McpSignIn>,
  servers: ReadonlyArray<ProviderMcpServer>,
): ReadonlyMap<string, McpSignIn> {
  const next = new Map(signIns);
  for (const name of signIns.keys()) {
    const server = servers.find((candidate) => candidate.name === name);
    if (server === undefined || server.status === "connected" || server.status === "disabled") {
      next.delete(name);
    }
  }
  return next.size === signIns.size ? signIns : next;
}

/**
 * Status only changes without a request from this dialog while a server connects or a sign-in
 * the provider listens for completes.
 */
export function mcpServersNeedPolling(
  servers: ReadonlyArray<ProviderMcpServer> | null,
  signIns: ReadonlyMap<string, McpSignIn>,
): boolean {
  return (
    [...signIns.values()].some((signIn) => signIn.acceptsCallback) ||
    (servers?.some((server) => server.status === "pending") ?? false)
  );
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
