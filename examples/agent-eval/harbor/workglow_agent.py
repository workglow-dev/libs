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

_REMOTE_DIR = PurePosixPath("/installed-agent")
_REMOTE_BUNDLE = _REMOTE_DIR / "workglow-agent.mjs"
_REMOTE_INSTRUCTION = _REMOTE_DIR / "instruction.md"
_DEFAULT_BUNDLE = Path(__file__).resolve().parent.parent / "dist" / "workglow-agent.mjs"
_NODE_PREFIX = "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "


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
        default=None, ge=1, description="Abandon and retry a model call after this long."
    )
    max_round_retries: Annotated[int | None, Cli("--max-round-retries")] = Field(
        default=None, ge=0, description="Retries of a failed model call."
    )
    command_timeout_sec: Annotated[int | None, Cli("--command-timeout-sec")] = Field(
        default=None, ge=1, description="Default bash timeout."
    )
    append_system_prompt: Annotated[str | None, Cli("--append-system-prompt")] = Field(
        default=None, description="Text appended to the system prompt."
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

        logs_dir = self.environment_logs_dir.as_posix()
        flags = self.build_cli_flags()
        await self.exec_as_agent(
            environment,
            command=(
                f"{_NODE_PREFIX}"
                f"node {shlex.quote(_REMOTE_BUNDLE.as_posix())} "
                f"--model {shlex.quote(self.model_name)} "
                f"--instruction-file {shlex.quote(_REMOTE_INSTRUCTION.as_posix())} "
                f'--cwd "$PWD" --logs-dir {shlex.quote(logs_dir)} '
                f"{flags + ' ' if flags else ''}"
                f"2>&1 </dev/null | tee "
                f"{shlex.quote((self.environment_logs_dir / self._OUTPUT_FILENAME).as_posix())}"
            ),
            env=dict(self.model_connection.env),
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
        context.n_input_tokens = usage.get("promptTokens")
        context.n_cache_tokens = usage.get("cacheReadTokens")
        context.n_output_tokens = usage.get("outputTokens")
        context.cost_usd = summary.get("costUsd")
        # The comparison reads outcome, rounds and tool tallies from here.
        context.metadata = {
            "workglow": {key: value for key, value in summary.items() if key != "finalText"}
        }
