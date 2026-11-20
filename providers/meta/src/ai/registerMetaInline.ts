/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRegisterOptions } from "@workglow/ai";
import { registerProviderInline } from "@workglow/ai/provider-utils";
import { META_PREVIEW_TASKS, META_RUN_FNS } from "./common/Meta_JobRunFns";
import { MetaQueuedProvider } from "./MetaQueuedProvider";

export async function registerMetaInline(options?: AiProviderRegisterOptions): Promise<void> {
  await registerProviderInline(
    new MetaQueuedProvider(META_RUN_FNS, META_PREVIEW_TASKS),
    "Meta",
    options
  );
}
