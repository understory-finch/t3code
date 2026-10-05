import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderMcpActionInput,
  type ProviderMcpActionResult,
  ProviderMcpError,
  type ProviderMcpListInput,
  type ProviderMcpListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const isProviderMcpError = Schema.is(ProviderMcpError);
const isProviderAdapterMcpError = Schema.is(ProviderAdapter.ProviderAdapterMcpError);
const isProjectionStoreThreadNotFoundError = Schema.is(
  ProjectionStore.ProjectionStoreThreadNotFoundError,
);

const ACTION_PHRASES: Record<ProviderMcpActionInput["action"], string> = {
  reconnect: "reconnect",
  enable: "enable",
  disable: "disable",
  authenticate: "start sign-in for",
  "clear-auth": "sign out of",
  "submit-oauth-callback": "finish sign-in for",
};

/**
 * The MCP servers of the provider process serving a thread right now. Agents
 * do not reach this through T3's MCP tools on purpose: turning servers off
 * mid-call or starting a browser sign-in needs a person.
 */
export class ProviderMcpService extends Context.Service<
  ProviderMcpService,
  {
    readonly list: (
      input: ProviderMcpListInput,
    ) => Effect.Effect<ProviderMcpListResult, ProviderMcpError>;
    readonly act: (
      input: ProviderMcpActionInput,
    ) => Effect.Effect<ProviderMcpActionResult, ProviderMcpError>;
  }
>()("t3/orchestration-v2/ProviderMcpService") {}

function displayName(driver: ProviderDriverKind | undefined): string | undefined {
  return driver === undefined ? undefined : PROVIDER_DISPLAY_NAMES[driver];
}

function notRunning(threadId: ThreadId, driver: ProviderDriverKind | undefined) {
  return new ProviderMcpError({
    threadId,
    reason: "session-not-running",
    detail: `${displayName(driver) ?? "The agent"} is not running for this thread. Send a message to start it, then try again.`,
  });
}

interface FailureContext {
  readonly threadId: ThreadId;
  readonly serverName?: string;
  readonly action?: ProviderMcpActionInput["action"];
  readonly failure: (provider: string) => string;
}

// Details reach the user verbatim, so they name the server and the step that
// failed but never carry provider output, which may echo OAuth codes or URLs.
function toProviderMcpError(cause: unknown, context: FailureContext): ProviderMcpError {
  const { threadId, serverName } = context;
  if (isProviderMcpError(cause)) return cause;
  if (isProjectionStoreThreadNotFoundError(cause)) {
    return new ProviderMcpError({
      threadId,
      reason: "thread-not-found",
      detail: "This thread no longer exists.",
    });
  }
  const adapterError = isProviderAdapterMcpError(cause) ? cause : undefined;
  switch (adapterError?.reason) {
    case "session-not-running":
      return notRunning(threadId, adapterError.driver);
    case "server-not-found":
      return new ProviderMcpError({
        threadId,
        reason: "server-not-found",
        detail: `This session has no MCP server named "${serverName}". Refresh the list and try again.`,
      });
    case "action-unavailable":
      return new ProviderMcpError({
        threadId,
        reason: "action-unavailable",
        detail: `"${serverName}" does not accept that action right now. Refresh the list and try again.`,
      });
    default:
      return new ProviderMcpError({
        threadId,
        reason: "provider-failure",
        detail: context.failure(displayName(adapterError?.driver) ?? "The agent"),
      });
  }
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const liveControls = Effect.fnUntraced(function* (threadId: ThreadId) {
    const projection = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    );
    if (providerThread === undefined || providerThread.providerSessionId === null) {
      return yield* notRunning(threadId, providerThread?.driver);
    }
    const runtime = Option.getOrUndefined(yield* sessions.get(providerThread.providerSessionId));
    if (runtime === undefined) {
      return yield* notRunning(threadId, providerThread.driver);
    }
    if (runtime.mcp === undefined) {
      return yield* new ProviderMcpError({
        threadId,
        reason: "unsupported",
        detail: `${displayName(runtime.driver) ?? "This provider"} does not support managing MCP servers from T3 Code.`,
      });
    }
    return { providerThread, controls: runtime.mcp };
  });

  const failWith =
    (context: FailureContext) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catch((cause) => {
          const error = toProviderMcpError(cause, context);
          const log =
            error.reason === "provider-failure"
              ? Effect.logWarning("provider MCP request failed", {
                  threadId: context.threadId,
                  serverName: context.serverName,
                  action: context.action,
                  cause,
                })
              : Effect.void;
          return log.pipe(Effect.andThen(Effect.fail(error)));
        }),
      );

  return ProviderMcpService.of({
    list: (input) =>
      Effect.gen(function* () {
        const { providerThread, controls } = yield* liveControls(input.threadId);
        return { servers: yield* controls.list({ providerThread }) };
      }).pipe(
        failWith({
          threadId: input.threadId,
          failure: (provider) => `${provider} could not list its MCP servers.`,
        }),
      ),
    act: (input) =>
      Effect.gen(function* () {
        const { providerThread, controls } = yield* liveControls(input.threadId);
        return yield* controls.act({ ...input, providerThread });
      }).pipe(
        failWith({
          threadId: input.threadId,
          serverName: input.serverName,
          action: input.action,
          failure: (provider) =>
            `${provider} could not ${ACTION_PHRASES[input.action]} "${input.serverName}".`,
        }),
      ),
  });
});

export const layer = Layer.effect(ProviderMcpService, make);
