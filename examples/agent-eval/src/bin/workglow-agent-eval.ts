#!/usr/bin/env bun

/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { loadTrials } from "../compare/harborJobs";
import { buildReport, renderMarkdown } from "../compare/report";
import { startAnthropicMock } from "../mock/anthropicMock";
import type { ArmSpec, Effort } from "../run/jobConfig";
import { buildHarborJob, EFFORTS, HARNESSES, parseArm } from "../run/jobConfig";
import { runHarbor } from "../run/runHarbor";
import type { JobDataset } from "../run/suites";
import { getSuite, SUITES } from "../run/suites";

function positiveInteger(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`expected a positive integer, got ${value}`);
  return n;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function writeReport(
  paths: readonly string[],
  format: string,
  out: string | undefined,
  allTasks: boolean
): void {
  const trials = loadTrials(paths);
  if (trials.length === 0) throw new Error(`no Harbor trial results under ${paths.join(", ")}`);
  const report = buildReport(trials);
  const text =
    format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMarkdown(report, { allTasks });
  if (out) {
    writeFileSync(out, text);
    process.stderr.write(`wrote ${out}\n`);
  } else process.stdout.write(text);
}

const program = new Command()
  .name("workglow-agent-eval")
  .version("0.1.0")
  .description(
    "Compare Workglow's AgentTask with opencode and pi on public agentic benchmarks, through Harbor"
  );

program
  .command("suites")
  .description("List the named benchmark suites")
  .action(() => {
    for (const [name, suite] of Object.entries(SUITES)) {
      const datasets = suite.datasets
        .map(
          (d) =>
            `${d.name}@${d.version}${d.task_names ? ` ${d.task_names.join(" ")}` : ""}${d.n_tasks ? ` (first ${d.n_tasks})` : ""}`
        )
        .join(" + ");
      process.stdout.write(
        `${name.padEnd(16)} ${suite.description}\n${"".padEnd(16)} ${datasets}\n`
      );
    }
  });

