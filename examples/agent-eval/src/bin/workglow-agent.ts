#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The headless Workglow coding agent: AgentTask plus the four coding tools,
 * run once on one instruction. It is what the Harbor adapter installs into a
 * task container — the counterpart of `opencode run` and `pi --print` — so it
 * is bundled into one file with every dependency and needs only Node.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { toAtifTrajectory } from "../agent/atif";
import { parseEffort, resolveAgentModel } from "../agent/models";
import { registerAgentProvider } from "../agent/providers";
import type { AgentRunEvent } from "../agent/runCodingAgent";
import {
  DEFAULT_BENCH_MAX_ROUNDS,
  DEFAULT_BENCH_MAX_TOOL_RESULT_CHARS,
  runCodingAgent,
} from "../agent/runCodingAgent";
import { REVIEW_PROMPT } from "../agent/systemPrompt";

const VERSION = "0.1.0";

function integer(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`expected a positive integer, got ${value}`);
  return n;
}

/** `on`/`off` switches, spelled so Harbor agent kwargs pass them through as strings. */
function onOff(value: string): boolean {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error(`expected on or off, got ${value}`);
}

function number(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${value}`);
  return n;
}

function describe(event: AgentRunEvent): string | undefined {
  switch (event.type) {
    case "start":
      return `workglow-agent ${VERSION} · ${event.model} · ${event.cwd}`;
    case "tool-call":
      return event.status === "running" ? `  → ${event.name ?? "?"}` : undefined;
    case "round": {
      const usage = event.step.usage;
      const tokens = usage
        ? ` · ${usage.input ?? 0}+${usage.cached ?? 0} in / ${usage.output ?? 0} out`
        : "";
      return `round ${event.step.round} · ${event.step.tools.length} tool(s)${tokens}`;
    }
    case "finish":
      return `finished: ${event.summary.outcome}${event.summary.error ? ` (${event.summary.error})` : ""}`;
  }
}

const program = new Command()
  .name("workglow-agent")
  .version(VERSION)
  .description("Run Workglow's AgentTask with coding tools on one instruction")
  .argument("[instruction...]", "the task; or pass --instruction-file")
  .requiredOption("-m, --model <provider/model>", "model, e.g. anthropic/claude-sonnet-4-5")
  .option("--instruction-file <path>", "read the instruction from a file")
  .option("--cwd <dir>", "working directory", process.cwd())
  .option("--logs-dir <dir>", "where the events, summary and trajectory are written")
  .option("--effort <level>", "reasoning effort: none|low|medium|high|extra|ultra")
  .option("--max-rounds <n>", "model calls before the run stops", integer, DEFAULT_BENCH_MAX_ROUNDS)
  .option(
    "--max-tool-result-chars <n>",
    "characters of one tool result the model is shown",
    integer,
    DEFAULT_BENCH_MAX_TOOL_RESULT_CHARS
  )
  .option(
    "--max-history-chars <n>",
    "history budget sent per round (AgentTask default if unset)",
    integer
  )
  .option("--tool-concurrency <n>", "tool calls of one round run at once", integer)
  .option("--max-tokens <n>", "output tokens per model call", integer)
  .option("--temperature <t>", "sampling temperature", number)
  .option("--max-duration-sec <n>", "wall-clock budget; no round starts after it", integer)
  .option("--round-timeout-sec <n>", "abandon and retry a model call after this long", integer)
  .option("--max-round-retries <n>", "retries of a failed model call", Number)
  .option("--command-timeout-sec <n>", "default bash timeout", integer, 120)
  .option("--append-system-prompt <text>", "text appended to the system prompt")
  .option("--concise <on|off>", "ask for terse replies between tool calls", onOff, true)
  .option("--images <on|off>", "let read show images to the model", onOff, true)
  .option(
    "--replay-reasoning <on|off>",
    "send the model's reasoning back on later rounds (providers that take it)",
    onOff,
    true
  )
  .option(
    "--time-left <on|off>",
    "show the model its remaining time each round (needs --max-duration-sec)",
    onOff,
    true
  )
  .option("--review <on|off>", "ask the model to check its work once before finishing", onOff, true)
  .action(async (words: string[], opts) => {
    const instruction = opts.instructionFile
      ? readFileSync(opts.instructionFile, "utf8")
      : words.join(" ");
    if (instruction.trim() === "") throw new Error("no instruction given");

    const resolved = resolveAgentModel(opts.model, { effort: parseEffort(opts.effort) });
    // An ablation switch for the provider's reasoning replay; only DeepSeek reads it today.
    const model = opts.replayReasoning
      ? resolved
      : ({
          ...resolved,
          provider_config: { ...resolved.provider_config, replay_reasoning: false },
        } as typeof resolved);
    await registerAgentProvider(model.provider);

    const cwd = resolve(opts.cwd);
    const logsDir = opts.logsDir ? resolve(opts.logsDir) : undefined;
    if (logsDir) mkdirSync(logsDir, { recursive: true });
    const eventsPath = logsDir ? join(logsDir, "workglow-events.jsonl") : undefined;

    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => controller.abort(new Error(`received ${signal}`)));
    }

    const result = await runCodingAgent({
      instruction,
      modelId: opts.model,
      model,
      tools: {
        cwd,
        spillDir: join(logsDir ?? tmpdir(), "spill"),
        defaultCommandTimeoutSec: opts.commandTimeoutSec,
        images: opts.images,
      },
      settings: {
        maxRounds: opts.maxRounds,
        maxToolResultChars: opts.maxToolResultChars,
        maxHistoryChars: opts.maxHistoryChars,
        toolConcurrency: opts.toolConcurrency,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        maxDurationMs: opts.maxDurationSec === undefined ? undefined : opts.maxDurationSec * 1000,
        roundTimeoutMs:
          opts.roundTimeoutSec === undefined ? undefined : opts.roundTimeoutSec * 1000,
        maxRoundRetries: opts.maxRoundRetries,
        systemPromptAppend: opts.appendSystemPrompt,
        concise: opts.concise,
        announceTimeLeft: opts.timeLeft,
        reviewPrompt: opts.review ? REVIEW_PROMPT : undefined,
      },
      signal: controller.signal,
      onEvent: (event) => {
        const line = describe(event);
        if (line) process.stderr.write(`${line}\n`);
        if (eventsPath) appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
      },
    });

    if (logsDir) {
      writeFileSync(
        join(logsDir, "workglow-summary.json"),
        JSON.stringify(result.summary, null, 2)
      );
      const trajectory = toAtifTrajectory(
        `workglow-${Date.now()}`,
        VERSION,
        result.messages,
        result.steps,
        result.summary
      );
      writeFileSync(join(logsDir, "trajectory.json"), JSON.stringify(trajectory, null, 2));
    }
    if (result.summary.finalText) process.stdout.write(`${result.summary.finalText}\n`);
    process.exitCode =
      result.summary.outcome === "error" || result.summary.outcome === "aborted" ? 1 : 0;
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(
    `workglow-agent: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 2;
}
// Provider SDKs can hold sockets open; the run is over.
process.exit(process.exitCode ?? 0);
