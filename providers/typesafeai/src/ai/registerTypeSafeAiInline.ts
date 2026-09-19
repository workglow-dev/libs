/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRegisterOptions } from "@workglow/ai";
import { registerProviderInline } from "@workglow/ai/provider-utils";
import { TYPESAFEAI_RUN_FNS } from "./common/TypeSafeAi_JobRunFns";
import { TypeSafeAiQueuedProvider } from "./TypeSafeAiQueuedProvider";

export async function registerTypeSafeAiInline(options?: AiProviderRegisterOptions): Promise<void> {
  await registerProviderInline(
    new TypeSafeAiQueuedProvider(TYPESAFEAI_RUN_FNS),
    "TypeSafe",
    options
  );
}
