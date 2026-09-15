/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  A2A_VERSION_HEADER,
  AGENT_CARD_PATH,
  AgentCard,
  Extensions,
  formatSSEErrorEvent,
  formatSSEEvent,
  HTTP_EXTENSION_HEADER,
  SSE_HEADERS,
} from "@a2a-js/sdk";
import type { TaskStore, User } from "@a2a-js/sdk/server";
import {
  defaultServerCallContextBuilder,
  JsonRpcTransportHandler,
  UnauthenticatedUser,
  validateVersion,
} from "@a2a-js/sdk/server";
import {
  assertAuthChoice,
  authorizeBearer,
  closeHttpServer,
  displayHostFor,
  guardedRequestListener,
  hostWithoutPort,
  listenHttp,
  readJsonRpcBody,
  resolveAllowedHosts,
  sendJsonRpcError as sendError,
} from "@workglow/util";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import type { AgentCard as AgentCardType } from "@a2a-js/sdk";
import type { IA2AAgentDescriptor } from "../util/AgentDescriptor";
import type { RunAgentTurn } from "./AgentTaskExecutor";
import { A2A_REQUEST_SIGNAL_KEY } from "./AgentTaskExecutor";
import { createA2AServer } from "./createA2AServer";

/** Where a peer posts unless the host says otherwise. */
export const DEFAULT_A2A_PATH = "/a2a";

/**
 * Refuse a request body larger than this.
 *
 * A message legitimately carries the document it asks about, so this is
 * generous — but bounded, since the body is buffered whole before the
 * transport parses it.
 */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface StartA2AHttpServerArgs {
  readonly port: number;
  readonly host: string;
  /** Path the JSON-RPC endpoint answers on. Defaults to {@link DEFAULT_A2A_PATH}. */
  readonly path?: string;
  /**
   * Bearer token every request must present, or `null` to serve without
   * authentication.
   *
   * Required, and `null` rather than an omission, because every message this
   * server accepts runs an agent. A host that never states the choice would
   * otherwise publish agent execution to whatever reaches the port. `null` is
   * refused for a wildcard bind — see {@link startA2AHttpServer}.
   */
  readonly token: string | null;
  readonly descriptor: IA2AAgentDescriptor;
  /**
   * Extra `Host` header values to answer to, beyond the bound host and the
   * loopback names. Needed when peers reach this server by a name that is not
   * what it was bound to.
   */
  readonly allowedHosts?: Iterable<string>;
  readonly maxBodyBytes?: number;
  readonly taskStore?: TaskStore;
  readonly runTurn?: RunAgentTurn;
}

export interface A2AHttpServerHandle {
  readonly server: HttpServer;
  /** The JSON-RPC endpoint, path included — what the card names. */
  readonly url: string;
  /** Where a peer discovers the card, and what a client is pointed at. */
  readonly cardUrl: string;
  readonly token: string | undefined;
  readonly close: () => Promise<void>;
}

interface RequestContext {
  readonly path: string;
  /** Every path the card answers on. */
  readonly cardPaths: ReadonlySet<string>;
  readonly token: string | undefined;
  /** `undefined` when no `Host` restriction applies — see {@link resolveAllowedHosts}. */
  readonly allowedHosts: ReadonlySet<string> | undefined;
  readonly maxBodyBytes: number;
  /** The card is fixed once the server listens, so it is serialized once. */
  readonly cardJson: string;
  readonly card: AgentCardType;
  readonly transport: JsonRpcTransportHandler;
}

/**
 * The caller behind a request that presented the token.
 *
 * One token, one identity: the SDK scopes its task store by user name, and
 * every peer holding the token is the same principal as far as this server
 * can tell.
 */
