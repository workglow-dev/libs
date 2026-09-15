/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentCard, SecurityRequirement, SecurityScheme } from "@a2a-js/sdk";
import { A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";

import type { IA2AAgentDescriptor } from "./AgentDescriptor";

/** What every agent here reads and writes unless a skill narrows it. */
const DEFAULT_MODES = ["text/plain", "application/json"] as const;

/** The key the bearer scheme is published under, and referenced by. */
const BEARER_SCHEME_KEY = "bearer";

/** The one binding this package serves; the card says so, and the SDK validates against it. */
export const A2A_PROTOCOL_BINDING = "JSONRPC";

export interface BuildAgentCardOptions {
  /** Absolute URL this agent answers on. */
  readonly url: string;
  /** Whether the server enforces a bearer token. */
  readonly authenticated: boolean;
}

function bearerScheme(): Record<string, SecurityScheme> {
  return {
    [BEARER_SCHEME_KEY]: {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: {
          description: "Bearer token issued by the host that started this server.",
          scheme: "Bearer",
          bearerFormat: "",
        },
      },
    },
  };
}

function bearerRequirement(): SecurityRequirement[] {
  return [{ schemes: { [BEARER_SCHEME_KEY]: { list: [] } } }];
}

/**
 * A descriptor, as the card a peer discovers.
 *
 * Only the declared half crosses: a card is public by construction, and the
 * descriptor's `agentInput` carries the model, the system prompt and the tool
 * list — which is exactly what an opaque peer must not be handed.
 *
 * `authenticated` comes from the same value that arms the server, so the card
 * cannot describe an auth posture the server does not have.
 */
export function buildAgentCard(
  descriptor: IA2AAgentDescriptor,
  opts: BuildAgentCardOptions
): AgentCard {
  return {
    name: descriptor.name,
    description: descriptor.description,
    version: descriptor.version,
    supportedInterfaces: [
      {
        url: opts.url,
        protocolBinding: A2A_PROTOCOL_BINDING,
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: opts.authenticated ? bearerScheme() : {},
    securityRequirements: opts.authenticated ? bearerRequirement() : [],
    defaultInputModes: [...DEFAULT_MODES],
    defaultOutputModes: [...DEFAULT_MODES],
    skills: descriptor.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
      examples: [...skill.examples],
      inputModes: [...DEFAULT_MODES],
      outputModes: [...DEFAULT_MODES],
      securityRequirements: [],
    })),
    signatures: [],
  };
}
