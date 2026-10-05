import type { ProviderMcpServer, ProviderMcpServerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mcpServerDisplayOrder,
  mcpServersNeedPolling,
  mcpSignInUrl,
  orderMcpServers,
  settleMcpSignIns,
  type McpSignIn,
} from "./McpServersDialog.logic";

function server(name: string, status: ProviderMcpServerStatus): ProviderMcpServer {
  return { name, status, managed: false, actions: [] };
}

function signIn(acceptsCallback = true): McpSignIn {
  return { url: "https://auth.example.com/authorize", acceptsCallback };
}

describe("settleMcpSignIns", () => {
  it("keeps a sign-in while its server still waits for it", () => {
    const signIns = new Map([["github", signIn()]]);
    expect(settleMcpSignIns(signIns, [server("github", "needs-auth")])).toBe(signIns);
    expect(settleMcpSignIns(signIns, [server("github", "pending")])).toBe(signIns);
    expect(settleMcpSignIns(signIns, [server("github", "failed")])).toBe(signIns);
  });

  it("ends a sign-in once its server connects, is disabled, or disappears", () => {
    const signIns = new Map([
      ["github", signIn()],
      ["linear", signIn()],
      ["sentry", signIn()],
      ["notion", signIn()],
    ]);
    const settled = settleMcpSignIns(signIns, [
      server("github", "connected"),
      server("sentry", "disabled"),
      server("notion", "needs-auth"),
    ]);
    expect([...settled.keys()]).toEqual(["notion"]);
  });
});

describe("mcpServersNeedPolling", () => {
  it("polls only while a server connects or a sign-in can finish on its own", () => {
    expect(mcpServersNeedPolling(null, new Map())).toBe(false);
    expect(mcpServersNeedPolling([server("github", "connected")], new Map())).toBe(false);
    expect(mcpServersNeedPolling([server("github", "needs-auth")], new Map())).toBe(false);
    expect(mcpServersNeedPolling([server("github", "pending")], new Map())).toBe(true);
    expect(
      mcpServersNeedPolling([server("github", "needs-auth")], new Map([["github", signIn()]])),
    ).toBe(true);
  });

  it("does not poll for a claude.ai connector sign-in, which finishes only on reconnect", () => {
    const servers = [server("claude.ai Gmail", "needs-auth"), server("github", "connected")];
    expect(mcpServersNeedPolling(servers, new Map([["claude.ai Gmail", signIn(false)]]))).toBe(
      false,
    );
  });
});

describe("mcpSignInUrl", () => {
  it("opens web pages only", () => {
    expect(mcpSignInUrl("https://claude.ai/api/organizations/org/mcp/start-auth/x")).toBe(
      "https://claude.ai/api/organizations/org/mcp/start-auth/x",
    );
    expect(mcpSignInUrl("http://localhost:4321/authorize?state=abc")).toBe(
      "http://localhost:4321/authorize?state=abc",
    );
    expect(mcpSignInUrl("javascript:alert(document.cookie)")).toBeNull();
    expect(mcpSignInUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(mcpSignInUrl("not a url")).toBeNull();
  });
});

describe("mcp server ordering", () => {
  it("lists servers that need the user first and keeps that order as statuses change", () => {
    const loaded = [
      server("playwright", "connected"),
      server("linear", "needs-auth"),
      server("figma", "failed"),
      server("notes", "disabled"),
      server("slack", "needs-auth"),
    ];
    const order = mcpServerDisplayOrder(loaded);
    expect(order).toEqual(["linear", "slack", "figma", "playwright", "notes"]);

    const afterSignIn = [
      server("playwright", "connected"),
      server("linear", "connected"),
      server("figma", "failed"),
      server("notes", "disabled"),
      server("slack", "needs-auth"),
      server("github", "needs-auth"),
    ];
    expect(orderMcpServers(afterSignIn, order).map((entry) => entry.name)).toEqual([
      "linear",
      "slack",
      "figma",
      "playwright",
      "notes",
      "github",
    ]);
  });
});
