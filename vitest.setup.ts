/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import "./scripts/configure-hft-test-cache";
import "./scripts/lib/preload-credentials";

// Workglow no longer self-registers defaults at import time. Tests rely on
// the global registry being populated, so bootstrap once here. Imported by
// source path rather than as `@workglow/bootstrap`: the isolated linker keeps
// workspace packages out of the repo root's node_modules.
//
// `bootstrapWorkglow()` rather than `registerAllDefaults(globalServiceRegistry)`
// because `globalServiceRegistry` is likewise unresolvable from this file: a
// root-level `@workglow/util` import fails outright, and reaching into
// `packages/util/src` would load a second copy of the module — a different
// registry object from the one the tests read through `@workglow/util`.
import { bootstrapWorkglow } from "./packages/bootstrap/src/bootstrap/bootstrapWorkglow";
bootstrapWorkglow();
