/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's root, found from this module whether it runs from src or a bundle in dist. */
export function packageRoot(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "harbor", "workglow_agent.py"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("cannot find the agent-eval package root (harbor/workglow_agent.py)");
}

export interface HarborRun {
  readonly config: Record<string, unknown>;
  /** Extra Harbor config files layered after the generated one (environment overlays and the like). */
  readonly extraConfigs: readonly string[];
  readonly harbor: string;
}

interface HarborAgentConfig {
  readonly import_path?: string;
  readonly kwargs?: Record<string, unknown>;
}

/**
 * What stops a workglow arm from finding the agent bundle it would upload, if
 * anything. An arm's own `bundle_path` wins over the shared one, as it does in
 * the adapter, which expands `~` and resolves it from the same working directory.
 */
export function missingBundle(
  agents: readonly HarborAgentConfig[],
  bundle: string
): string | undefined {
  for (const agent of agents) {
    if (!agent.import_path?.startsWith("workglow_agent")) continue;
    const own = agent.kwargs?.bundle_path;
    if (typeof own === "string" && own.length > 0) {
      const path = resolve(own.replace(/^~(?=$|\/)/, homedir()));
      if (!existsSync(path)) return `the workglow arm's bundle_path ${path} does not exist`;
    } else if (!existsSync(bundle)) {
      return `the workglow arm needs ${bundle}; run \`bun run build-agent\` first`;
    }
  }
  return undefined;
}

/**
 * Writes the job config beside the job's results and runs `harbor run` on it,
 * with the workglow adapter importable and the bundle it uploads located.
 * Harbor's own progress display goes straight to the terminal.
 */
export async function runHarbor(run: HarborRun): Promise<{ jobDir: string; exitCode: number }> {
  const root = packageRoot();
  const bundle = process.env.WORKGLOW_AGENT_BUNDLE ?? join(root, "dist", "workglow-agent.mjs");
  const jobsDir = resolve(String(run.config.jobs_dir));
  const jobDir = join(jobsDir, String(run.config.job_name));
  mkdirSync(jobsDir, { recursive: true });
  const configPath = join(jobsDir, `${String(run.config.job_name)}.config.json`);
  writeFileSync(configPath, JSON.stringify({ ...run.config, jobs_dir: jobsDir }, null, 2));

  const problem = missingBundle(run.config.agents as readonly HarborAgentConfig[], bundle);
  if (problem !== undefined) throw new Error(problem);

  const args = [
    "run",
    "-c",
    configPath,
    ...run.extraConfigs.flatMap((path) => ["-c", resolve(path)]),
  ];
  const env = {
    ...process.env,
    PYTHONPATH: [join(root, "harbor"), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    WORKGLOW_AGENT_BUNDLE: bundle,
  };
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(run.harbor, args, { stdio: "inherit", env });
    child.on("error", (error) =>
      reject(
        new Error(
          `could not start ${run.harbor} (${error.message}); install Harbor with \`uv tool install harbor\``
        )
      )
    );
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
  return { jobDir, exitCode };
}
