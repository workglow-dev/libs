/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { LazyEncryptedCredentialStore } from "../../packages/storage/src/credentials/LazyEncryptedCredentialStore";
import { FsFolderJsonKvStorage } from "../../packages/storage/src/kv/FsFolderJsonKvStorage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export const SECRETS_DIR = path.join(REPO_ROOT, ".secrets", "credentials");
export const PASSPHRASE_ENV = "WORKGLOW_SECRETS_PASSPHRASE";

export const CREDENTIAL_TO_ENV: Readonly<Record<string, string>> = {
  "anthropic-api-key": "ANTHROPIC_API_KEY",
  "openai-api-key": "OPENAI_API_KEY",
  "google-api-key": "GOOGLE_API_KEY",
  "gemini-api-key": "GEMINI_API_KEY",
  "hf-token": "HF_TOKEN",
  "xai-api-key": "XAI_API_KEY",
  "openrouter-api-key": "OPENROUTER_API_KEY",
  "deepseek-api-key": "DEEPSEEK_API_KEY",
  "typesafe-api-key": "TYPESAFE_API_KEY",
};

export interface BuiltStore {
  readonly encrypted: LazyEncryptedCredentialStore;
  readonly unlocked: boolean;
}

/**
 * Build the on-disk encrypted credential store. If `passphrase` is omitted,
 * the store stays locked and all reads return `undefined`.
 *
 * `secretsDir` defaults to the canonical {@link SECRETS_DIR}; tests can pass
 * a temp directory to exercise the store in isolation.
 */
export async function buildCredentialStore(
  passphrase: string | undefined,
  secretsDir: string = SECRETS_DIR
): Promise<BuiltStore> {
  const kv = new FsFolderJsonKvStorage(secretsDir);
  const encrypted = new LazyEncryptedCredentialStore(kv);
  if (passphrase) {
    try {
      await encrypted.unlock(passphrase);
    } catch {
      // Match prior best-effort behaviour: a wrong passphrase leaves the
      // store locked and the caller logs a warning. (`installAndHydrate`
      // and CLI subcommands both already gate on `encrypted.isUnlocked`.)
    }
  }
  return { encrypted, unlocked: encrypted.isUnlocked };
}

/** What a call to {@link installAndHydrate} did. */
export type HydrateOutcome =
  /** No passphrase, so the store was never opened. */
  | { readonly status: "no-passphrase" }
  /**
   * Nothing left to decrypt: every credential the store holds is already in
   * `process.env` (or the store holds none). The distinguishing property is
   * that reaching this needs NO key derivation — see
   * {@link credentialsAwaitingEnv}.
   */
  | { readonly status: "nothing-to-do"; readonly present: readonly string[] }
  | { readonly status: "hydrated"; readonly hydrated: readonly string[] }
  /** Wrong passphrase, or a ciphertext that would not decrypt under it. */
  | { readonly status: "locked"; readonly reason: string };

/**
 * Which stored credentials still need decrypting, and which env vars are
 * already set — answered WITHOUT deriving a key.
 *
 * This is what lets the common case cost nothing. `kv.get` returns the stored
 * ciphertext record as-is, so asking "is this credential in the store" is a
 * file read, while asking for its value is a 600k-iteration PBKDF2 derivation
 * (~290ms) per distinct salt — and every credential carries its own random
 * salt, so a store of eight is eight derivations plus one for the unlock
 * sentinel. That is paid once per PROCESS, and a test runner is one process
 * per test file.
 *
 * Probing the store rather than trusting a marker in the environment is
 * deliberate: a marker saying "already hydrated" can be exported by anyone,
 * and if it were wrong the keys would simply be absent — which every
 * integration test reads as "skip" rather than as a failure.
 */
interface CredentialProbe {
  /** Credential keys the store holds whose env var is NOT set. */
  readonly needing: readonly string[];
  /** Mapped env vars already set, whatever the store holds. */
  readonly present: readonly string[];
}

async function credentialsAwaitingEnv(secretsDir: string): Promise<CredentialProbe> {
  const kv = new FsFolderJsonKvStorage(secretsDir);
  const needing: string[] = [];
  const present: string[] = [];
  for (const [credKey, envVar] of Object.entries(CREDENTIAL_TO_ENV)) {
    if (process.env[envVar]) {
      present.push(envVar);
      continue;
    }
    if ((await kv.get(credKey)) !== undefined) needing.push(credKey);
  }
  return { needing, present };
}

