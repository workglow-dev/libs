/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Server as McpServerInstance } from "@modelcontextprotocol/sdk/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  assertAuthChoice,
  authorizeBearer,
  BodyTooLargeError,
  getLogger,
  hostWithoutPort,
  readRequestBody,
  resolveAllowedHosts,
} from "@workglow/util";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { McpSessionRouter } from "./McpSessionRouter";

// Re-exported for the callers that reach these by this path. The predicates
// themselves live in `@workglow/util`, shared with every server the monorepo
// binds to `node:http`.
export { hostWithoutPort, resolveAllowedHosts };

/** Where a client posts unless the host says otherwise. */
export const DEFAULT_MCP_PATH = "/mcp";

/**
 * Refuse a request body larger than this.
 *
 * Generous next to a console form, because a tool call legitimately carries
 * the document it is being asked about — but still bounded, since the body is
 * buffered whole before the transport sees it.
 */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface StartMcpHttpServerArgs {
  readonly port: number;
  readonly host: string;
  /** Path the MCP endpoint answers on. Defaults to {@link DEFAULT_MCP_PATH}. */
  readonly path?: string;
  /**
   * Bearer token every request must present, or `null` to serve without
   * authentication.
   *
   * Required, and `null` rather than an omission, because every tool this
   * server offers executes a task. A host that never states the choice would
   * otherwise publish task execution to whatever reaches the port, and nothing
   * in the request path can tell that apart from a host that meant to.
   * `null` is refused for a wildcard bind — see {@link startMcpHttpServer}.
   */
  readonly token: string | null;
  /** One MCP server instance per client session. */
  readonly createServer: () => McpServerInstance;
  /**
   * Extra `Host` header values to answer to, beyond the bound host and the
   * loopback names. Needed when clients reach this server by a name that is
   * not what it was bound to.
   */
  readonly allowedHosts?: Iterable<string>;
  readonly maxBodyBytes?: number;
}

export interface McpHttpServerHandle {
  readonly server: HttpServer;
  /** The full endpoint URL, path included — what goes into a client config. */
  readonly url: string;
  readonly token: string | undefined;
  readonly sessionCount: () => number;
  readonly close: () => Promise<void>;
}

interface RequestContext {
  readonly path: string;
  readonly token: string | undefined;
  /** `undefined` when no `Host` restriction applies — see {@link resolveAllowedHosts}. */
  readonly allowedHosts: ReadonlySet<string> | undefined;
  readonly maxBodyBytes: number;
  readonly router: McpSessionRouter<StreamableHTTPServerTransport>;
}

/** A JSON-RPC error body, which is what an MCP client can actually read. */
function sendError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== ctx.path) {
    sendError(res, 404, -32601, `no MCP endpoint at "${url.pathname}"`);
    return;
  }

  // The Host check stops DNS rebinding turning a page on another site into a
  // local client of this server. It runs before the token check because a
  // rebound request is refused whether or not it guessed a token. An absent or
  // empty header fails it rather than skipping it: a guard that admits what it
  // cannot identify is not a guard.
  const host = hostWithoutPort(req.headers.host);
  if (ctx.allowedHosts && !ctx.allowedHosts.has(host)) {
    sendError(res, 403, -32000, `refusing requests for host "${host}"`);
    return;
  }

  const denied = authorizeBearer(req.headers.authorization, ctx.token);
  if (denied) {
    sendError(res, denied.status, -32001, denied.error, {
      "www-authenticate": denied.wwwAuthenticate,
    });
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  const named = typeof sessionId === "string" ? sessionId : undefined;
  const existing = ctx.router.get(named);
  // A session id this server does not know gets 404, which is the status the
  // spec makes a client recover from by initializing again; 400 is a hard
  // protocol error and leaves a client holding a stale id stuck there. No id at
  // all on a request that needs one stays 400.
  const missingSession = (): void =>
    named === undefined
      ? sendError(res, 400, -32000, "missing session id")
      : sendError(res, 404, -32001, `unknown session id "${named}"`);

  if (req.method !== "POST") {
    // GET opens the session's notification stream and DELETE ends it; both
    // address a session that initialize already created.
    if (!existing) {
      missingSession();
      return;
    }
    await existing.handleRequest(req, res);
    return;
  }

  // The body is read and parsed here rather than inside the transport because
  // the decision it drives — is this an initialize, and so may it open a
  // session — has to be made before there is a transport to hand it to.
  let body: string;
  try {
    body = await readRequestBody(req, ctx.maxBodyBytes);
  } catch (error) {
    // Only the size cap is a 413. `for await` over the request also rejects when
    // the client simply went away, and answering that with "request body too
    // large" tells an operator the wrong thing about their own traffic.
    if (error instanceof BodyTooLargeError) {
      // Ours, and it names only the limit the operator configured.
      sendError(res, 413, -32000, error.message);
    } else if (!res.headersSent) {
      sendError(res, 400, -32000, "could not read request body");
    }
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendError(res, 400, -32700, "malformed JSON in request body");
    return;
  }

  if (existing) {
    await existing.handleRequest(req, res, parsed);
    return;
  }
  if (!isInitializeRequest(parsed)) {
    missingSession();
    return;
  }
  const transport = await ctx.router.open();
  try {
    await transport.handleRequest(req, res, parsed);
  } finally {
    // The transport only registers a session once the SDK accepts the
    // handshake. When it refuses one (a missing `Accept`, a bad content type)
    // it answers the request and closes nothing, so without this every rejected
    // initialize would strand a transport and a whole MCP server for the life
    // of the process — invisibly, since `sessionCount()` never counted them.
    if (transport.sessionId === undefined) await ctx.router.discard(transport);
  }
}

/**
 * Serves MCP over Streamable HTTP from `node:http`.
 *
 * `node:http` rather than `Bun.serve` or a framework, so one implementation
 * serves Bun and Node alike and a host takes on no web framework to run it.
 * A host that already has one — Hono, Express — should mount
 * {@link McpSessionRouter} on its own routes instead of starting this.
 */
export async function startMcpHttpServer(
  args: StartMcpHttpServerArgs
): Promise<McpHttpServerHandle> {
  assertAuthChoice(args.token, args.host, {
    name: "startMcpHttpServer",
    consequence: "every tool it offers runs a task",
  });
  const token = args.token ?? undefined;
  const path = args.path ?? DEFAULT_MCP_PATH;
  const router = new McpSessionRouter({
    createTransport: (hooks) => new StreamableHTTPServerTransport(hooks),
    createServer: args.createServer,
  });
  const ctx: RequestContext = {
    path,
    token,
    allowedHosts: resolveAllowedHosts(args.host, args.allowedHosts),
    maxBodyBytes: args.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    router,
  };

  const server = createHttpServer((req, res) => {
    serve(req, res, ctx).catch((error: unknown) => {
      // The caller learns only that it failed. An unexpected throw here
      // carries whatever the thrower put in it — a filesystem path, a
      // connection string — and this endpoint answers anyone who reaches the
      // port. The operator gets the detail on the server's own log instead.
      getLogger().error("mcp server request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) sendError(res, 500, -32603, "internal server error");
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : args.port;
  // A bare wildcard is not something a client config can connect to.
  const displayHost = args.host === "0.0.0.0" || args.host === "::" ? "localhost" : args.host;
  return {
    server,
    url: `http://${displayHost}:${port}${path}`,
    token,
    sessionCount: () => router.size,
    close: async () => {
      await router.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
