/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRegisterOptions } from "@workglow/ai";
import { registerProviderWithWorker } from "@workglow/ai/provider-utils";
import { TypeSafeAiQueuedProvider } from "./TypeSafeAiQueuedProvider";

export async function registerTypeSafeAi(
  options: AiProviderRegisterOptions & {
    worker: Worker | (() => Worker);
  }
): Promise<void> {
  await registerProviderWithWorker(new TypeSafeAiQueuedProvider(), "TypeSafe", options);
}
