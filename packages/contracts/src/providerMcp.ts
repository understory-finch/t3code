import * as Schema from "effect/Schema";
import {
  ForwardCompatibleArray,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

// Names, sources and errors come from the user's provider configuration and
// the MCP servers themselves. Clients render them as plain text only.
const ProviderMcpServerName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const ProviderMcpServerStatus = Schema.Literals([
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
]);
export type ProviderMcpServerStatus = typeof ProviderMcpServerStatus.Type;

export const ProviderMcpServerAction = Schema.Literals([
  "reconnect",
  "enable",
  "disable",
  "authenticate",
  "clear-auth",
]);
export type ProviderMcpServerAction = typeof ProviderMcpServerAction.Type;

export const ProviderMcpServer = Schema.Struct({
  name: ProviderMcpServerName,
  status: ProviderMcpServerStatus,
  /** Where the definition came from, such as user, project, plugin or claudeai. */
  source: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  transport: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  /** Origin and path of a remote server. Query strings and credentials are never sent. */
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  toolCount: Schema.optional(NonNegativeInt),
  error: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  /** T3 runs this server for the agent, so clients cannot change it. */
  managed: Schema.Boolean,
  /** What this server accepts right now. The provider decides, not the client. */
  actions: ForwardCompatibleArray(ProviderMcpServerAction),
});
export type ProviderMcpServer = typeof ProviderMcpServer.Type;

export const ProviderMcpListInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderMcpListInput = typeof ProviderMcpListInput.Type;

export const ProviderMcpListResult = Schema.Struct({
  servers: ForwardCompatibleArray(ProviderMcpServer),
});
export type ProviderMcpListResult = typeof ProviderMcpListResult.Type;

export const ProviderMcpActionInput = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    serverName: ProviderMcpServerName,
    action: ProviderMcpServerAction,
  }),
  // The final redirect URL of an OAuth sign-in, pasted by a user whose browser
  // could not reach the provider's callback listener on the server host.
  Schema.Struct({
    threadId: ThreadId,
    serverName: ProviderMcpServerName,
    action: Schema.Literal("submit-oauth-callback"),
    callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  }),
]);
export type ProviderMcpActionInput = typeof ProviderMcpActionInput.Type;

export const ProviderMcpAuthStart = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  /**
   * The sign-in ends on a redirect to a listener on the server host. A browser
   * on another machine cannot reach it and has to paste the final URL back.
   */
  acceptsCallback: Schema.Boolean,
});
export type ProviderMcpAuthStart = typeof ProviderMcpAuthStart.Type;

export const ProviderMcpActionResult = Schema.Struct({
  servers: ForwardCompatibleArray(ProviderMcpServer),
  /** Present when `authenticate` needs the user to finish in a browser. */
  auth: Schema.optional(ProviderMcpAuthStart),
});
export type ProviderMcpActionResult = typeof ProviderMcpActionResult.Type;

export const ProviderMcpErrorReason = Schema.Literals([
  "thread-not-found",
  "session-not-running",
  "unsupported",
  "server-not-found",
  "action-unavailable",
  "provider-failure",
  /** T3 Code's own state failed, not the agent. */
  "internal",
]);
export type ProviderMcpErrorReason = typeof ProviderMcpErrorReason.Type;

export class ProviderMcpError extends Schema.TaggedError<ProviderMcpError>()("ProviderMcpError", {
  threadId: ThreadId,
  reason: ProviderMcpErrorReason,
  /** User-facing text. Never includes OAuth codes, tokens or server credentials. */
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
