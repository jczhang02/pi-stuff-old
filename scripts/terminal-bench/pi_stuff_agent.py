"""Harbor 0.22.0 adapter for the local Pi Stuff Terminal-Bench run."""

from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


ROOT = Path("/opt/pi-stuff-evaluation")
HOME = Path("/tmp/pi-stuff-evaluation-home")
PI = ROOT / "pi-host" / "pi"
CODE_MODE_HOST = ROOT / "bin" / "code-mode-host"


class PiStuffAgent(BaseInstalledAgent):
    """Run the staged Pi host with the complete, installed Pi Stuff package."""

    @staticmethod
    def name() -> str:
        return "pi-stuff"

    def get_version_command(self) -> str:
        return f"{shlex.quote(str(PI))} --version"

    def _environment(self) -> dict[str, str]:
        home = str(HOME)
        return {
            "HOME": home,
            "XDG_CONFIG_HOME": f"{home}/.config",
            "XDG_CACHE_HOME": f"{home}/.cache",
            "XDG_DATA_HOME": f"{home}/.local/share",
            "XDG_STATE_HOME": f"{home}/.local/state",
            "XDG_RUNTIME_DIR": f"{home}/.runtime",
            "PI_CODING_AGENT_DIR": f"{home}/.pi/agent",
            "MAGIC_CONTEXT_STORAGE_DIR": f"{home}/.local/share/magic-context",
            "PI_STUFF_CODE_MODE_HOST": str(CODE_MODE_HOST),
            "PI_STUFF_BENCHMARK_USAGE_LOG": "/logs/agent/usage.jsonl",
            "PATH": f"{ROOT}/bin:{ROOT}/pi-host:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        }

    async def install(self, environment: BaseEnvironment) -> None:
        """Install the real Pi Package from the read-only evaluation mount."""
        root = shlex.quote(str(ROOT))
        home = shlex.quote(str(HOME))
        pi = shlex.quote(str(PI))
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"test -d {root}/source/packages/pi-stuff; "
                f"test -x {pi}; test -x {root}/bin/bun; "
                f"test -f {root}/auth.json; test -d {root}/profile; "
                f"rm -rf {home}; mkdir -p {home}; "
                f"cp -a {root}/profile/. {home}/; "
                f"mkdir -p {home}/.pi/agent {home}/.config {home}/.cache "
                f"{home}/.local/share {home}/.local/state {home}/.runtime; "
                f"cp {root}/auth.json {home}/.pi/agent/auth.json; "
                f"chmod 600 {home}/.pi/agent/auth.json"
            ),
            env=self._environment(),
        )

        if environment.default_user is not None:
            await self.exec_as_root(environment, command=f"chown -R {shlex.quote(str(environment.default_user))} {home}")
        await self.exec_as_agent(environment, command=f"{pi} install {root}/source/packages/pi-stuff", env=self._environment())

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        escaped = shlex.quote(self.render_instruction(instruction))
        pi = shlex.quote(str(PI))
        execution = asyncio.create_task(self.exec_as_agent(
            environment,
            command=(
                "set -o pipefail; "
                f"{pi} --approve --provider openai-codex "
                f"--model gpt-5.6-luna --thinking max --mode json -p {escaped} "
                "> /logs/agent/pi.stdout.jsonl 2> /logs/agent/pi.stderr.log"
            ),
            env=self._environment(),
        ))
        try:
            while not execution.done():
                await asyncio.wait({execution}, timeout=5)
                await self._preserve_usage(environment)
            await execution
        finally:
            if not execution.done():
                execution.cancel()
                await asyncio.gather(execution, return_exceptions=True)
            await self._preserve_usage(environment)
            diagnostics = await environment.exec(command="cat /logs/agent/pi.stderr.log", timeout_sec=5)
            if diagnostics.return_code != 0 or "Extension error (" in diagnostics.stdout:
                raise RuntimeError("Pi extension execution failed; inspect pi.stderr.log")

    async def _preserve_usage(self, environment: BaseEnvironment) -> None:
        result = await environment.exec(
            command="if test -f /logs/agent/usage.jsonl; then cat /logs/agent/usage.jsonl; fi",
            timeout_sec=5,
        )
        if result.return_code != 0:
            raise RuntimeError("Could not preserve model usage from the task container")
        if result.stdout:
            temporary = self.logs_dir / "usage.jsonl.tmp"
            temporary.write_text(result.stdout, encoding="utf-8")
            temporary.replace(self.logs_dir / "usage.jsonl")



async def resolve_dataset(manifest_path: Path, config_path: Path) -> None:
    """Freeze and validate all upstream task digests before any model call."""
    from harbor.models.job.config import DatasetConfig, JobConfig

    manifest = json.loads(manifest_path.read_text())
    raw = json.loads(config_path.read_text())
    dataset = DatasetConfig(name=manifest["dataset"]["name"], ref=manifest["dataset"]["ref"])
    tasks = await dataset.get_task_configs()
    names = [task.get_task_id().get_name().split("/")[-1] for task in tasks]
    if sorted(names) != sorted(manifest["dataset"]["taskNames"]):
        raise ValueError("Pinned Terminal-Bench task set differs from the 89-task manifest")
    selected = set(raw.pop("selected_tasks"))
    raw["tasks"] = [task.model_dump(mode="json") for name, task in zip(names, tasks, strict=True) if name in selected]
    config = JobConfig.model_validate(raw)
    config_path.write_text(config.model_dump_json(indent=2) + "\n")


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 3:
        raise SystemExit("Expected manifest and Harbor config paths")
    asyncio.run(resolve_dataset(Path(sys.argv[1]), Path(sys.argv[2])))
