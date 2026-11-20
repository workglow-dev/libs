/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerProviderWorker } from "@workglow/ai/provider-utils";
import { META_PREVIEW_TASKS, META_RUN_FNS } from "./common/Meta_JobRunFns.browser";
import { MetaProvider } from "./MetaProvider";

export async function registerMetaWorker(): Promise<void> {
  await registerProviderWorker(
    (ws) => new MetaProvider(META_RUN_FNS, META_PREVIEW_TASKS).registerOnWorkerServer(ws),
    "Meta"
  );
}
