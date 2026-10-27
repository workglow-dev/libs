/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A numeric id segment this long is a release date (`20250514`), not a minor
 * version. Without this rule `claude-sonnet-4-20250514` parses as minor
 * 20250514 and is wrongly treated as a post-cutoff generation.
 */
const DATE_SEGMENT = /^\d{6,}$/;
const NUMERIC_SEGMENT = /^\d+$/;
const CLAUDE_PREFIX = "claude-";

/**
 * Gateways prefix the vendor onto the id (`us.anthropic.claude-…`,
 * `anthropic.claude-…`) and suffix a revision (`…-v1:0`). Stripping the prefix
 * grades those spellings on the same generation rule as a native id, instead of
 * having them fall out of the parser as "not a Claude id at all".
 */
export const ANTHROPIC_GATEWAY_PREFIX = /^(?:[a-z0-9-]+\.)*anthropic\./i;

export interface ParsedAnthropicModelId {
  /** Empty for the bare `claude-2.1` shape, which carries no family name. */
  readonly family: string;
  readonly major: number;
  readonly minor: number | undefined;
}

/**
 * Parses the three id shapes Anthropic has shipped:
 * - modern `claude-<family>-<major>[-<minor>][-<date>]` (`claude-opus-4-8`)
 * - legacy `claude-<major>[-<minor>]-<family>[-<date>]` (`claude-3-5-sonnet-20241022`)
 * - bare `claude-[instant-]<major>[.<minor>]` (`claude-2.1`, `claude-instant-1.2`)
 *
 * Returns `undefined` for anything else, including non-Claude ids.
 */
export function parseAnthropicModelId(id: string): ParsedAnthropicModelId | undefined {
  const normalized = id.trim().toLowerCase();
  if (!normalized.startsWith(CLAUDE_PREFIX)) return undefined;

  let rest = normalized.slice(CLAUDE_PREFIX.length);
  if (rest.length === 0) return undefined;

  if (rest.startsWith("instant-")) rest = rest.slice("instant-".length);
  const bare = /^(\d+)(?:\.(\d+))?$/.exec(rest);
  if (bare) {
    return {
      family: "",
      major: Number(bare[1]),
      minor: bare[2] === undefined ? undefined : Number(bare[2]),
    };
  }

  const segments = rest.split("-").filter((segment) => segment.length > 0);
  if (segments.length < 2) return undefined;

  const isVersionSegment = (segment: string | undefined): boolean =>
    segment !== undefined && NUMERIC_SEGMENT.test(segment) && !DATE_SEGMENT.test(segment);

  // Legacy shape leads with the version: claude-3-5-sonnet-20241022.
  if (isVersionSegment(segments[0])) {
    const major = Number(segments[0]);
    let index = 1;
    let minor: number | undefined;
    if (isVersionSegment(segments[index])) {
      minor = Number(segments[index]);
      index += 1;
    }
    const family = segments[index];
    if (family === undefined || NUMERIC_SEGMENT.test(family)) return undefined;
    return { family, major, minor };
  }

  // Modern shape leads with the family: claude-opus-4-8.
  if (!isVersionSegment(segments[1])) return undefined;
  return {
    family: segments[0]!,
    major: Number(segments[1]),
    minor: isVersionSegment(segments[2]) ? Number(segments[2]) : undefined,
  };
}

/**
 * The canonical id for any spelling of a Claude model a gateway may hand us:
 * - vendor prefixes, OpenRouter's `anthropic/` and Bedrock's `[us.]anthropic.`
 * - Bedrock's `-v1:0` revision and Vertex's `@20250929` / `@latest` suffix
 * - a trailing release date (`-20250929`), which names a snapshot of the same model
 * - OpenRouter's dotted versions (`claude-opus-4.5`, `claude-3.5-sonnet`)
 *
 * The bare legacy shape `claude-2.1` keeps its dot, since that is its canonical spelling.
 */
export function normalizeAnthropicModelId(id: string): string {
  let out = id
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, "")
    .replace(ANTHROPIC_GATEWAY_PREFIX, "")
    .replace(/@(?:\d{8}|latest)$/, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "");
  if (!/^claude-(?:instant-)?\d+\.\d+$/.test(out)) out = out.replace(/(\d)\.(\d)/g, "$1-$2");
  return out;
}
