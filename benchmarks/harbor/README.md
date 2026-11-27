# Owl × Harbor

Harbor runs the normal Owl CLI inside each task container. The adapter sends
only the Owl source, package files and launcher to the container; local `.env`
files, `.git` and `node_modules` are not included. Set model credentials in the
host environment or use Harbor's `--env-file` option.

The adapter requires Harbor 0.27.0 and Python 3.12+. From the Owl root:

```sh
uv venv --python 3.13 /tmp/owl-harbor-venv
uv pip install --python /tmp/owl-harbor-venv/bin/python 'harbor==0.27.0'
export PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}"
```

The comparison used the following pinned task checkout:

```sh
git clone https://github.com/harbor-framework/terminal-bench-2.git /tmp/owl-terminal-bench-2
git -C /tmp/owl-terminal-bench-2 checkout --detach 2fd12b88aafdd04a52c298e3940bcb189f9766d6
```

Choose a fixed Harbor task checkout or task directory. For example, after
checking out Terminal-Bench 2 at a specific commit, run one task with Owl.
The comparison on 2026-11-27 used repository commit
`2fd12b88aafdd04a52c298e3940bcb189f9766d6` and the
`cancel-async-tasks` and `log-summary-date-ranges` tasks.

```sh
/tmp/owl-harbor-venv/bin/harbor run \
  --path /path/to/terminal-bench-2/cancel-async-tasks \
  --agent benchmarks.harbor.owl_agent:OwlAgent \
  --model deepseek/deepseek-flash --effort max \
  --env-file "$HOME/.config/owl/env" \
  --jobs-dir "$HOME/.owl/harbor/jobs" --job-name owl-cancel-async \
  --n-concurrent 1
```

Run Pi against the same task with its built-in Harbor adapter:

```sh
/tmp/owl-harbor-venv/bin/harbor run \
  --path /path/to/terminal-bench-2/cancel-async-tasks \
  --agent benchmarks.harbor.pi_agent:LocalPi --ak version=1.4.0 \
  --model deepseek/deepseek-flash --effort max \
  --env-file "$HOME/.config/owl/env" \
  --jobs-dir "$HOME/.owl/harbor/jobs" --job-name pi-cancel-async \
  --n-concurrent 1
```

Use a different job name for each run. Docker and its Compose plugin must be
available. Installation inside a task needs network access. On low-memory
machines, run one trial at a time and choose tasks whose resource requirements
fit the Docker VM.

If a Debian task container cannot reach `deb.debian.org`, the adapters can
optionally switch its Debian package sources to an HTTPS mirror during setup:
add `--ak debian_mirror=tuna` (or `aliyun`) for both agents. The Pi adapter
subclasses Harbor's built-in adapter and also accepts the standard DeepSeek
base URL from the Owl environment file. The mirror switch affects only the
disposable task container. On an ARM host, add `--force-build` for tasks whose
prebuilt image is x86-only; use the same build setting for both agents.

Owl settings can be overridden through `--ak`, for example
`--ak tool_mode=sequential` or `--ak max_model_calls=50`. Pi and Owl keep
their own prompts, tools and runtime defaults; matching model and reasoning
does not make every setting equal. Preserve the task commit, agent versions,
settings and raw logs when comparing runs.

Each Owl trial saves `agent/owl-session.jsonl`, `agent/owl.txt`, and
`agent/owl-metrics.json`. The metrics count separate usage records, including
compaction, and record missing fields rather than treating them as zero.
Owl does not yet export Harbor's ATIF trajectory format; inspect its native
session log for message-level details. Harbor's Pi adapter exports ATIF.
Harbor's input count includes cache reads; Owl's `inputTokens` is the
uncached portion. Reasoning tokens are part of output and must not be added
again. The verifier's reward measures the task outcome, separately from cost.
Check `exception_info` as well as the reward: an install or runtime error can
produce a zero reward, but is not a valid completed agent attempt.

Compare saved jobs (including unsuccessful trials) with:

```sh
python3 benchmarks/harbor/report.py /path/to/owl-job /path/to/pi-job
```
