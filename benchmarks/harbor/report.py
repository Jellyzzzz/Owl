"""Print comparable metrics from one or more completed Harbor jobs."""

import argparse
import json
from pathlib import Path


def describe_trial(path: Path) -> list[str] | None:
    result = json.loads(path.read_text(encoding="utf-8"))
    if "task_name" not in result:
        return None  # Job-level result.json, not a trial.
    agent = result.get("agent_info") or {}
    usage = result.get("agent_result") or {}
    verifier = result.get("verifier_result") or {}
    reward = (verifier.get("rewards") or {}).get("reward")
    if result.get("exception_info"):
        status = "error"
    elif result.get("reward_valid") is False or reward is None:
        status = "ungraded"
    else:
        status = "pass" if reward == 1 else "fail"

    metadata = (usage.get("metadata") or {}).get("owl") or {}
    calls = metadata.get("model_calls")
    tools = sum((metadata.get("tool_calls") or {}).values()) if metadata else None
    trajectory = path.parent / "agent" / "trajectory.json"
    if not metadata and trajectory.exists():
        steps = json.loads(trajectory.read_text(encoding="utf-8")).get("steps", [])
        known_calls = [step.get("llm_call_count") for step in steps]
        calls = sum(n for n in known_calls if isinstance(n, int)) if any(
            isinstance(n, int) for n in known_calls
        ) else None
        tools = sum(len(step.get("tool_calls") or []) for step in steps)

    prompt, cache, output = (usage.get("n_input_tokens"),
                              usage.get("n_cache_tokens"), usage.get("n_output_tokens"))
    other_input = prompt - cache if prompt is not None and cache is not None else None
    total = prompt + output if prompt is not None and output is not None else None
    def show(value):
        return "—" if value is None else f"{value:,}" if isinstance(value, int) else str(value)
    return [result["task_name"], str(agent.get("name") or "—"), status,
            show(calls), show(tools), show(other_input), show(cache), show(output), show(total)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jobs", type=Path, nargs="+", help="Harbor job directories")
    args = parser.parse_args()
    rows = []
    for job in args.jobs:
        if not job.is_dir():
            parser.error(f"Job directory not found: {job}")
        for path in sorted(job.rglob("result.json")):
            row = describe_trial(path)
            if row is not None:
                rows.append(row)
    if not rows:
        parser.error("No completed trial result.json files found")
    headers = ["Task", "Agent", "Result", "Calls", "Tools", "Other input", "Cache read", "Output", "Total"]
    print("| " + " | ".join(headers) + " |")
    print("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        print("| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |")
    print("\nOther input = total input minus cache reads; it can include cache writes.")
    print("Errors and ungraded trials are shown separately from task failures.")


if __name__ == "__main__":
    main()
