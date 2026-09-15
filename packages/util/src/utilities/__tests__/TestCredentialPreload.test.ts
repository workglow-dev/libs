/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The module under test (`scripts/lib/test-credentials.ts`) lives outside this
// package's `rootDir`. Loading it through a runtime-string dynamic import keeps
// `tsc --build` from pulling it into the project graph and tripping the
// rootDir invariant.
interface TestCredentialsModule {
  buildCredentialStore: (
    passphrase: string | undefined,
    secretsDir?: string
  ) => Promise<{ readonly encrypted: { put(k: string, v: string): Promise<void> } }>;
  CREDENTIAL_TO_ENV: Readonly<Record<string, string>>;
  installAndHydrate: (
    passphrase: string | undefined,
    secretsDir?: string
  ) => Promise<
    | { readonly status: "no-passphrase" }
    | { readonly status: "nothing-to-do"; readonly present: readonly string[] }
    | { readonly status: "hydrated"; readonly hydrated: readonly string[] }
    | { readonly status: "locked"; readonly reason: string }
  >;
}

let buildCredentialStore: TestCredentialsModule["buildCredentialStore"];
let CREDENTIAL_TO_ENV: TestCredentialsModule["CREDENTIAL_TO_ENV"];
let installAndHydrate: TestCredentialsModule["installAndHydrate"];
let ENV_VARS: readonly string[];

beforeAll(async () => {
  // Absolute, via import.meta.url: a bare relative string is resolved against
  // this module's ROOT-RELATIVE url, so the number of `../` needed depends on
  // where the vitest project root sits — which is per-package now.
  const modulePath = new URL("../../../../../scripts/lib/test-credentials.ts", import.meta.url)
    .href;
  const mod = (await import(/* @vite-ignore */ modulePath)) as TestCredentialsModule;
  buildCredentialStore = mod.buildCredentialStore;
  CREDENTIAL_TO_ENV = mod.CREDENTIAL_TO_ENV;
  installAndHydrate = mod.installAndHydrate;
  ENV_VARS = Object.values(CREDENTIAL_TO_ENV);
});

describe("installAndHydrate", () => {
  let secretsDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    secretsDir = mkdtempSync(join(tmpdir(), "wg-creds-"));
    savedEnv = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
    for (const k of ENV_VARS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(secretsDir, { recursive: true, force: true });
  });

  it("is a no-op when no passphrase is provided", async () => {
    const result = await installAndHydrate(undefined, secretsDir);
    expect(result).toEqual({ status: "no-passphrase" });
    for (const k of ENV_VARS) expect(process.env[k]).toBeUndefined();
  });

  it("decrypts and hydrates env vars under the correct passphrase", async () => {
    const passphrase = "correct-horse-battery-staple";
    const { encrypted } = await buildCredentialStore(passphrase, secretsDir);
    await encrypted.put("anthropic-api-key", "sk-ant-test");
    await encrypted.put("openai-api-key", "sk-oai-test");

    const result = await installAndHydrate(passphrase, secretsDir);
    expect(result.status).toBe("hydrated");
    if (result.status !== "hydrated") return;
    expect([...result.hydrated].sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(process.env.OPENAI_API_KEY).toBe("sk-oai-test");
  });

  it("does not overwrite env vars already set in the shell", async () => {
    const passphrase = "p";
    const { encrypted } = await buildCredentialStore(passphrase, secretsDir);
    await encrypted.put("anthropic-api-key", "sk-ant-from-store");
    await encrypted.put("openai-api-key", "sk-oai-from-store");
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-shell";

    const result = await installAndHydrate(passphrase, secretsDir);
    expect(result.status).toBe("hydrated");
    if (result.status !== "hydrated") return;
    expect(result.hydrated).not.toContain("ANTHROPIC_API_KEY");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-from-shell");
    expect(process.env.OPENAI_API_KEY).toBe("sk-oai-from-store");
  });

  it("leaves env untouched when the passphrase is wrong", async () => {
    const { encrypted } = await buildCredentialStore("real-passphrase", secretsDir);
    await encrypted.put("anthropic-api-key", "sk-ant-test");

    const result = await installAndHydrate("wrong-passphrase", secretsDir);

    expect(result.status).toBe("locked");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("has nothing to do when the store holds no credentials", async () => {
    const result = await installAndHydrate("any-passphrase", secretsDir);
    expect(result).toEqual({ status: "nothing-to-do", present: [] });
  });

  /**
   * The point of the whole arrangement: something earlier in the process tree
   * has already hydrated, so this call must reach its answer without opening
   * the store. It is asserted as "did not decrypt" rather than as a duration,
   * by handing it a passphrase that could not possibly open this store — a
   * call that opened it would report `locked` instead.
   */
  it("skips the store entirely when every stored credential is already in env", async () => {
    const passphrase = "the-real-one";
    const { encrypted } = await buildCredentialStore(passphrase, secretsDir);
    await encrypted.put("anthropic-api-key", "sk-ant-test");
    await encrypted.put("openai-api-key", "sk-oai-test");
    process.env.ANTHROPIC_API_KEY = "sk-ant-already";
    process.env.OPENAI_API_KEY = "sk-oai-already";

    const result = await installAndHydrate("a-passphrase-that-cannot-open-this", secretsDir);

    expect(result.status).toBe("nothing-to-do");
    if (result.status !== "nothing-to-do") return;
    expect([...result.present].sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-already");
  });

  /** One credential short is still a reason to open the store, and only that one is decrypted into env. */
  it("opens the store when a stored credential is missing from env", async () => {
    const passphrase = "p";
    const { encrypted } = await buildCredentialStore(passphrase, secretsDir);
    await encrypted.put("anthropic-api-key", "sk-ant-test");
    await encrypted.put("openai-api-key", "sk-oai-test");
    process.env.ANTHROPIC_API_KEY = "sk-ant-already";

    const result = await installAndHydrate(passphrase, secretsDir);

    expect(result.status).toBe("hydrated");
    if (result.status !== "hydrated") return;
    expect(result.hydrated).toEqual(["OPENAI_API_KEY"]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-already");
    expect(process.env.OPENAI_API_KEY).toBe("sk-oai-test");
  });

  /**
   * Running the suite must not write to the credential folder. Hydrating used
   * to unlock unconditionally, and unlocking a store with no sentinel writes
   * one — so a test run left a file behind in `.secrets`.
   */
  it("does not write to the store", async () => {
    const before = readdirSync(secretsDir).sort();
    await installAndHydrate("any-passphrase", secretsDir);
    expect(readdirSync(secretsDir).sort()).toEqual(before);
  });
});
