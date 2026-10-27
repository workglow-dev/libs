/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

/**
 * What a TypeSafe model is. Jev is a System One model: it returns typed answers
 * to named questions and never writes text, so there is one kind today. The
 * discriminant is what a second kind of model would extend.
 */
export interface TypeSafeAiModelProfile {
  readonly kind: "system-one";
}

const SYSTEM_ONE: TypeSafeAiModelProfile = { kind: "system-one" };

/**
 * One row per canonical id (see {@link normalizeTypeSafeAiModelId}): adding a
 * model is a row here plus its price in `TYPESAFEAI_PRICING`, and the contract
 * test fails until both exist. The aliases are rows of their own because an
 * alias is what a model record usually names.
 */
export const TYPESAFEAI_MODEL_PROFILES: Readonly<Record<string, TypeSafeAiModelProfile>> = {
  jev: SYSTEM_ONE,
  "jev-latest": SYSTEM_ONE,
  "jev-preview": SYSTEM_ONE,
  "jev-1.13.0": SYSTEM_ONE,
};

/** Rows for models `TYPESAFEAI_PRICING` has no card for; the contract test allows exactly these. */
export const TYPESAFEAI_UNPRICED_PROFILE_IDS: ReadonlySet<string> = new Set<string>();

/**
 * The canonical id for any spelling of a TypeSafe model: the gateway's
 * `typesafe/` prefix names the same model.
 */
export function normalizeTypeSafeAiModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^typesafe\//, "");
}

export type TypeSafeAiResolvedProfile = ResolvedModelProfile<TypeSafeAiModelProfile>;

/**
 * Future `jev-*` releases are served by the same endpoint, so the family is
 * recognized; any other id is not, and keeps what its record declared.
 */
export const resolveTypeSafeAiProfile: (
  modelName: string | undefined
) => TypeSafeAiResolvedProfile = makeModelProfileResolver<TypeSafeAiModelProfile>({
  models: TYPESAFEAI_MODEL_PROFILES,
  families: [{ when: /^jev/, profile: SYSTEM_ONE }],
  normalize: normalizeTypeSafeAiModelId,
  fallback: SYSTEM_ONE,
});

/**
 * The task capabilities a profile serves: the native `judgment.systemone`
 * surface plus the two tasks a Choice and a Noul answer serve honestly —
 * classification (a Choice over caller-supplied labels) and reranking (a Noul
 * per candidate) — and the catalog meta-ops. Never `text.generation`,
 * `tool-use`, `json-mode`, an embedding or an image capability: a record
 * claiming one would clear the task's capability gate and then fail inside the
 * provider, with the useful "model is missing capabilities" message replaced by
 * whatever the API said.
 */
export function typeSafeAiProfileCapabilities(
  profile: TypeSafeAiModelProfile
): readonly Capability[] {
  switch (profile.kind) {
    case "system-one":
      return [
        "judgment.systemone",
        "text.classification",
        "text.reranking",
        "model.info",
        "model.search",
      ];
  }
}
