/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, Task as A2ATask } from "@a2a-js/sdk";
import { AGENT_CARD_PATH, Role, TaskState, taskStateToJSON } from "@a2a-js/sdk";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import type { IExecuteContext, TaskConfig, TaskEntitlements } from "@workglow/task-graph";
import { Entitlements, mergeEntitlements, Task, TaskConfigSchema } from "@workglow/task-graph";
import { classifyUrl, safeFetch, urlResourcePattern } from "@workglow/tasks";
import { uuid4 } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";

import { textOfParts, textPart } from "../util/partBinding";

/**
 * What this task needs of an A2A client, and no more.
 *
 * Narrow on purpose: the SDK's `Client` carries every method the protocol has,
 * and typing against all of it would make a test either open a socket or stub
 * a surface this task never calls.
 *
 * `state` is the protocol's name for the state (`TASK_STATE_COMPLETED`), not
 * the SDK's numeric enum value: it crosses a port, and a port carrying `3`
 * tells a graph author nothing.
 */
export type A2AClientLike = {
  readonly sendMessage: (
    input: { readonly text: string; readonly contextId: string | undefined },
    signal: AbortSignal
  ) => Promise<{ contextId: string; state: string; parts: readonly Part[] }>;
};

export type A2AAgentTaskInput = {
  agentUrl: string;
  prompt: string;
  contextId: string | undefined;
};

export type A2AAgentTaskOutput = {
  text: string;
  contextId: string;
  taskState: string;
};

export type A2AAgentTaskConfig = TaskConfig<A2AAgentTaskInput> & {
  /** How to reach an agent. Injected so a test needs no socket; a graph never carries it. */
  readonly createClient?: (agentUrl: string) => Promise<A2AClientLike>;
};

const configSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    createClient: {},
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

/** The states a remote task ends in when it did not answer. */
const FAILED_STATES: ReadonlySet<string> = new Set([
  taskStateToJSON(TaskState.TASK_STATE_FAILED),
  taskStateToJSON(TaskState.TASK_STATE_REJECTED),
]);

/**
 * The parts a task reply carries as its answer: its artifacts, or — when it
 * produced none — whatever its status message says, which is where a failed
 * task explains itself.
 */
function partsOfTask(task: A2ATask): Part[] {
  const fromArtifacts = task.artifacts.flatMap((artifact) => artifact.parts);
  return fromArtifacts.length > 0 ? fromArtifacts : (task.status?.message?.parts ?? []);
}

/** Where a card is fetched from: a base the well-known path hangs off, or the card itself. */
export type CardLocation = { readonly baseUrl: string; readonly cardPath: string | undefined };

/**
 * Where to fetch the card, from what the caller gave.
 *
 * The SDK resolves its well-known path *relative* to the base, so a base
 * without a trailing slash loses its last segment — `https://h/agents/foo`
 * would look under `/agents/`. A card URL — the one a server prints and an
 * operator pastes — is handed over as-is, since the SDK takes one directly
 * when told the path is empty.
 */
