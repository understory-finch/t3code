import type { ProviderMcpServer, ProviderMcpServerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mcpServersNeedPolling,
  mcpSignInUrl,
  settleMcpSignIns,
  type McpSignIn,
} from "./McpServersDialog.logic";

function server(name: string, status: ProviderMcpServerStatus): ProviderMcpServer {
  return { name, status, managed: false, actions: [] };
}

function signIn(fromStatus: ProviderMcpServerStatus): McpSignIn {
  return { url: "https://auth.example.com/authorize", acceptsCallback: true, fromStatus };
}

describe("settleMcpSignIns", () => {
  it("keeps a sign-in while its server still waits for it", () => {
    const signIns = new Map([["github", signIn("needs-auth")]]);
    expect(settleMcpSignIns(signIns, [server("github", "needs-auth")])).toBe(signIns);
    expect(settleMcpSignIns(signIns, [server("github", "pending")])).toBe(signIns);
    expect(settleMcpSignIns(signIns, [server("github", "failed")])).toBe(signIns);
  });

  it("ends a sign-in once its server connects, is disabled, or disappears", () => {
    const signIns = new Map([
      ["github", signIn("needs-auth")],
      ["linear", signIn("needs-auth")],
      ["sentry", signIn("failed")],
    ]);
    const settled = settleMcpSignIns(signIns, [
      server("github", "connected"),
      server("sentry", "disabled"),
    ]);
    expect([...settled.keys()]).toEqual([]);
  });

  it("does not end a re-authentication of a server that was already connected", () => {
    const signIns = new Map([["github", signIn("connected")]]);
    expect(settleMcpSignIns(signIns, [server("github", "connected")])).toBe(signIns);
  });
});

describe("mcpServersNeedPolling", () => {
  it("polls only while a server connects or a sign-in is open", () => {
    expect(mcpServersNeedPolling(null, new Map())).toBe(false);
    expect(mcpServersNeedPolling([server("github", "connected")], new Map())).toBe(false);
    expect(mcpServersNeedPolling([server("github", "needs-auth")], new Map())).toBe(false);
    expect(mcpServersNeedPolling([server("github", "pending")], new Map())).toBe(true);
    expect(
      mcpServersNeedPolling(
        [server("github", "needs-auth")],
        new Map([["github", signIn("needs-auth")]]),
      ),
    ).toBe(true);
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