/**
 * Hydrate `process.env` from the encrypted store for the duration of the
 * test process. Only keys not already present in `process.env` are written,
 * so an explicit shell export always wins.
 *
 * Decryption errors (wrong passphrase / stale ciphertext) leave `process.env`
 * untouched and report `locked`, so unit tests stay green and integration
 * tests skip via their existing `!!process.env.*_API_KEY` guards.
 *
 * The global credential store is intentionally NOT replaced — provider
 * clients use the env fallback, and overriding the registry default would
 * break unit tests that assert the default is `InMemoryCredentialStore`.
 *
 * The store is opened only when there is something in it left to decrypt, and
 * a probe that finds nothing returns `nothing-to-do` having derived no key.
 * Opening it is not free even when every value is already in the environment:
 * `unlock` verifies the passphrase against the sentinel, which is one
 * derivation of its own. That is also why this no longer writes a sentinel
 * into an empty store as a side effect — running tests should not modify the
 * credential folder.
 *
 * `secretsDir` defaults to {@link SECRETS_DIR}; tests pass a temp directory.
 */
export async function installAndHydrate(
  passphrase: string | undefined,
  secretsDir: string = SECRETS_DIR
): Promise<HydrateOutcome> {
  if (!passphrase) return { status: "no-passphrase" };

  // A probe failure is not an answer, so fall through to the real path rather
  // than reporting a state: a missing or unreadable folder is handled there
  // (as `locked`), and throwing here would reject the preload's top-level
  // await and fail every test file on the way in.
  let probe: CredentialProbe | undefined;
  try {
    probe = await credentialsAwaitingEnv(secretsDir);
  } catch {
    probe = undefined;
  }
  if (probe !== undefined && probe.needing.length === 0) {
    return { status: "nothing-to-do", present: probe.present };
  }

  const { encrypted } = await buildCredentialStore(passphrase, secretsDir);
  if (!encrypted.isUnlocked) {
    return { status: "locked", reason: "the passphrase does not match this store" };
  }

  // Decrypt into a temporary map first; only if every existing ciphertext
  // decrypts cleanly do we write to `process.env`.
  const pending: Array<readonly [string, string]> = [];
  for (const [credKey, envVar] of Object.entries(CREDENTIAL_TO_ENV)) {
    if (process.env[envVar]) continue;
    let value: string | undefined;
    try {
      value = await encrypted.get(credKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "locked",
        reason: `"${credKey}" would not decrypt — wrong passphrase or stale ciphertext. Fix the passphrase and run \`bun scripts/credentials.ts rotate\`, or re-import keys with \`import-env\`. Underlying error: ${msg}`,
      };
    }
    if (value) pending.push([envVar, value] as const);
  }

  const hydrated: string[] = [];
  for (const [envVar, value] of pending) {
    process.env[envVar] = value;
    hydrated.push(envVar);
  }
  return hydrated.length > 0
    ? { status: "hydrated", hydrated }
    : { status: "nothing-to-do", present: probe?.present ?? [] };
}

/**
 * Hydrate once and say so, for the three places that want that: the per-file
 * test preload, vitest's global setup, and the test runner before it spawns
 * either runner.
 *
 * Only a real event is announced. `hydrated` and `locked` each print one line;
 * `nothing-to-do` and `no-passphrase` print nothing, which is what makes
 * calling this from a per-FILE hook quiet — the alternative was one
 * "Failed to unlock encrypted credentials" per test file on every run that
 * configures no passphrase at all, which is every unit run in CI.
 */
export async function hydrateTestCredentials(
  secretsDir: string = SECRETS_DIR
): Promise<HydrateOutcome> {
  const outcome = await installAndHydrate(process.env[PASSPHRASE_ENV], secretsDir);
  if (outcome.status === "hydrated") {
    console.log(
      `[test-credentials] Unlocked encrypted credentials, hydrated env: ${outcome.hydrated.join(", ")}`
    );
  } else if (outcome.status === "locked") {
    console.warn(`[test-credentials] ${outcome.reason}`);
  }
  return outcome;
}
