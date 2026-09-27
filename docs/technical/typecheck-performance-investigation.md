# Typecheck performance investigation

_Investigation of the gradual `tsc` typecheck slowdown across the monorepo, with
bisected culprit commits, root-cause analysis, and the guardrail added to catch
future regressions._

## TL;DR

- Full-graph typecheck (pinned `tsc`, each commit's own deps) grew from **~11s
  (mid-Feb 2026) to ~40s today (~3.6×)**.
- Two regressions were isolated by `git bisect`:
  1. **`16a94b54`** — MCP task schemas switched to spreading `…properties` +
     `allOf`, exploding `packages/tasks` instantiations **289k → 6.77M (23×)**.
     _Already fixed_ (tasks is back to ~207k).
  2. **`888da0e1`** ("image generation pipeline with ImageValue boundary") — a
     task-runner refactor that **doubled `packages/ai` isolated check time
     (0.9s → 3.4s)**. _Still in main._
- The `888da0e1` cost is **diffuse** in the core task/`Workflow` generics, not in
  any single construct. Four candidate fixes were prototyped and **measured to be
  ineffective or net-negative** (see below). There is no surgical fix.
- A **CI guard** (`scripts/typecheck-budget.ts`) now gates per-package
  instantiation counts so future spikes fail at PR time.

## Method

To compare fairly across time, the **compiler was held constant** (a pinned
standalone `tsc`) while **each commit's own dependencies** were installed, so the
only variables were source + `tsconfig`. Two metrics were used:

- **End-to-end wall clock** of a full build — what a developer feels.
- **Isolated per-package check** — warm-build all packages to emit dependency
  `.d.ts`, then `tsc -p <pkg> --extendedDiagnostics` with the package's
  `tsbuildinfo` removed to force a full re-check. **Instantiations** is the
  headline number: it is deterministic and machine-independent, unlike wall time.

> Caveat, as measured: these numbers came from `tsc` while the repo's
> `build-types` ran **`tsgo`** per package, which is much faster and masked code
> regressions in day-to-day builds. That split is gone — the repo is on
> TypeScript 7, where `tsc` **is** the native compiler, so both paths now run the
> same thing and the instantiation counts below are not comparable to what the
> budget guard records today. The relative trends still hold.

## Timeline

| Date | Full-graph wall | `packages/test` | `packages/ai` | `packages/tasks` | # packages |
| --- | --- | --- | --- | --- | --- |
| Feb 12 | ~11s | 4.4s | 0.6s | 0.9s | 11 |
| Mar 13 | ~24s | **15.0s** | 0.8s | 1.4s _(6.7M inst)_ | 12 |
| Apr 1 | ~22s | 6.3s | 0.8s | 1.5s | 10 |
| Apr 15 | ~30s | 7.9s | 0.9s | 2.5s | 10 |
| May 1 | ~27s | 8.6s | **3.4s** | 3.1s | 10 |
| May 15 | ~36s | 11.1s | 3.3s | 1.9s | 28 |
| May 28 | ~42s | 11.3s | 3.4s | 1.9s | 34 |
| Jun 7 (main) | ~40s | 12.4s | 3.4s | 2.0s | 34 |

Notes:
- The **Mar 13 spike** in `test`/`tasks` is `16a94b54` (fixed by Apr 1).
- The **`ai` step from 0.9s → 3.4s** between Apr 15 and May 1 is `888da0e1`, and
  it persists to today.
- The package-count jump (10 → 28 → 34) in mid-May is the **provider split**
  (`packages/ai-provider` broken into individual `providers/*`). This is
  legitimate structural growth, not a bug, but it is the largest single
  contributor to the recent wall-clock increase.

## Culprit 1 — `16a94b54` (MCP `allOf`), already fixed

The change spread `mcpServerConfigSchema.properties` and `allOf:
mcpServerConfigSchema.allOf` into four MCP task schemas, each declared
`as const satisfies DataPortSchema`. That forced four deep instantiations of a
heavily reworked `McpAuthTypes` union, taking `packages/tasks` from ~289k to
**6.77M** instantiations. It was resolved between Mar 13 and Apr 1.

**Lesson:** spreading large composed schemas (`allOf` / `…properties`) into
multiple `as const satisfies` sites multiplies instantiation cost. The CI guard
below would have caught this at PR time.

## Culprit 2 — `888da0e1` (durable `ai` regression)

`888da0e1` is a large task-runner refactor (`ITask.ts`, `Task.ts`,
`TaskRunner.ts` +169, `TaskGraphRunner.ts` +132, plus the ImageValue work). Its
edits to `ToolCallingTask.ts` itself were trivial (an import reorder and a
category-string rename), so the regression is **not** in AI task code — it is in
the **base generics every task instantiates**.

A `--generateTrace` of `packages/ai` attributes the time to
`ToolCallingTask.ts` (~1.3–2.6s) and `registerAiTasks.ts` (~1.0s), surfacing as
`structuredTypeRelatedTo` / `getVariancesWorker` over `Workflow<I,O>` and
`CreateWorkflow<I,O,C>`. But that attribution is **misleading**: variance is
computed once and cached, so the cost lands on whichever expression touches
`Workflow` first. Aggregated by event name, `ai`'s ~3.4s is dominated by deeply
nested `structuredTypeRelatedTo` (the structural comparison of large `Workflow`
instantiations), with `getVariancesWorker` nested inside it.

### Why it is hard to fix

Each `Workflow.prototype.<name> = CreateWorkflow(<Task>)` assignment relates two
**distinct** `Workflow<I,O>` instantiations (the inferred `I` from the task class
is a fresh type-parameter, different from the `I` written in the `declare module`
augmentation), so there is no reference-identity short-circuit and the full
structural relation runs over the heavily augmented `Workflow` interface (one
builder method per registered task — ~124 across the repo). The cost scales
super-linearly with the number of augmentations, which `888da0e1` increased by
adding `imageGenerate` / `imageEdit`.

### Fixes prototyped and measured (all rejected)

Measured on the real metric (dependencies pre-built, isolated `tsc -p ai`,
0 errors), baseline `ai` = 3.4s:

| Attempt | Result |
| --- | --- |
| Replace `FromSchema<…>` input type in `ToolCallingTask` with a hand-written interface | 3.4s → 3.4s (no effect) |
| Replace `WithImageValuePorts<…>` image-task types with explicit interfaces | image/vision tasks are already ~13ms each — no meaningful effect |
| Restore the `tsBuildInfoFile` line `888da0e1` deleted from root `tsconfig.json` | 3.38s vs 3.58s — **no real effect**; it only changes `tsc -b` orchestration and actually breaks solution builds (`TS6377` buildinfo collision). The "fast" number some measurements showed was an artifact of the build bailing out and leaving deps unbuilt. |
| Declare correct variance `Workflow<in out Input, out Output>` (+ narrow the 5 bare-`Workflow` `return this` methods) | task-graph compiles clean and emits the annotated `.d.ts`, but `ai` is unchanged (3.4s → 3.58s). Declaring variance removes `getVariancesWorker` but the **structural relation still runs**, and variance is also computed for `TaskConfig` / `CreateWorkflow` / `DataPorts` which one annotation does not touch. |

### Remaining options for the durable `ai` cost

There is no surgical fix. Real remediation is either:

- **Architectural** — rethink how `Workflow` is augmented (124 `CreateWorkflow<…>`
  member instantiations in a single mega-interface) and/or how AI task input
  types are derived, so the prototype assignments don't each relate a large
  `Workflow<I,O>`. This is a multi-day design effort and must be validated under
  the compiler before investing — at the time that meant **both** `tsc` and
  `tsgo`, which TypeScript 7 has since collapsed into one.
- **Operational** — confirm whether the user-felt slowness is `tsserver` vs
  `build-types`. When this was written those ran different compilers (`tsc` and
  `tsgo`) and the latter largely sidestepped the problem; on TypeScript 7 they
  are the same binary. The biggest absolute cost, `packages/test` (~12s), is mostly legitimate
  file-count growth exercising the same machinery ×N and is not addressed by any
  of the above.

## Guardrail added: `scripts/typecheck-budget.ts`

A CI guard that type-checks each composite package in isolation and compares its
**instantiation count** against committed per-package budgets
(`scripts/typecheck-budget.json`, default tolerance +15%, or +2,000
instantiations where that is more generous). Every composite package carries an
entry, and one the file does not name fails the check until `--update` records
it — otherwise a newly added package is measured and gated by nothing.
Instantiations are deterministic and
machine-independent, so the gate is stable across runners while catching exactly
the class of regression documented here.

```sh
bun run typecheck:budget            # check; exit 1 on regression
bun run typecheck:budget --update   # re-baseline intentional growth
bun run typecheck:budget --json     # emit raw measurements
```

Wired into `.github/workflows/test.yml` as the `typecheck-budget` job. Both
culprit commits above would have failed it (`tasks` +23×, `ai` ~2×).
