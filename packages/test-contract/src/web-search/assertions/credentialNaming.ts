/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSearchProviderRegistry, WebSearchTask } from "@workglow/web-search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decoyProvider, PROBE_QUERY, registerOnly, sentText } from "../fixtures";
import type { WebSearchConformanceHarness, WebSearchProviderConformanceOpts } from "../types";

const DECOY = "conformance-decoy";
const SECRET_KEY = "conformance-key-for-the-decoy";

/**
 * A credential is named for a provider, never for the request.
 *
 * `credential_keys` maps provider name to credential-store key, and the key
 * sent is the one named for the provider that RAN — so a key issued for one
 * vendor cannot leave with a request to another. That is not a tidiness rule:
 * a search API key is a bearer credential against a metered account, and one
 * forwarded to the wrong vendor has been disclosed to them.
 *
 * The bare `credential_key` port survives for a pinned provider, where the
 * vendor is unambiguous, and is refused under `"auto"` for the same reason:
 * routing picks the vendor at run time, so an unnamed key goes wherever it
 * lands.
 */
export function credentialNamingBlock(opts: WebSearchProviderConformanceOpts): void {
  describe("credential naming", () => {
    let harness: WebSearchConformanceHarness;

    beforeEach(async () => {
      harness = await opts.createHarness({ resultCount: 2 });
      registerOnly(harness);
    });

    afterEach(() => {
      harness.dispose();
      WebSearchProviderRegistry.clear();
    });

    it(
      "refuses a bare credential_key under auto",
      async () => {
        await expect(
          new WebSearchTask().run({
            query: PROBE_QUERY,
            provider: "auto",
            credential_key: SECRET_KEY,
          })
        ).rejects.toThrow(/credential_key.*auto|auto.*credential_key/s);
        expect(harness.sent()).toEqual([]);
      },
      opts.timeout
    );

    it(
      "never sends a key named for another provider",
      async () => {
        let decoyRan = false;
        WebSearchProviderRegistry.register(
          decoyProvider(DECOY, () => {
            decoyRan = true;
          })
        );

        await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          credential_keys: { [DECOY]: SECRET_KEY },
        });

        expect(decoyRan).toBe(false);
        // The pinned provider ran, and the decoy's key did not go with it.
        expect(sentText(harness)).not.toContain(SECRET_KEY);
      },
      opts.timeout
    );

    it(
      "refuses a key named for a provider that is not registered",
      async () => {
        await expect(
          new WebSearchTask().run({
            query: PROBE_QUERY,
            provider: harness.provider.name,
            credential_keys: { "not-a-provider": SECRET_KEY },
          })
        ).rejects.toThrow(/not a .*registered provider/s);
        expect(harness.sent()).toEqual([]);
      },
      opts.timeout
    );

    it(
      "says so when this provider never receives a credential key",
      async () => {
        const run = new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          credential_keys: { [harness.provider.name]: SECRET_KEY },
        });

        if (harness.provider.acceptsCredentialKey) {
          await expect(run).resolves.toBeDefined();
          return;
        }
        // An adapter authenticating through its own vendor client ignores the
        // field, so naming a key for it is refused rather than dropped in
        // silence — a caller who thinks they configured auth and did not is how
        // a request goes out unauthenticated and nobody hears about it.
        await expect(run).rejects.toThrow(/never receives a credential-store key/);
        expect(harness.sent()).toEqual([]);
      },
      opts.timeout
    );

    it(
      "prefers a provider a key is named for when routing",
      async () => {
        let decoyRan = false;
        WebSearchProviderRegistry.register(
          decoyProvider(DECOY, () => {
            decoyRan = true;
          })
        );

        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: "auto",
          credential_keys: { [DECOY]: SECRET_KEY },
        });

        // Naming a key states which vendors the caller actually holds one for.
        // Without this preference, routing lands on whoever registered first
        // and the request goes out unauthenticated while a usable key sits
        // behind it.
        expect(out.provider).toBe(DECOY);
        expect(decoyRan).toBe(true);
        expect(harness.sent()).toEqual([]);
      },
      opts.timeout
    );
  });
}
