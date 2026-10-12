# @license
# Copyright 2026 Steven Roussey <sroussey@gmail.com>
# SPDX-License-Identifier: Apache-2.0
"""Harbor adapter for the headless Workglow coding agent (AgentTask).

Run it beside Harbor's built-in ``opencode`` and ``pi`` agents:

    harbor run -d terminal-bench@2.0 -m anthropic/claude-sonnet-5-5 \\
        -a workglow_agent:WorkglowAgent

with this directory on ``PYTHONPATH``. It installs Node in the task container,
uploads the single-file agent bundle (``dist/workglow-agent.mjs``, built by
``bun run build-agent``), and runs it on the task instruction. The bundle is
uploaded rather than installed from a registry so a run always measures the
``libs`` checkout it was built from: change AgentTask, rebuild, re-run.
"""

import json
import os
import shlex
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, override

from pydantic import Field

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.task import Task
from harbor.models.trial.config import TrialConfig

_REMOTE_DIR = PurePosixPath("/installed-agent")
_REMOTE_BUNDLE = _REMOTE_DIR / "workglow-agent.mjs"
_REMOTE_INSTRUCTION = _REMOTE_DIR / "instruction.md"
# Owned by the agent user and closed to everyone else, so the agent can delete
# the credentials file it reads from here.
_REMOTE_SECRETS_DIR = _REMOTE_DIR / "secrets"
_REMOTE_CREDENTIALS = _REMOTE_SECRETS_DIR / "credentials.json"
_DEFAULT_BUNDLE = Path(__file__).resolve().parent.parent / "dist" / "workglow-agent.mjs"
_NODE_PREFIX = "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
# The longest timer Node can set, in whole seconds; the agent refuses anything longer.
_MAX_TIMER_SEC = 2_147_483


class WorkglowOptions(InstalledAgentOptions):
    """Agent kwargs (``--ak name=value``), passed through as CLI flags.

    Every knob that changes AgentTask's behaviour is here so a job can run an
    ablation — the same model and tasks with one setting changed — without a
    rebuild.
    """

    effort: Annotated[str | None, Cli("--effort")] = Field(
        default=None,
        description="Reasoning effort: none|low|medium|high|extra|ultra (or off|minimal|xhigh|max).",
    )
    max_rounds: Annotated[int | None, Cli("--max-rounds")] = Field(
        default=None, ge=1, description="Model calls before the run stops (agent default 100)."
    )
    max_tool_result_chars: Annotated[int | None, Cli("--max-tool-result-chars")] = Field(
        default=None, ge=1, description="Characters of one tool result the model is shown."
    )
    max_history_chars: Annotated[int | None, Cli("--max-history-chars")] = Field(
        default=None, ge=1, description="History budget per round (AgentTask default if unset)."
    )
    tool_concurrency: Annotated[int | None, Cli("--tool-concurrency")] = Field(
        default=None, ge=1, description="Tool calls of one round run at once."
    )
    max_tokens: Annotated[int | None, Cli("--max-tokens")] = Field(
        default=None, ge=1, description="Output tokens per model call."
    )
    temperature: Annotated[float | None, Cli("--temperature")] = Field(
        default=None, description="Sampling temperature."
    )
    round_timeout_sec: Annotated[int | None, Cli("--round-timeout-sec")] = Field(
        default=None,
        ge=1,
        le=_MAX_TIMER_SEC,
        description="Abandon and retry a model call after this long.",
    )
    max_round_retries: Annotated[int | None, Cli("--max-round-retries")] = Field(
        default=None, ge=0, description="Retries of a failed model call."
    )
    command_timeout_sec: Annotated[int | None, Cli("--command-timeout-sec")] = Field(
        default=None, ge=1, le=_MAX_TIMER_SEC, description="Default bash timeout."
    )
    append_system_prompt: Annotated[str | None, Cli("--append-system-prompt")] = Field(
        default=None, description="Text appended to the system prompt."
    )
    concise: Annotated[str | None, Cli("--concise")] = Field(
        default=None, description="on|off: ask for terse replies between tool calls (default on)."
    )
    images: Annotated[str | None, Cli("--images")] = Field(
        default=None, description="on|off: let read show images to the model (default on)."
    )
    replay_reasoning: Annotated[str | None, Cli("--replay-reasoning")] = Field(
        default=None,
        description="on|off: send the model's reasoning back on later rounds (default on).",
    )
    max_duration_sec: Annotated[int | None, Cli("--max-duration-sec")] = Field(
        default=None,
        ge=1,
        description="Wall-clock budget; set from the trial's time limit unless given.",
    )
    time_budget: str | None = Field(
        default=None,
        pattern="^(on|off)$",
        description="on|off: give the agent the trial's time limit, less a reserve (default on).",
    )
    time_left: Annotated[str | None, Cli("--time-left")] = Field(
        default=None,
        pattern="^(on|off)$",
        description="on|off: show the model its remaining time (default on)."
    )
    review: Annotated[str | None, Cli("--review")] = Field(
        default=None,
        pattern="^(on|off)$",
        description="on|off: one check against the instructions before finishing (default on).",
    )
    bundle_path: str | None = Field(
        default=None,
        description="Local path of workglow-agent.mjs (default: ../dist, or $WORKGLOW_AGENT_BUNDLE).",
    )


class WorkglowAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(atif=True)
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    options_model = WorkglowOptions
    options: WorkglowOptions

    _OUTPUT_FILENAME = "workglow.txt"
    _SUMMARY_FILENAME = "workglow-summary.json"

    @staticmethod
    @override
    def name() -> str:
        return "workglow"

    @override
    def get_version_command(self) -> str | None:
        return f"{_NODE_PREFIX}node {shlex.quote(_REMOTE_BUNDLE.as_posix())} --version"

    def _agent_timeout_sec(self) -> float | None:
        """The time Harbor gives run(), resolved as the trial resolves it.

        Harbor hands an agent no deadline: it cancels run() when the time is
        up. The trial's config and task sit next to the logs directory, so the
        agent can learn its limit and stop cleanly, with its summary written,
        before that.
        """
        try:
            config = TrialConfig.model_validate_json(
                (self.logs_dir.parent / "config.json").read_text()
            )
            base = config.agent.override_timeout_sec or Task(
                config.task.get_local_path()
            ).config.agent.timeout_sec
        except (OSError, ValueError) as error:
            self.logger.warning(
                "Could not resolve the trial's agent time limit (%s); the workglow agent "
                "runs without a time budget.",
                error,
            )
            return None
        if base is None:
            return None
        multiplier = (
            config.agent_timeout_multiplier
            if config.agent_timeout_multiplier is not None
            else config.timeout_multiplier
        )
        return min(base, config.agent.max_timeout_sec or float("inf")) * multiplier

    def _max_duration_sec(self) -> int | None:
        if self.options.max_duration_sec is not None:
            return self.options.max_duration_sec
        if self.options.time_budget == "off":
            return None
        limit = self._agent_timeout_sec()
        if limit is None:
            return None
        # The loop stops only between rounds; the reserve covers the round in
        # flight and writing the summary, and never takes more than half a
        # short limit.
        # The budget is whole seconds and must end before the limit, so the shortest
        # limit that leaves a one-second budget is two seconds.
        if limit < 2:
            raise ValueError(
                f"the trial's agent time limit is {limit:.3f}s; a timed run needs at least 2s"
            )
        reserve = min(120.0, max(30.0, limit * 0.1), limit / 2)
        return max(1, int(limit - reserve))

    def _stop_after_sec(self) -> int | None:
        """When the agent stops outright, a little before Harbor cancels run().

        The time budget stops the loop only between rounds, so a model call in
        flight at Harbor's limit would be cancelled with it and the summary and
        trajectory never written. Stopping first, with time left to write them,
        keeps the trial's record whatever round was running. Set whenever the
        limit is known, ``time_budget`` or not: it changes no behaviour before
        the limit.
        """
        limit = self._agent_timeout_sec()
        if limit is None or limit < 2:
            return None
        margin = min(10.0, limit / 4)
        return min(_MAX_TIMER_SEC, max(1, int(limit - margin)))

    def _bundle(self) -> Path:
        configured = self.options.bundle_path or os.environ.get("WORKGLOW_AGENT_BUNDLE")
        bundle = Path(configured).expanduser() if configured else _DEFAULT_BUNDLE
        if not bundle.is_file():
            raise FileNotFoundError(
                f"workglow agent bundle not found at {bundle}; run `bun run build-agent` in "
                "examples/agent-eval, or pass --ak bundle_path=..."
            )
        return bundle

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        bundle = self._bundle()
        # Only what nvm needs. Distro Node is not asked for: on glibc images nvm
        # installs its own, and asking apt for `nodejs` fails the whole install
        # on images whose package index has gone stale.
        await self.ensure_system_dependencies(environment, ("curl", "bash", "ca_certificates"))
        # The bundle needs Node 22+. On glibc, install it with nvm the way the
        # opencode and pi adapters do; on musl nvm's binaries do not run, so
        # the packaged Node is all there is.
        await self.exec_as_root(
            environment,
            command=(
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then "
                "command -v node >/dev/null || apk add --no-cache nodejs; fi"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then "
                "node --version; "
                # The image's own Node can be older than the bundle accepts; say so
                # here, as a setup failure, rather than as every trial crashing.
                "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)' "
                "|| { echo \"workglow agent needs Node 22+, found $(node --version)\" >&2; exit 1; }; "
                f"else {nvm_node_install_snippet()}; fi"
            ),
        )
        await self.exec_as_root(environment, command=f"mkdir -p {_REMOTE_DIR.as_posix()}")
        await self._upload_agent_owned_file(environment, bundle, _REMOTE_BUNDLE.as_posix())
        await self.exec_as_agent(
            environment,
            command=f"{_NODE_PREFIX}node {shlex.quote(_REMOTE_BUNDLE.as_posix())} --version",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Harbor's limit runs from here, not from when the agent process starts.
        entered = time.monotonic()
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        # Through a file, not argv: a long instruction is past what a shell
        # command line safely carries.
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        local_instruction = self.logs_dir / "instruction.md"
        local_instruction.write_text(instruction)
        await self._upload_agent_owned_file(
            environment, local_instruction, _REMOTE_INSTRUCTION.as_posix()
        )

        await self._upload_credentials(environment)
        try:
            logs_dir = self.environment_logs_dir.as_posix()
            flags = self.build_cli_flags()
            # Both are relative to the agent's own start, so the time setup took
            # (the uploads above) comes off them. Kept as a float: truncating
            # would understate the setup time by up to a second. When setup has
            # eaten the whole allowance there is no positive whole second left
            # that ends before Harbor's deadline, so the flag is left off rather
            # than clamped to 1 and scheduled past it.
            spent = time.monotonic() - entered
            if self.options.max_duration_sec is None:
                budget = self._max_duration_sec()
                if budget is not None:
                    remaining = int(budget - spent)
                    if remaining >= 1:
                        flags = f"{flags} --max-duration-sec {remaining}".strip()
            stop = self._stop_after_sec()
            if stop is not None:
                remaining = int(stop - spent)
                if remaining >= 1:
                    flags = f"{flags} --stop-after-sec {remaining}".strip()
            await self.exec_as_agent(
                environment,
                command=(
                    # Without pipefail the run's status is `tee`'s, and an agent that
                    # crashed would be recorded as one that finished.
                    "set -o pipefail; "
                    f"{_NODE_PREFIX}"
                    f"node {shlex.quote(_REMOTE_BUNDLE.as_posix())} "
                    f"--model {shlex.quote(self.model_name)} "
                    f"--instruction-file {shlex.quote(_REMOTE_INSTRUCTION.as_posix())} "
                    f"--credentials-file {shlex.quote(_REMOTE_CREDENTIALS.as_posix())} "
                    f'--cwd "$PWD" --logs-dir {shlex.quote(logs_dir)} '
                    f"{flags + ' ' if flags else ''}"
                    f"2>&1 </dev/null | tee "
                    f"{shlex.quote((self.environment_logs_dir / self._OUTPUT_FILENAME).as_posix())}"
                ),
            )
        finally:
            # The agent deletes it on start; this covers a run that never got that far.
            await self.exec_as_root(
                environment, command=f"rm -f {shlex.quote(_REMOTE_CREDENTIALS.as_posix())}"
            )

    async def _upload_credentials(self, environment: BaseEnvironment) -> None:
        """Hands the agent its API keys in a file rather than in its environment.

        A process's starting environment stays readable at ``/proc/<pid>/environ``
        for its whole life, and every command the model runs is a descendant of
        the shell and the Node process this adapter starts. Keys passed in the
        ``exec`` environment could be read back by the model however the bash
        tool filters its own; the agent loads the file into its environment after
        it starts, where that file does not show it, and deletes it.
        """
        secrets_dir = shlex.quote(_REMOTE_SECRETS_DIR.as_posix())
        user = environment.default_user
        owner = f"chown {shlex.quote(str(user))} {secrets_dir} && " if user is not None else ""
        await self.exec_as_root(
            environment, command=f"mkdir -p {secrets_dir} && {owner}chmod 700 {secrets_dir}"
        )
        # Never under logs_dir: that directory is kept with the job's results.
        with tempfile.TemporaryDirectory(prefix="workglow-agent-") as temp_dir:
            local = Path(temp_dir) / "credentials.json"
            fd = os.open(local, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump(dict(self.model_connection.env), handle)
            await self._upload_agent_owned_file(environment, local, _REMOTE_CREDENTIALS.as_posix())
        await self.exec_as_root(
            environment, command=f"chmod 600 {shlex.quote(_REMOTE_CREDENTIALS.as_posix())}"
        )

    def _summary(self) -> dict[str, Any] | None:
        path = self.logs_dir / self._SUMMARY_FILENAME
        try:
            return json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        summary = self._summary()
        if summary is None:
            return
        usage = summary.get("usage") or {}
        # A round the provider reported no usage for makes every sum an
        # undercount; leaving them unset is what the report marks as partial.
        if not usage.get("unreportedRounds"):
            context.n_input_tokens = usage.get("promptTokens")
            context.n_output_tokens = usage.get("outputTokens")
            # A provider that never reported a cache count did not report zero.
            if not usage.get("cacheUnreportedRounds"):
                context.n_cache_tokens = usage.get("cacheReadTokens")
        context.cost_usd = summary.get("costUsd")
        # The comparison reads outcome, rounds and tool tallies from here.
        context.metadata = {
            "workglow": {key: value for key, value in summary.items() if key != "finalText"}
        }
