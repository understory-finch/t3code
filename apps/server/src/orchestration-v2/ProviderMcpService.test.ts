import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type ProviderMcpActionInput,
  ProviderMcpError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderMcpService from "./ProviderMcpService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const threadId = ThreadId.make("thread-provider-mcp");
const providerSessionId = ProviderSessionId.make("provider-session-provider-mcp");
const claude = ProviderDriverKind.make("claudeAgent");
const providerThread = {
  id: ProviderThreadId.make("provider-thread-provider-mcp"),
  driver: claude,
  providerSessionId,
} as unknown as OrchestrationV2ProviderThread;

const encodeProviderMcpErrorsJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ProviderMcpError)),
);

function testLayer(input: {
  readonly providerThreads?: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly runtime?: Partial<ProviderAdapter.ProviderAdapterV2SessionRuntime>;
  readonly readFailure?: ProjectionStore.ProjectionStoreV2Error;
}) {
  return ProviderMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () =>
            input.readFailure === undefined
              ? Effect.succeed({
                  thread: { activeProviderThreadId: providerThread.id },
                  providerThreads: input.providerThreads ?? [providerThread],
                } as never)
              : Effect.fail(input.readFailure),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              input.runtime === undefined ? Option.none() : Option.some(input.runtime as never),
            ),
        }),
      ),
    ),
  );
}

const listError = (layer: ReturnType<typeof testLayer>) =>
  Effect.gen(function* () {
    const service = yield* ProviderMcpService.ProviderMcpService;
    return yield* service.list({ threadId }).pipe(Effect.flip);
  }).pipe(Effect.provide(layer));

it.effect("asks the user to start the agent when no live session serves the thread", () =>
  Effect.gen(function* () {
    const released = yield* listError(testLayer({}));
    assert.equal(released.reason, "session-not-running");
    assert.equal(
      released.detail,
      "Claude is not running for this thread. Send a message to start it, then try again.",
    );

    const neverStarted = yield* listError(testLayer({ providerThreads: [] }));
    assert.equal(neverStarted.reason, "session-not-running");
    assert.equal(
      neverStarted.detail,
      "The agent is not running for this thread. Send a message to start it, then try again.",
    );

    const missing = yield* listError(
      testLayer({
        readFailure: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
      }),
    );
    assert.equal(missing.reason, "thread-not-found");
  }),
);

it.effect("does not blame the agent when T3 cannot read the thread's state", () =>
  Effect.gen(function* () {
    const error = yield* listError(
      testLayer({ readFailure: new ProjectionStore.ProjectionStoreReadError({ threadId }) }),
    );
    assert.equal(error.reason, "internal");
    assert.equal(error.detail, "T3 Code could not read this thread's session state.");
  }),
);

it.effect("names a provider that cannot manage MCP servers", () =>
  Effect.gen(function* () {
    const error = yield* listError(
      testLayer({ runtime: { driver: ProviderDriverKind.make("codex") } }),
    );
    assert.equal(error.reason, "unsupported");
    assert.equal(error.detail, "Codex does not support managing MCP servers from T3 Code.");
  }),
);

it.effect("acts on the active provider thread and keeps provider output out of errors", () => {
  const callbackUrl = "http://localhost:4567/callback?code=secret-code&state=xyz";
  const received: Array<ProviderAdapter.ProviderAdapterV2McpActionInput> = [];
  const adapterReasons: Record<string, ProviderAdapter.ProviderAdapterMcpError["reason"]> = {
    linear: "provider-failure",
    notion: "unsupported",
  };
  const runtime: Partial<ProviderAdapter.ProviderAdapterV2SessionRuntime> = {
    driver: claude,
    mcp: {
      list: () => Effect.succeed([]),
      act: (actInput) =>
        Effect.sync(() => received.push(actInput)).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapter.ProviderAdapterMcpError({
                driver: claude,
                reason: adapterReasons[actInput.serverName] ?? "server-not-found",
                serverName: actInput.serverName,
                cause: new Error(`OAuth exchange failed for ${callbackUrl}`),
              }),
            ),
          ),
        ),
    },
  };
  const act = (input: ProviderMcpActionInput) =>
    Effect.gen(function* () {
      const service = yield* ProviderMcpService.ProviderMcpService;
      return yield* service.act(input).pipe(Effect.flip);
    }).pipe(Effect.provide(testLayer({ runtime })));

  return Effect.gen(function* () {
    const failed = yield* act({
      threadId,
      serverName: "linear",
      action: "submit-oauth-callback",
      callbackUrl,
    });
    assert.equal(failed.reason, "provider-failure");
    assert.equal(failed.detail, 'Claude could not finish sign-in for "linear".');
    assert.isUndefined(failed.cause);
    assert.equal(received[0]?.providerThread, providerThread);

    const outdated = yield* act({ threadId, serverName: "notion", action: "clear-auth" });
    assert.equal(outdated.reason, "unsupported");
    assert.equal(
      outdated.detail,
      'This version of the Claude CLI cannot sign out of "notion" from T3 Code. Update it, then restart the agent session.',
    );

    const missing = yield* act({ threadId, serverName: "gone", action: "reconnect" });
    assert.equal(missing.reason, "server-not-found");
    const wire = yield* encodeProviderMcpErrorsJson([failed, outdated, missing]);
    assert.notInclude(wire, "secret-code");
  });
});