class BearerUser implements User {
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return "bearer";
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const isCard = ctx.cardPaths.has(url.pathname);
  if (!isCard && url.pathname !== ctx.path) {
    sendError(res, 404, -32601, `no A2A endpoint at "${url.pathname}"`);
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

  // The card is served open. It is how a peer learns which scheme to present,
  // so a card behind the token it describes is a lock with the key inside.
  if (isCard) {
    if (req.method !== "GET") {
      sendError(res, 405, -32000, "the agent card is read-only");
      return;
    }
    sendJson(res, 200, ctx.cardJson);
    return;
  }

  const denied = authorizeBearer(req.headers.authorization, ctx.token);
  if (denied) {
    sendError(res, denied.status, -32001, denied.error, {
      "www-authenticate": denied.wwwAuthenticate,
    });
    return;
  }

  if (req.method !== "POST") {
    sendError(res, 405, -32000, "A2A over JSON-RPC is POST only");
    return;
  }

  const body = await readJsonRpcBody(req, res, ctx.maxBodyBytes);
  if (!body.ok) return;
  const parsed = body.value;
  const requestId =
    typeof parsed === "object" && parsed !== null && "id" in parsed
      ? ((parsed as { id?: string | number | null }).id ?? null)
      : null;

  const context = defaultServerCallContextBuilder({
    extensions: Extensions.parseServiceParameter(
      headerValue(req.headers[HTTP_EXTENSION_HEADER.toLowerCase()])
    ),
    user: ctx.token === undefined ? new UnauthenticatedUser() : new BearerUser(),
    headers: req.headers,
    // Absent means 0.3 to the SDK, which this server does not speak; the
    // check below is what turns that into an answer rather than a mystery.
    requestedVersion: headerValue(req.headers[A2A_VERSION_HEADER.toLowerCase()]),
  });

  // A peer that hangs up mid-turn reaches the executor through this signal:
  // the SDK's own seam carries none, and without it the model keeps
  // generating an answer nobody will read. `close` also fires after a normal
  // end, which is not a hang-up.
  const hangUp = new AbortController();
  context.state.set(A2A_REQUEST_SIGNAL_KEY, hangUp.signal);
  res.on("close", () => {
    if (!res.writableFinished) hangUp.abort();
  });

  try {
    validateVersion(context.requestedVersion, ctx.card, "JSONRPC");
    const outcome = await ctx.transport.handle(parsed as Record<string, unknown>, context);
    if (context.activatedExtensions) {
      res.setHeader(HTTP_EXTENSION_HEADER, Array.from(context.activatedExtensions));
    }
    if (typeof (outcome as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
      sendJson(res, 200, outcome);
      return;
    }

    // Streaming. The first event is awaited before any header goes out, so a
    // request the handler refuses outright still gets a plain JSON error
    // rather than an SSE stream carrying one.
    const stream = outcome as AsyncGenerator<unknown, void, undefined>;
    const first = await stream.next();
    for (const [key, value] of Object.entries(SSE_HEADERS)) res.setHeader(key, value);
    res.flushHeaders();
    try {
      if (!first.done) res.write(formatSSEEvent(first.value));
      for await (const event of stream) {
        if (hangUp.signal.aborted) break;
        res.write(formatSSEEvent(event));
      }
    } catch (error) {
      res.write(
        formatSSEErrorEvent({
          jsonrpc: "2.0",
          id: requestId,
          error: JsonRpcTransportHandler.mapToJSONRPCError(error),
        })
      );
    } finally {
      res.end();
    }
  } catch (error) {
    // Mapped through the SDK so a peer reads the protocol's own error codes:
    // a version it does not speak, a task it cannot find.
    const mapped = JsonRpcTransportHandler.mapToJSONRPCError(error);
    if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", id: requestId, error: mapped });
    else res.end();
  }
}

/**
 * Serves one agent over A2A's JSON-RPC binding from `node:http`.
 *
 * `node:http` rather than a framework, so one implementation serves Bun and
 * Node alike and a host takes on no web framework to run it. A host that
 * already has one should mount {@link createA2AServer}'s handler behind the
 * SDK's `JsonRpcTransportHandler` on its own routes instead.
 *
 * Refuses to serve unauthenticated on a wildcard bind: the endpoint runs an
 * agent for whoever reaches it, and nothing else would be deciding who does.
 */
export async function startA2AHttpServer(
  args: StartA2AHttpServerArgs
): Promise<A2AHttpServerHandle> {
  assertAuthChoice(args.token, args.host, {
    name: "startA2AHttpServer",
    consequence: "every message it accepts runs an agent",
  });
  const token = args.token ?? undefined;
  const path = args.path ?? DEFAULT_A2A_PATH;

  const server = createHttpServer();
  const port = await listenHttp(server, args.port, args.host);
  const origin = `http://${displayHostFor(args.host)}:${port}`;
  const url = `${origin}${path}`;

  // The card carries the endpoint URL, which needs the bound port — so the
  // handler is built after listening, not before.
  const { handler, card } = createA2AServer({
    descriptor: args.descriptor,
    url,
    authenticated: token !== undefined,
    taskStore: args.taskStore,
    runTurn: args.runTurn,
  });
  const cardPath = `/${AGENT_CARD_PATH}`;
  const ctx: RequestContext = {
    path,
    // The well-known location, and the same beneath the endpoint: a client
    // handed the endpoint URL as its base looks there, and a card that answers
    // is cheaper than a 404 an operator has to decode.
    cardPaths: new Set([cardPath, `${path}${cardPath}`]),
    token,
    allowedHosts: resolveAllowedHosts(args.host, args.allowedHosts),
    maxBodyBytes: args.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    // Serialized through the SDK rather than JSON.stringify: the in-memory
    // card spells its security schemes as tagged unions, which the SDK's own
    // client would read back as no scheme at all.
    cardJson: JSON.stringify(AgentCard.toJSON(card)),
    card,
    transport: new JsonRpcTransportHandler(handler),
  };

  server.on(
    "request",
    guardedRequestListener("a2a server", (req, res) => serve(req, res, ctx))
  );

  return {
    server,
    url,
    cardUrl: `${origin}${cardPath}`,
    token,
    close: () => closeHttpServer(server),
  };
}
