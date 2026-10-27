/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { EFFORT_POLICY_ALL, EFFORT_POLICY_NONE } from "../ModelEffort";
import { makeModelProfileResolver, makeProfileEffortPolicy } from "../ModelProfile";

interface Profile {
  readonly kind: "chat" | "embedding" | "unknown";
}

const CHAT: Profile = { kind: "chat" };
const EMBEDDING: Profile = { kind: "embedding" };
const UNKNOWN: Profile = { kind: "unknown" };

describe("makeModelProfileResolver", () => {
  const resolve = makeModelProfileResolver<Profile>({
    models: { "chat-1": CHAT },
    families: [{ when: [/embed/, (id) => id.startsWith("vec-")], profile: EMBEDDING }],
    normalize: (id) =>
      id
        .trim()
        .toLowerCase()
        .replace(/^vendor\//, ""),
    fallback: UNKNOWN,
  });

  it("answers a row by its canonical id, whatever the spelling", () => {
    expect(resolve(" Vendor/CHAT-1 ")).toEqual({
      profile: CHAT,
      source: "table",
      recognized: true,
      id: "chat-1",
    });
  });

  it("answers an id with no row from the first family that matches", () => {
    expect(resolve("text-embed-2")).toMatchObject({ profile: EMBEDDING, source: "family" });
    expect(resolve("vec-small")).toMatchObject({ profile: EMBEDDING, recognized: true });
  });

  it("falls back for an unmatched or absent id, and does not recognize it", () => {
    expect(resolve("mystery")).toMatchObject({
      profile: UNKNOWN,
      source: "default",
      recognized: false,
    });
    expect(resolve(undefined)).toMatchObject({ profile: UNKNOWN, source: "default", id: "" });
  });

  it("does not match a family against an empty id", () => {
    const greedy = makeModelProfileResolver<Profile>({
      families: [{ when: /.*/, profile: CHAT }],
      fallback: UNKNOWN,
    });
    expect(greedy("")).toMatchObject({ profile: UNKNOWN, source: "default" });
  });

  it("lets a fallback function decide the profile and recognition from the id", () => {
    const guessing = makeModelProfileResolver<Profile>({
      fallback: (id) => ({
        profile: id.startsWith("chat") ? CHAT : UNKNOWN,
        recognized: id !== "",
      }),
    });
    expect(guessing("chat-9")).toEqual({
      profile: CHAT,
      source: "default",
      recognized: true,
      id: "chat-9",
    });
    expect(guessing("")).toMatchObject({ profile: UNKNOWN, recognized: false });
  });

  it("does not read a row off Object.prototype", () => {
    expect(resolve("constructor")).toMatchObject({ profile: UNKNOWN, source: "default" });
  });
});

describe("makeProfileEffortPolicy", () => {
  const resolve = makeModelProfileResolver<Profile>({
    models: { "chat-1": CHAT },
    fallback: UNKNOWN,
  });
  const policy = makeProfileEffortPolicy(resolve, (profile) =>
    profile.kind === "chat" ? EFFORT_POLICY_ALL : EFFORT_POLICY_NONE
  );

  it("reads the policy off the configured model's profile", () => {
    expect(policy({ provider_config: { model_name: "chat-1" } })).toBe(EFFORT_POLICY_ALL);
    expect(policy({ provider_config: { model_name: "other" } })).toBe(EFFORT_POLICY_NONE);
  });

  it("gives an absent id the fallback profile's policy", () => {
    expect(policy(undefined)).toBe(EFFORT_POLICY_NONE);
    expect(policy({})).toBe(EFFORT_POLICY_NONE);
  });
});
