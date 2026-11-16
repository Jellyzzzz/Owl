# Owl

Owl 是一个 TypeScript 编码 Agent，提供终端交互、文件读取、编辑与写入、内容搜索、文件查找、Bash 工具、会话恢复和上下文压缩。

内置 `grep` 和 `find` 通过 ripgrep 的结构化参数执行，遵守 `.gitignore`、`.ignore` 等 ripgrep 忽略规则；`grep` 使用流式 JSON 输出并限制匹配数、字节数和 context，`find` 使用 `rg --files` 获取实际存在的文件。结果受数量和字节上限约束。

运行需要 Node.js 22.19 或更新版本、npm、Bash 和 `rg`。macOS 可安装 ripgrep：

```bash
brew install ripgrep
```

Debian/Ubuntu 使用 `apt install ripgrep`。如果 `rg` 不在 PATH 中，`grep` 和 `find` 会返回明确的安装提示，不会静默回退到语义不同的 JavaScript 搜索。也可以用 `OWL_RG_PATH` 指定 ripgrep 可执行文件路径。

在 Owl 目录安装依赖：

```bash
npm ci
```

在 `~/.config/owl/env` 配置模型（已有环境变量优先）：

```dotenv
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_THINKING_MODE=enabled
```

将 `bin/owl` 加入 PATH 后，在需要操作的项目目录启动：

```bash
cd /path/to/project
owl
```

启动器保留当前工作目录，并在用户配置不存在时回退到 Owl 仓库的 `.env.local`。会话保存在 `~/.owl/sessions/`，可通过 `/resume` 恢复；`/compact` 用于手动压缩上下文，`/usage` 显示当前会话的累计输入、缓存命中和输出。Bash 命令以启动 Owl 的用户权限执行。

在 TUI 中输入 `/settings` 可以选择推理等级、单次输出上限、每次任务的模型调用上限、工具执行模式和并发数；也可以使用 `/reasoning`、`/max-output`、`/max-calls` 或 `/concurrency` 直接选择。`/parallel` 和 `/sequential` 直接切换执行模式。文本模式可使用例如 `/reasoning low`、`/max-output 32768`；设置只影响后续任务。

默认单次输出上限为 32,768 tokens（不超过模型限制），每次任务最多 100 次模型调用，工具顺序执行。并行模式下独立工具调用可以并发，Bash 也可能并发；含有必须串行执行的工具时整批保持顺序。需要长期使用不同默认值时，可在 `~/.config/owl/env` 中设置 `OWL_REASONING_LEVEL`、`OWL_MAX_OUTPUT_TOKENS`、`OWL_MAX_MODEL_CALLS`、`OWL_MAX_CONCURRENT_TOOLS` 和 `OWL_TOOL_EXECUTION_MODE`（`parallel` 或 `sequential`）。启动参数 `--reasoning`、`--max-output-tokens`、`--max-model-calls`、`--max-concurrent-tools`、`--parallel-tools` 和 `--sequential-tools` 优先于环境变量；推理等级以已注册模型支持的选项为准。

开发检查使用 `npm run typecheck` 和 `npm test`。

## Token 观测

运行可重复的工具上下文基准：

```bash
npm run token:report
```

它会实际执行一次 `read → edit → write → bash`，并计入全部工具定义开销；基于项目自己的 `measureContext` 输出工具定义开销、单次结果对比、整个 run 的累计输入成本，以及每个工具对上下文的累计贡献。

分析真实会话：

```bash
npm run token:report -- --session ~/.owl/sessions/<cwd-hash>/<session-id>.jsonl
```

会按工具统计工具调用参数、模型可见结果和消息元数据，并显示会话的 provider 用量。
