# Workglow Agent Harness Eval

Runs Workglow's `AgentTask` loop, [opencode](https://github.com/sst/opencode) and
[pi](https://github.com/badlogic/pi-mono) on the same public agentic benchmarks, with the
same model, and compares them task by task.

The point is to steer work on `AgentTask`. A pass rate alone doesn't do that. What does is
seeing which tasks another harness solved and ours didn't, why ours failed, and whether a
change to the loop moves those tasks.

## How it works

[Harbor](https://harborframework.com) (the Terminal-Bench harness) runs everything:

- It builds each task's container and runs the agent inside it.
- It scores the result with the task's own tests.
- It ships maintained adapters for opencode and pi.
- Its registry carries Terminal-Bench 2.0, Aider Polyglot and SWE-bench Verified, among about
  seventy others.

This package adds three pieces:

| Piece                            | What it is                                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bin/workglow-agent.ts`      | A headless coding agent: `AgentTask` plus four tools (`read`, `bash`, `edit`, `write`). It runs one instruction and writes a summary, an event log and an ATIF trajectory. It is bundled into one Node file (`dist/workglow-agent.mjs`) so it runs in any task container. |
| `harbor/workglow_agent.py`       | The Harbor adapter. It installs Node, uploads the bundle and runs it. Because it uploads the bundle you just built, the eval measures your `libs` checkout.                                                                                                               |
| `src/bin/workglow-agent-eval.ts` | The driver. `run` puts every arm in one Harbor job, with parity settings, then writes the comparison. `compare` reads any Harbor job directories. `mock-model` serves a scripted model for offline checks.                                                                |

### What is held equal

Each harness's defaults differ in ways that would decide the result, so `run` sets them
explicitly:

|                                        | workglow                                           | opencode                                   | pi                                   |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| Turn cap (`--max-turns`, default 100)  | `max_rounds` (AgentTask's own default is 8)        | `agent.build.steps` (unlimited by default) | `max_turns` (unlimited by default)   |
| Reasoning (`--effort`, default `high`) | `effort`                                           | `variant` (`--opencode-variant`)           | `thinking` (pi defaults to `medium`) |
| Model                                  | `-m provider/model`, the same string for all three |                                            |                                      |
| Time limit                             | the task's own agent timeout, enforced by Harbor   |                                            |                                      |

Reasoning defaults to `high` rather than `off` because "off" does not mean the same thing
everywhere. On Claude 5.x, a request without `thinking` runs adaptive thinking. pi's `off`
and opencode's default omit the field, while Workglow sends Sonnet 5.5's real off switch.

**The tools are not held equal, deliberately.** The Workglow arm gets pi's default four,
with pi's limits: 2000 lines or 50KB per output, the tail for commands, and the head plus an
offset hint for reads. So the gap between the Workglow and pi columns measures the loop
around the tools. opencode's richer toolset (grep, glob, todo, subagents, a fuzzier edit) is
part of what its column measures.

## Getting started

```bash
uv tool install harbor            # Harbor 0.24+; needs Docker
bun install && bun run build-example   # in examples/agent-eval: bundles dist/workglow-agent.mjs

export ANTHROPIC_API_KEY=...      # whichever provider the model needs

# Does every arm install and run? hello-world + the 10-task Terminal-Bench sample
./dist/workglow-agent-eval.js run -m anthropic/claude-sonnet-5-5 -s smoke

# The decision set: Terminal-Bench 2.0 + Polyglot (Python/JS) + SWE-bench Verified 50
./dist/workglow-agent-eval.js run -m anthropic/claude-sonnet-5-5 -s core -n 8 -k 2
```

`run` writes `<jobs-dir>/<job>/comparison.md` and `comparison.json` and prints the Markdown.
To re-compare any Harbor jobs later, including ones run by hand or merged from several
machines:

```bash
./dist/workglow-agent-eval.js compare jobs/core-2026-10-06T18-00-00 [more job dirs…]
./dist/workglow-agent-eval.js compare jobs/ --format json --out comparison.json
```

`harbor view jobs/` shows each trial's trajectory. The Workglow arm writes ATIF, so it is
drawn the same way as the other two.

### Suites

`./dist/workglow-agent-eval.js suites` lists them:

| Suite                        | Contents                                                     | Exercises                                                              |
| ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `smoke`                      | `hello-world` + `terminal-bench-sample@2.0` (10)             | install and plumbing                                                   |
| `terminal-bench`             | Terminal-Bench 2.0 (89)                                      | long-horizon terminal work; context growth, command timeouts, recovery |
| `polyglot` / `polyglot-lite` | Aider Polyglot, all six languages (225) / Python and JS (83) | edit-run-fix cycles; edit reliability, reading test output             |
| `swebench-50`                | SWE-bench Verified, first 50                                 | navigating a large repository, minimal patches                         |
| `core`                       | the last three together                                      | the set to decide on                                                   |

For any other registry dataset, use `-d name@version` (repeatable). To narrow a run, use
`--tasks 'glob,glob'` and `-l N`.

To run task folders on disk instead — a downloaded dataset you have patched, or tasks of your
own — use `--tasks-dir <dir>` (repeatable). A host behind a TLS-intercepting proxy needs this:
the registry tasks fetch over HTTPS while their images build, before any compose overlay can
put the proxy's CA in the container, so the CA has to go into each task's Dockerfile.

### Ablations: testing a change to the loop

An arm is a harness plus agent kwargs. Extra arms run in the same job, on the same tasks:

```bash
./dist/workglow-agent-eval.js run -m anthropic/claude-sonnet-5-5 -s polyglot-lite \
  -a workglow --arm workglow:tool_concurrency=8 --arm workglow:max_history_chars=400000
```

The report labels arms by the kwargs that differ (`workglow[tool_concurrency=8]`), and pairs
them task by task like any other arms. For a change to `AgentTask` itself, edit `libs`, run
`bun run build-agent`, and re-run the same suite. The job config is saved beside the results,
so the before and after runs are the same experiment.

The Workglow kwargs (`--arm workglow:k=v`) are: `effort`, `max_rounds`,
`max_tool_result_chars`, `max_history_chars`, `tool_concurrency`, `max_tokens`,
`temperature`, `round_timeout_sec`, `max_round_retries`, `command_timeout_sec`,
`append_system_prompt`. opencode takes `opencode_config` and `variant`. pi takes `thinking`
and `max_turns`.

## Reading the report

- **Pass rate (95% CI)** uses a Wilson interval. Arms run on tens of tasks, so expect wide
  intervals. Use the head-to-head table to tell two arms apart, not the overlap of their
  intervals.
- **Head to head** pairs the arms on the tasks both ran. A task solved by both or by neither
  says nothing about which arm is better. The p-value is an exact sign test (McNemar) over the
  tasks where the arms differ, and those tasks are listed by name. Read their transcripts
  first.
- **Blocked** trials are excluded from every rate. These are trials where the container or
  the agent's install failed before the agent saw the task. Counting them as failures would
  charge a harness for a flaky registry.
- **Why runs failed** sorts failures into modes: `wrong-answer`, `agent-timeout`,
  `context-overflow`, `max-rounds`, `budget`, `rate-limit`, `provider-error`, `agent-crash`,
  `verifier-error`. The Workglow arm also reports outcomes, rounds, retries and tool error
  counts from the loop itself.
- **Cost.** Each harness prices its own runs. For the Workglow arm, that is `AgentTask`'s
  per-round step records. When a custom endpoint is configured, pi runs it as a provider with
  no price card, so its cost is blank.

## Offline check (no key, no bill)

`mock-model` serves a scripted Anthropic Messages API. Each reply calls the harness's `bash`
tool with the next scripted command, and replies in text once the script is used up. All
three harnesses can target an Anthropic base URL, so one mock serves the whole pipeline:

```bash
./dist/workglow-agent-eval.js mock-model -p 18089 \
  -c "echo 'Hello, world!' > hello.txt" --request-log requests.jsonl &
ANTHROPIC_BASE_URL=http://127.0.0.1:18089 ANTHROPIC_API_KEY=mock \
  ./dist/workglow-agent-eval.js run -m anthropic/claude-sonnet-5-5 -d hello-world@1.0 \
  --harbor-config hostnet.yaml
```

The task container has to reach the mock. On Linux, point a Harbor config at a compose
overlay that sets `network_mode: host` for the `main` service:

```yaml
environment:
  extra_docker_compose: [./hostnet.compose.yaml]
```

`requests.jsonl` captures what each harness actually sends the model: the system prompt, the
tool schemas, the thinking settings and the cache markers. That is the quickest way to see
how the three differ before spending anything.

The same mock drives `src/test/runCodingAgent.test.ts`, which runs the real provider, the
real `AgentTask` and the real tools in process.

## Running the Workglow agent by itself

```bash
node dist/workglow-agent.mjs -m anthropic/claude-sonnet-5-5 --cwd ./repo \
  --logs-dir ./logs --effort high "Fix the failing test in src/parse.ts"
```

Providers: `anthropic`, `openai`, `google`/`gemini`, `deepseek`, `xai`, `openrouter`. Keys
are read from the usual environment variables, and a custom endpoint from `<PROVIDER>_BASE_URL`.
