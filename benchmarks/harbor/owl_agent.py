"""Run the local Owl checkout as a Harbor installed agent.

This adapter deliberately runs the normal Owl CLI, session, loop and tools.
"""

import json
import shlex
import tarfile
import tempfile
from collections import Counter
from pathlib import Path
from typing import Literal

from pydantic import Field

from harbor.agents.agent_auth_resolution import ModelConnectionSpec, ProviderAccess
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


OWL_ROOT = Path(__file__).resolve().parents[2]
REMOTE_ROOT = "/tmp/harbor-owl"
SESSION_NAME = "owl-session.jsonl"


class OwlOptions(InstalledAgentOptions):
    reasoning_effort: Literal["off", "low", "high", "max"] = "max"
    max_model_calls: int = Field(default=100, ge=1)
    max_output_tokens: int = Field(default=32768, ge=1)
    tool_mode: Literal["parallel", "sequential"] = "parallel"
    max_concurrent_tools: int = Field(default=5, ge=1)
    debian_mirror: Literal["aliyun", "tuna"] | None = None


async def configure_debian_mirror(agent: BaseInstalledAgent, environment: BaseEnvironment, mirror: str) -> None:
    """Optional network workaround, scoped to the disposable task container."""
    base = {
        "aliyun": "https://mirrors.aliyun.com/debian",
        "tuna": "https://mirrors.tuna.tsinghua.edu.cn/debian",
    }[mirror]
    await agent.exec_as_root(
        environment,
        command=(
            "if [ -f /etc/apt/sources.list.d/debian.sources ]; then "
            f"sed -i 's|http://deb.debian.org/debian|{base}|g' "
            "/etc/apt/sources.list.d/debian.sources; fi; "
            "if [ -f /etc/apt/sources.list ]; then "
            f"sed -i 's|http://deb.debian.org/debian|{base}|g' "
            "/etc/apt/sources.list; fi"
        ),
    )


def summarize_session(path: Path) -> dict:
    """Sum independent usage records without counting assistant replay twice."""
    fields = ("inputTokens", "outputTokens", "totalTokens", "cachedReadTokens",
              "cachedWriteTokens", "reasoningTokens")
    sums = dict.fromkeys(fields, 0)
    missing = dict.fromkeys(fields, 0)
    seen = set()
    tool_calls = Counter()
    compaction_calls = 0
    compactions = 0
    bad_lines = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            bad_lines += 1
            continue
        if not isinstance(entry, dict):
            bad_lines += 1
            continue
        if entry.get("type") == "usage":
            call_id = entry.get("modelCallId")
            if not isinstance(call_id, str) or not call_id or call_id in seen:
                continue
            seen.add(call_id)
            compaction_calls += entry.get("purpose") == "compaction"
            usage = entry.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            for key in fields:
                value = usage.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    sums[key] += value
                else:
                    missing[key] += 1
        elif entry.get("type") == "compaction":
            compactions += 1
        elif entry.get("type") == "message":
            message = entry.get("message") or {}
            if isinstance(message, dict) and message.get("role") == "assistant":
                for block in message.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "tool_call":
                        tool_calls[str(block.get("name", "unknown"))] += 1
    return {
        "model_calls": len(seen), "compaction_calls": compaction_calls,
        "compactions": compactions, "tool_calls": dict(tool_calls),
        "usage_sums": sums, "usage_missing": missing, "invalid_lines": bad_lines,
    }


class OwlAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(reasoning_effort=True)
    MODEL_CONNECTION = ModelConnectionSpec(
        default_provider="deepseek",
        agent_provider_access=ProviderAccess(api_key_candidate_names=["DEEPSEEK_API_KEY"]),
        api_key_destination_names={"default": "DEEPSEEK_API_KEY"},
    )
    options_model = OwlOptions
    options: OwlOptions

    @staticmethod
    def name() -> str:
        return "owl"

    def get_version_command(self) -> str:
        return f". ~/.nvm/nvm.sh && node -p \"require('{REMOTE_ROOT}/package.json').version\""

    async def install(self, environment: BaseEnvironment) -> None:
        # Include the working checkout, but never .env, node_modules or .git.
        if self.options.debian_mirror:
            await configure_debian_mirror(self, environment, self.options.debian_mirror)
        await self.ensure_system_dependencies(environment, ("bash", "curl", "git", "tar", "ripgrep"))
        with tempfile.TemporaryDirectory(prefix="harbor-owl-source-") as directory:
            archive_path = Path(directory) / "owl.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                for name in ("package.json", "package-lock.json", "tsconfig.json", "bin", "src"):
                    archive.add(OWL_ROOT / name, arcname=name)
            await environment.upload_file(archive_path, "/tmp/harbor-owl.tar.gz")
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {REMOTE_ROOT} && tar -xzf /tmp/harbor-owl.tar.gz -C {REMOTE_ROOT} && "
                f"{nvm_node_install_snippet()} && cd {REMOTE_ROOT} && npm ci --no-audit --no-fund"
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        connection = self.model_connection
        if connection.provider != "deepseek" or not connection.model_id:
            raise ValueError("Owl currently supports only deepseek/<model-id>")
        env = dict(connection.env)
        env.update({
            "DEEPSEEK_MODEL": connection.model_id,
            "OWL_REASONING_LEVEL": self.options.reasoning_effort,
            "OWL_MAX_MODEL_CALLS": str(self.options.max_model_calls),
            "OWL_MAX_OUTPUT_TOKENS": str(self.options.max_output_tokens),
            "OWL_MAX_CONCURRENT_TOOLS": str(self.options.max_concurrent_tools),
            "OWL_TOOL_EXECUTION_MODE": self.options.tool_mode,
            "OWL_BENCHMARK_INSTRUCTION": instruction,
        })
        session = shlex.quote(str(self.environment_logs_dir / SESSION_NAME))
        output = shlex.quote(str(self.environment_logs_dir / "owl.txt"))
        await self.exec_as_agent(
            environment,
            command=(
                'instruction="$OWL_BENCHMARK_INSTRUCTION"; unset OWL_BENCHMARK_INSTRUCTION; '
                '. ~/.nvm/nvm.sh; '
                f'{REMOTE_ROOT}/bin/owl --no-tui --session {session} -- "$instruction" '
                f'> {output} 2>&1'
            ),
            env=env,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / SESSION_NAME
        if not path.exists():
            return
        summary = summarize_session(path)
        self.logs_dir.joinpath("owl-metrics.json").write_text(
            json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        sums, missing = summary["usage_sums"], summary["usage_missing"]
        if summary["model_calls"] and not summary["invalid_lines"]:
            if not missing["totalTokens"] and not missing["outputTokens"]:
                context.n_input_tokens = sums["totalTokens"] - sums["outputTokens"]
            if not missing["outputTokens"]:
                context.n_output_tokens = sums["outputTokens"]
            if not missing["cachedReadTokens"]:
                context.n_cache_tokens = sums["cachedReadTokens"]
        context.metadata = {**(context.metadata or {}), "owl": summary}