program
  .command("run")
  .description("Run every arm on a suite in one Harbor job, then write the comparison")
  .requiredOption(
    "-m, --model <provider/model>",
    "the model every arm uses, e.g. anthropic/claude-sonnet-5-5"
  )
  .option("-s, --suite <name>", "benchmark suite (see `suites`)", "smoke")
  .option(
    "-d, --dataset <name@version>",
    "run this registry dataset instead of a suite (repeatable)",
    collect
  )
  .option(
    "--tasks-dir <dir>",
    "run the Harbor task folders in this directory instead of a suite (repeatable)",
    collect
  )
  .option(
    "-a, --agents <list>",
    `comma-separated harnesses: ${HARNESSES.join(",")}`,
    HARNESSES.join(",")
  )
  .option(
    "--arm <spec>",
    "an extra arm, e.g. workglow:tool_concurrency=8 (repeatable; agent kwargs as key=value)",
    collect
  )
  .addOption(
    new Option("--effort <level>", "reasoning level for every arm")
      .choices([...EFFORTS])
      .default("high")
  )
  .option("--opencode-variant <name>", "opencode's name for that reasoning level", "high")
  .option("--max-turns <n>", "model calls each arm may make", positiveInteger, 100)
  .option("-k, --attempts <n>", "attempts per task per arm", positiveInteger, 1)
  .option("-n, --concurrency <n>", "trials run at once", positiveInteger, 4)
  .option("--tasks <globs>", "only tasks matching these comma-separated globs")
  .option("-l, --n-tasks <n>", "at most this many tasks per dataset", positiveInteger)
  .option("--timeout-multiplier <x>", "scale every task's agent and verifier timeouts", Number)
  .option(
    "--pi-model-api <api>",
    "pi's wire API when the provider base URL is overridden (e.g. anthropic-messages)"
  )
  .option(
    "--harbor-config <path>",
    "extra Harbor config layered on the generated one (repeatable)",
    collect
  )
  .option("--jobs-dir <dir>", "where Harbor writes results", "./jobs")
  .option("--job-name <name>", "Harbor job name (default <suite>-<timestamp>)")
  .option("--harbor <bin>", "the harbor executable", "harbor")
  .option("--dry-run", "print the Harbor job config and exit")
  .action(async (opts) => {
    const custom = opts.dataset !== undefined || opts.tasksDir !== undefined;
    const suite = custom ? undefined : getSuite(opts.suite);
    const suiteDatasets: JobDataset[] = suite
      ? [...suite.datasets]
      : [
          ...((opts.dataset as string[] | undefined) ?? []).map((spec) => {
            const at = spec.lastIndexOf("@");
            if (at <= 0) throw new Error(`dataset must be name@version, got "${spec}"`);
            return { name: spec.slice(0, at), version: spec.slice(at + 1) };
          }),
          ...((opts.tasksDir as string[] | undefined) ?? []).map((dir) => ({
            path: resolve(dir),
          })),
        ];
    const arms: ArmSpec[] = [
      ...String(opts.agents)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        .map(parseArm),
      ...((opts.arm as string[] | undefined) ?? []).map(parseArm),
    ];
    if (arms.length === 0) throw new Error("no arms to run");
    const taskFilter = opts.tasks
      ? String(opts.tasks)
          .split(",")
          .map((glob) => glob.trim())
      : undefined;
    const datasets = suiteDatasets.map((dataset) => ({
      ...dataset,
      ...(taskFilter ? { task_names: taskFilter } : {}),
      ...(opts.nTasks ? { n_tasks: opts.nTasks } : {}),
    }));
    const piModelApi =
      opts.piModelApi ??
      (String(opts.model).startsWith("anthropic/") && process.env.ANTHROPIC_BASE_URL
        ? "anthropic-messages"
        : undefined);
    const jobName = opts.jobName ?? `${suite ? opts.suite : "custom"}-${timestamp()}`;
    const config = buildHarborJob({
      jobName,
      jobsDir: opts.jobsDir,
      model: opts.model,
      arms,
      datasets,
      parity: {
        maxTurns: opts.maxTurns,
        effort: opts.effort as Effort,
        opencodeVariant: opts.opencodeVariant || undefined,
        piModelApi,
      },
      attempts: opts.attempts,
      concurrency: opts.concurrency,
      timeoutMultiplier: opts.timeoutMultiplier,
    });
    if (opts.dryRun) {
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      return;
    }
    const { jobDir, exitCode } = await runHarbor({
      config,
      extraConfigs: (opts.harborConfig as string[] | undefined) ?? [],
      harbor: opts.harbor,
    });
    if (!existsSync(jobDir)) throw new Error(`harbor exited with ${exitCode} and wrote no results`);
    if (exitCode !== 0)
      process.stderr.write(`harbor exited with ${exitCode}; comparing what it wrote\n`);
    const report = buildReport(loadTrials([jobDir]));
    const markdown = renderMarkdown(report);
    writeFileSync(`${jobDir}/comparison.md`, markdown);
    writeFileSync(`${jobDir}/comparison.json`, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\n${markdown}\nwrote ${jobDir}/comparison.md and comparison.json\n`);
  });

program
  .command("compare")
  .description("Compare the trials in one or more Harbor job directories")
  .argument("<paths...>", "Harbor job directories, or a jobs directory holding several")
  .addOption(
    new Option("-f, --format <format>", "output format").choices(["md", "json"]).default("md")
  )
  .option("-o, --out <file>", "write to a file instead of stdout")
  .option("--all-tasks", "list every task, not only those where the arms differ")
  .action((paths: string[], opts) => writeReport(paths, opts.format, opts.out, !!opts.allTasks));

program
  .command("mock-model")
  .description("Serve a scripted Anthropic Messages API for an offline end-to-end check")
  .option("-p, --port <port>", "port", positiveInteger, 18089)
  .option("--host <host>", "interface to listen on", "127.0.0.1")
  .option("-c, --command <cmd>", "shell command the model runs, in order (repeatable)", collect)
  .option("--request-log <file>", "append every request body to this JSONL file")
  .action(async (opts) => {
    const commands = (opts.command as string[] | undefined) ?? ["echo 'Hello, world!' > hello.txt"];
    await startAnthropicMock({
      port: opts.port,
      host: opts.host,
      commands,
      requestLog: opts.requestLog,
    });
    process.stderr.write(
      `mock Anthropic API on http://${opts.host}:${opts.port} running ${commands.length} command(s)\n` +
        `point the arms at it with ANTHROPIC_BASE_URL=http://${opts.host}:${opts.port} ANTHROPIC_API_KEY=mock\n`
    );
    await new Promise(() => {});
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(
    `workglow-agent-eval: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
