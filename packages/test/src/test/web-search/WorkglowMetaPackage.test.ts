/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { createGraphFromGraphJSON as CreateGraphFromGraphJSON } from "@workglow/task-graph";
import type {
  registerBuiltInWebSearchProviders as RegisterBuiltInWebSearchProviders,
  WebSearchProviderRegistry as WebSearchProviderRegistryInstance,
  WebSearchTask as WebSearchTaskClass,
} from "@workglow/web-search";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const metaRoot = new URL("../../../../workglow/", import.meta.url);

interface MetaBarrel {
  readonly WebSearchTask: typeof WebSearchTaskClass | undefined;
  readonly WebSearchProviderRegistry: typeof WebSearchProviderRegistryInstance | undefined;
  readonly registerBuiltInWebSearchProviders: typeof RegisterBuiltInWebSearchProviders | undefined;
  readonly createGraphFromGraphJSON: typeof CreateGraphFromGraphJSON;
}

/**
 * A host that installs `workglow` rather than reaching for each package by name
 * has to be able to open a saved graph naming `WebSearchTask`, the same way it
 * opens one naming `A2UISurfaceTask` or `A2AAgentTask`. The barrel is imported
 * from source by path because nothing in the workspace depends on the meta
 * package; the manifest is read too, since a re-export without the dependency
 * resolves here and fails for anyone installing the published package. This
 * file value-imports nothing from `@workglow/web-search` itself, so in a fresh
 * module registry the barrel is the only thing that can register the task.
 */
describe("the workglow meta package and @workglow/web-search", () => {
  let meta: MetaBarrel;

  beforeAll(async () => {
    const barrel: string = new URL("src/common.ts", metaRoot).href;
    meta = (await import(barrel)) as MetaBarrel;
  });

  it("declares the dependency", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", metaRoot), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(manifest.dependencies?.["@workglow/web-search"]).toBeDefined();
  });

  it("re-exports the task and the provider registration", () => {
    expect(meta.WebSearchTask?.type).toBe("WebSearchTask");
    expect(meta.WebSearchProviderRegistry).toBeDefined();
    expect(typeof meta.registerBuiltInWebSearchProviders).toBe("function");
  });

  it("opens a saved graph that names WebSearchTask", () => {
    const graph = meta.createGraphFromGraphJSON({
      tasks: [{ id: "search", type: "WebSearchTask", defaults: { query: "workglow" } }],
      dataflows: [],
    });
    expect(meta.WebSearchTask).toBeDefined();
    expect(graph.getTask("search")).toBeInstanceOf(meta.WebSearchTask!);
  });
});
