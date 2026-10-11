import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ProviderMcpError,
  type ProviderMcpActionInput,
  type ProviderMcpActionResult,
  type ProviderMcpServer,
  type ProviderMcpServerAction,
  type ProviderMcpServerStatus,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { ExternalLinkIcon, PlugIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { providerMcpEnvironment } from "~/state/providerMcp";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import {
  mcpServerDisplayOrder,
  mcpServersNeedPolling,
  mcpSignInUrl,
  orderMcpServers,
  settleMcpSignIns,
  type McpSignIn,
} from "./McpServersDialog.logic";

/**
 * Which thread has its MCP servers open, set by whichever entry point asked (the /mcp command,
 * the command palette) and rendered once by the chat view so the dialog outlives a palette that
 * closes the moment its command runs.
 */
const mcpServersDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("provider-mcp:dialog-thread"),
);

export function openMcpServersDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(mcpServersDialogThreadAtom, threadRef);
}

/**
 * Mounted once per chat view with the thread it shows. The dialog acts on a live session, so it
 * appears only over the thread it was opened for and closes when the view moves to another thread
 * or goes away, instead of following the user there or popping up again later.
 */
export function McpServersDialogHost({ currentThreadRef }: { currentThreadRef: ScopedThreadRef }) {
  const threadRef = useAtomValue(mcpServersDialogThreadAtom);
  const currentThreadKey = scopedThreadKey(currentThreadRef);
  useEffect(() => {
    return () => appAtomRegistry.set(mcpServersDialogThreadAtom, null);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving the thread closes the dialog.
  }, [currentThreadKey]);
  if (threadRef === null || scopedThreadKey(threadRef) !== currentThreadKey) return null;
  return (
    // Keyed so nothing loaded or started for one thread carries over to another.
    <McpServersDialog
      key={scopedThreadKey(threadRef)}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(mcpServersDialogThreadAtom, null)}
    />
  );
}

const MCP_POLL_INTERVAL_MS = 2_000;
const MCP_POLL_WINDOW_MS = 2 * 60_000;
const NO_SIGN_INS: ReadonlyMap<string, McpSignIn> = new Map();
const NO_REQUESTS: ReadonlyMap<string, McpServerRequest> = new Map();

const STATUS_BADGES = {
  connected: { label: "Connected", variant: "success" },
  "needs-auth": { label: "Needs sign-in", variant: "warning" },
  failed: { label: "Failed", variant: "error" },
  pending: { label: "Connecting", variant: "info" },
  disabled: { label: "Disabled", variant: "outline" },
} as const satisfies Record<ProviderMcpServerStatus, { label: string; variant: string }>;

interface McpServerRequest {
  readonly pending: boolean;
  readonly error: string | null;
}

const isProviderMcpError = Schema.is(ProviderMcpError);

interface McpFailure {
  /** No live session to ask, which is a state to explain rather than an error. */
  readonly notRunning: boolean;
  readonly message: string;
}

function describeMcpFailure(result: AtomCommandResult<unknown, unknown>): McpFailure | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  if (isProviderMcpError(failure)) {
    return {
      // A draft thread does not exist on the server until its first message.
      notRunning: failure.reason === "session-not-running" || failure.reason === "thread-not-found",
      message: failure.message,
    };
  }
  return {
    notRunning: false,
    message: failure instanceof Error ? failure.message : "The request failed. Try again.",
  };
}

/** Opens a sign-in page in the tab reserved for it, or externally when there is none. */
async function openSignInPage(url: string, reserved: Window | null): Promise<boolean> {
  try {
    if (reserved) reserved.location.href = url;
    else await ensureLocalApi().shell.openExternal(url);
    return true;
  } catch {
    reserved?.close();
    return false;
  }
}

