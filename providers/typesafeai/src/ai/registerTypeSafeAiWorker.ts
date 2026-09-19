/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerProviderWorker } from "@workglow/ai/provider-utils";
import { TYPESAFEAI_RUN_FNS } from "./common/TypeSafeAi_JobRunFns";
import { TypeSafeAiProvider } from "./TypeSafeAiProvider";

export async function registerTypeSafeAiWorker(): Promise<void> {
  await registerProviderWorker(
    (ws) => new TypeSafeAiProvider(TYPESAFEAI_RUN_FNS).registerOnWorkerServer(ws),
    "TypeSafe"
  );
}
