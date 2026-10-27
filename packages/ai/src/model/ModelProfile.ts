/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelEffortPolicy, ModelEffortPolicyFn } from "./ModelEffort";
import { readModelName } from "./ModelEffort";

/** Matches a canonical model id. A function covers what a regex cannot express. */
export type ModelIdMatcher = RegExp | ((id: string) => boolean);

/**
 * Where a profile came from: the id's own row, a family rule it matched, or the
 * fallback — the one place a provider guesses.
 */
export type ModelProfileSource = "table" | "family" | "default";

export interface ResolvedModelProfile<P> {
  readonly profile: P;
  readonly source: ModelProfileSource;
  /**
   * Whether the id names a model the provider recognizes. Capability inference
   * answers only for these; for the rest a record keeps what it declared.
   * Request building reads `profile` either way, since a request needs an answer.
   */
  readonly recognized: boolean;
  /** The canonical id the lookup used. */
  readonly id: string;
}

export interface ModelProfileFamily<P> {
  readonly when: ModelIdMatcher | readonly ModelIdMatcher[];
  readonly profile: P;
}

export interface ModelProfileFallback<P> {
  readonly profile: P;
  readonly recognized: boolean;
}

export interface ModelProfileSpec<P> {
  /** One row per canonical id: what is known about that model, every flag stated. */
  readonly models?: Readonly<Record<string, P>> | undefined;
  /** Consulted, in order, for an id with no row; the first match wins. */
  readonly families?: readonly ModelProfileFamily<P>[] | undefined;
  /**
   * Reduces any spelling of an id (a gateway prefix, a snapshot date, a tag) to
   * the canonical one rows and families are keyed by. Default: trim and lower-case.
   */
  readonly normalize?: ((id: string) => string) | undefined;
  /**
   * The answer for an id no row or family names, and for an absent id. A
   * constant is not recognized; a function decides both from the canonical id.
   */
  readonly fallback: P | ((id: string) => ModelProfileFallback<P>);
}

export type ModelProfileResolver<P> = (modelName: string | undefined) => ResolvedModelProfile<P>;

function defaultNormalize(id: string): string {
  return id.trim().toLowerCase();
}

function matches(matcher: ModelIdMatcher, id: string): boolean {
  return typeof matcher === "function" ? matcher(id) : matcher.test(id);
}

/**
 * Builds a provider's one answer to "what is this model?". Request building,
 * capability inference, the effort policy, model search and pricing all read
 * the profile this returns, so a model cannot be one thing where a request is
 * built and another where it is listed.
 */
export function makeModelProfileResolver<P>(spec: ModelProfileSpec<P>): ModelProfileResolver<P> {
  const normalize = spec.normalize ?? defaultNormalize;
  const models = spec.models ?? {};
  const families = (spec.families ?? []).map((family) => ({
    matchers:
      family.when instanceof RegExp || typeof family.when === "function"
        ? [family.when]
        : family.when,
    profile: family.profile,
  }));
  const { fallback } = spec;
  return (modelName) => {
    const id = normalize(modelName ?? "");
    if (Object.hasOwn(models, id)) {
      return { profile: models[id]!, source: "table", recognized: true, id };
    }
    if (id.length > 0) {
      for (const family of families) {
        if (family.matchers.some((matcher) => matches(matcher, id))) {
          return { profile: family.profile, source: "family", recognized: true, id };
        }
      }
    }
    if (typeof fallback === "function") {
      const guessed = (fallback as (id: string) => ModelProfileFallback<P>)(id);
      return { ...guessed, source: "default", id };
    }
    return { profile: fallback, source: "default", recognized: false, id };
  };
}

/**
 * An effort policy read off the profile, so which models take the reasoning
 * dial is decided by the same row that decides everything else about them.
 */
export function makeProfileEffortPolicy<P>(
  resolve: ModelProfileResolver<P>,
  effort: (profile: P) => ModelEffortPolicy
): ModelEffortPolicyFn {
  return (model) => effort(resolve(readModelName(model)).profile);
}
