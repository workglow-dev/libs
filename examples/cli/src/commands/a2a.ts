/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Command } from "commander";
import { registerA2AServeCommand } from "./a2aServe";

/** The `a2a` group: this CLI's saved agents, offered to Agent2Agent peers. */
export function registerA2ACommand(program: Command): void {
  const a2a = program.command("a2a").description("Serve saved agents to A2A peers");
  registerA2AServeCommand(a2a);
}
