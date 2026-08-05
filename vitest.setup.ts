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
import { registerAllDefaults } from "./packages/bootstrap/src/bootstrap/registerAllDefaults";
registerAllDefaults();
