/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { runTabularMigrationContract } from "@workglow/test-contract/tabular-migrations";
import { createFsFolderContractHandle } from "./fsFolderContractFactory";

runTabularMigrationContract({
  name: "FsFolder",
  enforcesDdl: false,
  persistentBookkeeping: true,
  factory: createFsFolderContractHandle,
});
