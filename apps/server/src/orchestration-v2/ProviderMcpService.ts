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

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

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
  /** What was asked of the agent, such as `list its MCP servers`. */
  readonly request: string;
}

// Details reach the user verbatim, so they name the server and the step that
// failed but never carry provider output, which may echo OAuth codes or URLs.
function fromAdapterError(
  error: ProviderAdapter.ProviderAdapterMcpError,
  context: FailureContext,
): ProviderMcpError {
  const { threadId, serverName } = context;
  const name = displayName(error.driver);
  switch (error.reason) {
    case "session-not-running":
      return notRunning(threadId, error.driver);
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
    case "unsupported": {
      const cli = name === undefined ? "the agent's CLI" : `the ${name} CLI`;
      return new ProviderMcpError({
        threadId,
        reason: "unsupported",
        detail: `This version of ${cli} cannot ${context.request} from T3 Code. Update it, then restart the agent session.`,
      });
    }
    case "provider-failure":
      return new ProviderMcpError({
        threadId,
        reason: "provider-failure",
        detail: `${name ?? "The agent"} could not ${context.request}.`,
      });
  }
}

type ProviderMcpRequestError =
  | ProjectionStore.ProjectionStoreV2Error
  | ProviderSessionManager.ProviderSessionManagerV2Error
  | ProviderAdapter.ProviderAdapterMcpError
  | ProviderMcpError;

// Every upstream tag is listed so a new one fails to compile instead of
// reaching the user under the wrong reason.
function failWith(context: FailureContext) {
  const logContext = {
    threadId: context.threadId,
    serverName: context.serverName,
    action: context.action,
  };
  // T3's own projection or session bookkeeping failed, not the agent.
  const internal = (
    cause:
      | ProjectionStore.ProjectionStoreV2Error
      | ProviderSessionManager.ProviderSessionManagerV2Error,
  ) =>
    Effect.logError("T3 could not resolve the session for an MCP request", {
      ...logContext,
      cause,
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderMcpError({
            threadId: context.threadId,
            reason: "internal",
            detail: "T3 Code could not read this thread's session state.",
          }),
        ),
      ),
    );
  return <A, R>(
    effect: Effect.Effect<A, ProviderMcpRequestError, R>,
  ): Effect.Effect<A, ProviderMcpError, R> =>
    Effect.catchTags(effect, {
      ProjectionStoreThreadNotFoundError: () =>
        Effect.fail(
          new ProviderMcpError({
            threadId: context.threadId,
            reason: "thread-not-found",
            detail: "This thread no longer exists.",
          }),
        ),
      ProjectionStoreReadError: internal,
      ProjectionStoreSetupError: internal,
      ProjectionStoreApplyEventError: internal,
      ProviderSessionOpenError: internal,
      ProviderWorkspaceMissingError: internal,
      ProviderSessionLookupError: internal,
      ProviderSessionCloseError: internal,
      ProviderSessionReleaseError: internal,
      ProviderSessionActivityError: internal,
      ProviderAdapterMcpError: (cause) => {
        const error = fromAdapterError(cause, context);
        const log =
          error.reason === "provider-failure"
            ? Effect.logWarning("provider MCP request failed", { ...logContext, cause })
            : Effect.void;
        return log.pipe(Effect.andThen(Effect.fail(error)));
      },
    });
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

  return ProviderMcpService.of({
    list: (input) =>
      Effect.gen(function* () {
        const { providerThread, controls } = yield* liveControls(input.threadId);
        return { servers: yield* controls.list({ providerThread }) };
      }).pipe(failWith({ threadId: input.threadId, request: "list its MCP servers" })),
    act: (input) =>
      Effect.gen(function* () {
        const { providerThread, controls } = yield* liveControls(input.threadId);
        return yield* controls.act({ ...input, providerThread });
      }).pipe(
        failWith({
          threadId: input.threadId,
          serverName: input.serverName,
          action: input.action,
          request: `${ACTION_PHRASES[input.action]} "${input.serverName}"`,
        }),
      ),
  });
});

export const layer = Layer.effect(ProviderMcpService, make);