export function resolveCardLocation(agentUrl: string): CardLocation {
  const url = new URL(agentUrl);
  if (url.pathname.endsWith(`/${AGENT_CARD_PATH}`)) {
    return { baseUrl: url.toString(), cardPath: "" };
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return { baseUrl: url.toString(), cardPath: undefined };
}

/** What reaching any agent costs, before the destination is known. */
const A2A_BASE_ENTITLEMENTS: TaskEntitlements = Object.freeze({
  entitlements: Object.freeze([
    { id: Entitlements.NETWORK_HTTP, reason: "Sends a prompt to a remote agent over HTTP(S)" },
  ]),
});

/**
 * Entitlements a call to `agentUrl` requires.
 *
 * The destination is the caller's to choose — on an agent's tool list the port
 * is filled by a model — so this is the same shape a URL fetcher declares: HTTP
 * always, plus `network:private` scoped to the origin when that origin is
 * loopback, link-local or otherwise internal. An agent URL not yet known at
 * evaluation time fails closed and requires the private grant unscoped.
 */
export function a2aAgentEntitlementsFor(agentUrl: string | undefined): TaskEntitlements {
  const base = A2A_BASE_ENTITLEMENTS;
  if (typeof agentUrl !== "string" || agentUrl.length === 0) {
    return mergeEntitlements(base, {
      entitlements: [
        {
          id: Entitlements.NETWORK_PRIVATE,
          reason:
            "Agent URL is not yet available during entitlement evaluation; private/internal destinations must be explicitly allowed",
        },
      ],
    });
  }
  const classification = classifyUrl(agentUrl);
  if (classification.kind !== "private") return base;
  return mergeEntitlements(base, {
    entitlements: [
      {
        id: Entitlements.NETWORK_PRIVATE,
        reason: `Agent URL targets private/internal host: ${classification.reason ?? classification.host ?? "unknown"}`,
        resources: [urlResourcePattern(agentUrl)],
      },
    ],
  });
}

/**
 * What the SDK actually calls its `fetchImpl` as. Spelled out rather than
 * `typeof fetch`, whose Bun-flavoured form also carries `preconnect`.
 */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The URL a request names. The SDK passes a string or a `URL`, never a `Request`. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * The fetch the SDK is given: every card lookup and every transport call runs
 * through the SSRF checks, DNS pinning and redirect-scope enforcement.
 *
 * Both halves matter, because they are two different destinations. The card is
 * fetched from the agent URL, and the card then NAMES the endpoint the
 * transport speaks to — so a public agent can hand back a loopback endpoint,
 * and only a check on the second request catches it.
 *
 * A private destination is allowed only when the agent URL itself was private,
 * which is what the task declared `network:private` for and what the enforcer
 * approved; the declared origin is passed as the scope so neither a card nor a
 * redirect can pivot to a different internal host.
 */
function fetchForAgent(agentUrl: string): FetchLike {
  const allowPrivate = classifyUrl(agentUrl).kind === "private";
  const privateResourceScopes = allowPrivate ? [urlResourcePattern(agentUrl)] : undefined;
  return (input, init) =>
    safeFetch(requestUrl(input), { ...init, allowPrivate, privateResourceScopes });
}

/**
 * One client per agent, kept for the life of the process.
 *
 * Building a client fetches the card, and a fan-out over one agent would
 * otherwise pay that fetch once per item before sending a single message. A
 * failed build is forgotten, so a peer that was down is retried.
 */
const clients = new Map<string, Promise<A2AClientLike>>();

function defaultCreateClient(agentUrl: string): Promise<A2AClientLike> {
  const location = resolveCardLocation(agentUrl);
  const key = `${location.baseUrl}\u0000${location.cardPath ?? ""}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const created = createClient(location);
  clients.set(key, created);
  created.catch(() => clients.delete(key));
  return created;
}

async function createClient(location: CardLocation): Promise<A2AClientLike> {
  // The SDK types its option as the whole `fetch` global; it only ever calls it.
  const fetchImpl = fetchForAgent(location.baseUrl) as typeof fetch;
  // Transports are listed rather than merged onto the SDK's defaults: one the
  // SDK adds later would arrive without this fetch, and an unchecked transport
  // is the whole hole back.
  const factory = new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({ fetchImpl }),
      new RestTransportFactory({ fetchImpl }),
    ],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  });
  // The card is resolved first: it names the binding to speak and the URL to
  // speak it at, so a bare URL is not enough to build a client from.
  const client = await factory.createFromUrl(location.baseUrl, location.cardPath);
  return {
    sendMessage: async (input, signal) => {
      const reply = await client.sendMessage(
        {
          tenant: "",
          message: {
            messageId: uuid4(),
            contextId: input.contextId ?? "",
            taskId: "",
            role: Role.ROLE_USER,
            parts: [textPart(input.text)],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          configuration: undefined,
          metadata: undefined,
        },
        { signal }
      );
      // A bare message back is the protocol's way of answering without
      // opening a task, so there is no task state to pass on: the answer is
      // complete by construction.
      if ("messageId" in reply) {
        return {
          contextId: reply.contextId,
          state: taskStateToJSON(TaskState.TASK_STATE_COMPLETED),
          parts: reply.parts,
        };
      }
      return {
        contextId: reply.contextId,
        state: taskStateToJSON(reply.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED),
        parts: partsOfTask(reply),
      };
    },
  };
}

export class A2AAgentTask extends Task<A2AAgentTaskInput, A2AAgentTaskOutput, A2AAgentTaskConfig> {
  public static override type = "A2AAgentTask";
  public static override category = "Agent";
  public static override readonly title = "Remote A2A Agent";
  public static override description = "Send a message to an agent published over A2A.";
  /** A remote agent is not a pure function of its input. */
  public static override cacheable = false;
  public static override hasDynamicEntitlements: boolean = true;

  public static override entitlements(): TaskEntitlements {
    return A2A_BASE_ENTITLEMENTS;
  }

  /**
   * Narrows the static declaration to the agent this run actually reaches: a
   * public one needs no private grant, a private one needs it scoped to its own
   * origin so a grant for a dev server is not a grant for the metadata service.
   */
  public override entitlements(): TaskEntitlements {
    return a2aAgentEntitlementsFor(this.runInputData?.agentUrl);
  }

  public static override configSchema(): DataPortSchema {
    return configSchema;
  }

  /** A saved graph can carry everything here except an injected client. */
  public override canSerializeConfig(): boolean {
    return this.config.createClient === undefined;
  }

  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        agentUrl: {
          type: "string",
          title: "Agent URL",
          format: "uri",
          description:
            "The agent's base URL (the card is looked up beneath it), or its card URL; the card names the endpoint to speak to.",
        },
        prompt: { type: "string", title: "Prompt" },
        contextId: {
          type: "string",
          title: "Context",
          description:
            "The remote conversation to continue. Feed one run's contextId output into the next run's input.",
        },
      },
      required: ["agentUrl", "prompt"],
    } as const satisfies DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        text: { type: "string", title: "Answer" },
        contextId: { type: "string", title: "Context" },
        taskState: {
          type: "string",
          title: "Task State",
          description: "The A2A state the remote task ended in, passed through unchanged.",
        },
      },
      required: ["text", "contextId", "taskState"],
    } as const satisfies DataPortSchema;
  }

  public override async execute(
    input: A2AAgentTaskInput,
    context: IExecuteContext
  ): Promise<A2AAgentTaskOutput> {
    const create = this.config.createClient ?? defaultCreateClient;
    const client = await create(input.agentUrl);
    await context.updateProgress(undefined, `Asking ${input.agentUrl}`);
    // The signal goes to the call, not to a check before it: an aborted run
    // must not leave a remote turn running on somebody else's quota.
    const reply = await client.sendMessage(
      { text: input.prompt, contextId: input.contextId },
      context.signal
    );
    const text = textOfParts(reply.parts);
    // A task the peer failed or refused is this task's failure too: handing an
    // empty answer downstream with a state string nobody reads is how a
    // pipeline reports success on a call that never produced anything.
    if (FAILED_STATES.has(reply.state)) {
      throw new Error(`remote agent ended ${reply.state}${text ? `: ${text}` : ""}`);
    }
    return {
      text,
      contextId: reply.contextId,
      // Passed through rather than collapsed: INPUT_REQUIRED is not success.
      taskState: reply.state,
    };
  }
}
