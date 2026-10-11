import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Commands for the MCP servers of a thread's live provider session. They have their own lanes
 * rather than the thread command scheduler, where they would wait behind a running turn.
 */
export function createProviderMcpEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    // A list asked for while another is in flight runs again once that settles, so a caller never
    // gets a snapshot taken before its own request.
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:mcp-list",
      tag: WS_METHODS.providerMcpList,
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:mcp-action",
      tag: WS_METHODS.providerMcpAction,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.serverName]),
      },
    }),
  };
}