function McpServersDialog({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const { environmentId, threadId } = threadRef;
  const listServers = useAtomCommand(providerMcpEnvironment.list, { reportFailure: false });
  const runServerAction = useAtomCommand(providerMcpEnvironment.action, { reportFailure: false });
  const [servers, setServers] = useState<ReadonlyArray<ProviderMcpServer> | null>(null);
  const [order, setOrder] = useState<ReadonlyArray<string> | null>(null);
  const [failure, setFailure] = useState<McpFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [requests, setRequests] = useState(NO_REQUESTS);
  const [signIns, setSignIns] = useState(NO_SIGN_INS);
  // Polling stops a while after the user last refreshed or acted, so an open sign-in then asks
  // for a refresh instead of promising an automatic update.
  const [pollWindow, setPollWindow] = useState(0);
  const [pollLapsed, setPollLapsed] = useState(false);
  // Lists and actions overlap. A list sent before an action settled would roll its result back.
  const issuedRef = useRef(0);
  const appliedRef = useRef(0);

  const applyServers = useCallback((next: ReadonlyArray<ProviderMcpServer>) => {
    setServers(next);
    setOrder((current) => current ?? mcpServerDisplayOrder(next));
    setFailure(null);
    setSignIns((current) => settleMcpSignIns(current, next));
  }, []);

  const applyFailure = useCallback((next: McpFailure) => {
    setFailure(next);
    if (!next.notRunning) return;
    setServers(null);
    setOrder(null);
    setSignIns(NO_SIGN_INS);
  }, []);

  const endSignIn = useCallback((serverName: string) => {
    setSignIns((current) => {
      if (!current.has(serverName)) return current;
      const next = new Map(current);
      next.delete(serverName);
      return next;
    });
  }, []);

  const reopenPollWindow = useCallback(() => {
    setPollWindow((current) => current + 1);
    setPollLapsed(false);
  }, []);

  const setRequest = useCallback((serverName: string, request: McpServerRequest | null) => {
    setRequests((current) => {
      const next = new Map(current);
      if (request === null) next.delete(serverName);
      else next.set(serverName, request);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    const ticket = ++issuedRef.current;
    const result = await listServers({ environmentId, input: { threadId } });
    if (ticket <= appliedRef.current) return;
    appliedRef.current = ticket;
    if (result._tag === "Success") {
      applyServers(result.value.servers);
      return;
    }
    const next = describeMcpFailure(result);
    if (next !== null) applyFailure(next);
  }, [applyFailure, applyServers, environmentId, listServers, threadId]);

  const refresh = async () => {
    reopenPollWindow();
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const act = useCallback(
    async (input: ProviderMcpActionInput): Promise<ProviderMcpActionResult | null> => {
      // A sign-in this starts, or a server it leaves connecting, is watched for a full window.
      reopenPollWindow();
      setRequest(input.serverName, { pending: true, error: null });
      const result = await runServerAction({ environmentId, input });
      if (result._tag === "Success") {
        appliedRef.current = ++issuedRef.current;
        applyServers(result.value.servers);
        setRequest(input.serverName, null);
        return result.value;
      }
      const next = describeMcpFailure(result);
      setRequest(
        input.serverName,
        next === null || next.notRunning ? null : { pending: false, error: next.message },
      );
      if (next?.notRunning) applyFailure(next);
      return null;
    },
    [applyFailure, applyServers, environmentId, reopenPollWindow, runServerAction, setRequest],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Nothing pushes MCP status, so the dialog asks again while something is settling.
  const needsPolling = mcpServersNeedPolling(servers, signIns);
  useEffect(() => {
    if (!needsPolling) return;
    const deadline = Date.now() + MCP_POLL_WINDOW_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        void load().then(() => {
          if (stopped) return;
          if (Date.now() < deadline) schedule();
          else setPollLapsed(true);
        });
      }, MCP_POLL_INTERVAL_MS);
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each refresh or action restarts the window.
  }, [load, needsPolling, pollWindow]);

  const authenticate = async (server: ProviderMcpServer) => {
    // Browsers block tabs opened after an await, so the web build reserves one first.
    const reserved = window.desktopBridge ? null : window.open("", "_blank");
    if (reserved) reserved.opener = null;
    const result = await act({ threadId, serverName: server.name, action: "authenticate" });
    const auth = result?.auth;
    if (!result || !auth) {
      reserved?.close();
      return;
    }
    const url = mcpSignInUrl(auth.url);
    if (url === null) {
      reserved?.close();
      setRequest(server.name, {
        pending: false,
        error: "The server's sign-in link is not a web page, so T3 Code did not open it.",
      });
      return;
    }
    setSignIns((current) =>
      new Map(current).set(server.name, { url, acceptsCallback: auth.acceptsCallback }),
    );
    if (!(await openSignInPage(url, reserved))) {
      setRequest(server.name, {
        pending: false,
        error: "Could not open the sign-in page. Use Open sign-in page to try again.",
      });
    }
  };

  const notRunning = failure?.notRunning === true;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>MCP servers</DialogTitle>
          <DialogDescription>
            The MCP servers of this thread's running agent session. Enabling or disabling a server
            is saved for this project folder in Claude Code, so it also applies to later sessions.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {notRunning ? (
            <Empty>
              <EmptyMedia variant="icon">
                <PlugIcon />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>The agent is not running</EmptyTitle>
                <EmptyDescription>
                  MCP servers can be managed while this thread's agent session runs. Send a message
                  to start it, then open this again.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {failure !== null ? (
                <p className="text-destructive text-sm [overflow-wrap:anywhere]">
                  {failure.message}
                </p>
              ) : null}
              {servers === null ? (
                failure === null ? (
                  <p className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Spinner size="sm" tone="muted" />
                    Loading MCP servers...
                  </p>
                ) : null
              ) : servers.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  This session has no MCP servers configured.
                </p>
              ) : (
                <ul className="divide-y">
                  {orderMcpServers(servers, order ?? []).map((server) => (
                    <McpServerRow
                      key={server.name}
                      server={server}
                      request={requests.get(server.name) ?? null}
                      signIn={signIns.get(server.name) ?? null}
                      signInAwaitsRefresh={pollLapsed}
                      onAction={(action) => {
                        if (action === "authenticate") void authenticate(server);
                        else void act({ threadId, serverName: server.name, action });
                      }}
                      onSubmitCallback={(callbackUrl) => {
                        void act({
                          threadId,
                          serverName: server.name,
                          action: "submit-oauth-callback",
                          callbackUrl,
                        }).then((result) => {
                          // The exchange has finished either way; the row shows how it went.
                          if (result !== null) endSignIn(server.name);
                        });
                      }}
                      onCancelSignIn={() => endSignIn(server.name)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshIcon refreshing={refreshing} />
            Refresh
          </Button>
          <Button type="button" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const ACTION_LABELS = {
  authenticate: "Authenticate",
  reconnect: "Reconnect",
  enable: "Enable",
  disable: "Disable",
  "clear-auth": "Sign out",
} as const satisfies Record<ProviderMcpServerAction, string>;

const ACTION_ORDER = [
  "authenticate",
  "reconnect",
  "enable",
  "disable",
  "clear-auth",
] as const satisfies ReadonlyArray<ProviderMcpServerAction>;

function McpServerRow({
  server,
  request,
  signIn,
  signInAwaitsRefresh,
  onAction,
  onSubmitCallback,
  onCancelSignIn,
}: {
  server: ProviderMcpServer;
  request: McpServerRequest | null;
  signIn: McpSignIn | null;
  /** The dialog has stopped checking, so finishing the sign-in shows only after a refresh. */
  signInAwaitsRefresh: boolean;
  onAction: (action: ProviderMcpServerAction) => void;
  onSubmitCallback: (callbackUrl: string) => void;
  onCancelSignIn: () => void;
}) {
  const badge = STATUS_BADGES[server.status];
  const pending = request?.pending === true;
  const details = [
    server.source,
    server.transport,
    server.url,
    server.toolCount === undefined
      ? undefined
      : `${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`,
    server.managed ? "Managed by T3 Code" : undefined,
  ].filter((part) => part !== undefined);
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-sm">{server.name}</span>
            <Badge size="sm" variant={badge.variant}>
              {badge.label}
            </Badge>
            {pending ? <Spinner size="xs" tone="muted" /> : null}
          </div>
          {details.length > 0 ? (
            <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {details.join(" · ")}
            </p>
          ) : null}
          {server.error ? (
            <p className="text-destructive text-xs [overflow-wrap:anywhere]">{server.error}</p>
          ) : null}
          {request?.error ? (
            <p className="text-destructive text-xs [overflow-wrap:anywhere]">{request.error}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {ACTION_ORDER.filter((action) => server.actions.includes(action)).map((action) => (
            <Button
              key={action}
              type="button"
              size="xs"
              variant={
                action === "clear-auth"
                  ? "ghost-muted"
                  : action === "authenticate" && server.status === "needs-auth"
                    ? "default"
                    : "outline"
              }
              disabled={pending}
              onClick={() => onAction(action)}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      </div>
      {signIn !== null ? (
        <McpSignInPanel
          signIn={signIn}
          awaitsRefresh={signInAwaitsRefresh}
          pending={pending}
          onSubmitCallback={onSubmitCallback}
          onReconnect={() => onAction("reconnect")}
          onCancel={onCancelSignIn}
        />
      ) : null}
    </li>
  );
}

function McpSignInPanel({
  signIn,
  awaitsRefresh,
  pending,
  onSubmitCallback,
  onReconnect,
  onCancel,
}: {
  signIn: McpSignIn;
  awaitsRefresh: boolean;
  pending: boolean;
  onSubmitCallback: (callbackUrl: string) => void;
  onReconnect: () => void;
  onCancel: () => void;
}) {
  const [callbackUrl, setCallbackUrl] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-muted-foreground text-xs">
      {signIn.acceptsCallback ? (
        <>
          <p>
            {awaitsRefresh
              ? "When you've finished signing in, press Refresh."
              : "Finish signing in in your browser. This updates when it completes."}
          </p>
          <p>If your browser ends on a page that won't load, paste its address here.</p>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              const value = callbackUrl.trim();
              if (value.length > 0) onSubmitCallback(value);
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Address of the page that did not load"
                type="password"
                autoComplete="off"
                size="sm"
                placeholder="http://localhost:..."
                value={callbackUrl}
                maxLength={16_384}
                disabled={pending}
                onChange={(event) => setCallbackUrl(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={pending || callbackUrl.trim().length === 0}
            >
              Submit
            </Button>
          </form>
        </>
      ) : (
        <p>Approve access in your browser, then reconnect.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {signIn.acceptsCallback ? null : (
          <Button type="button" size="xs" disabled={pending} onClick={onReconnect}>
            Reconnect
          </Button>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          onClick={() => void ensureLocalApi().shell.openExternal(signIn.url)}
        >
          Open sign-in page
          <ExternalLinkIcon />
        </Button>
        <Button type="button" size="xs" variant="ghost-muted" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
