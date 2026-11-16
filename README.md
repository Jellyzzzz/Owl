# Owl

Owl 是一个 TypeScript 编码 Agent，提供终端交互、文件读取、编辑与写入、Bash 工具、会话恢复和上下文压缩。

运行需要 Node.js 22.19 或更新版本、npm 和 Bash。在 Owl 目录安装依赖：

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

启动器保留当前工作目录，并在用户配置不存在时回退到 Owl 仓库的 `.env.local`。会话保存在 `~/.owl/sessions/`，可通过 `/resume` 恢复；`/compact` 用于手动压缩上下文。Bash 命令以启动 Owl 的用户权限执行。

开发检查使用 `npm run typecheck` 和 `npm test`。

## Token 观测

运行可重复的工具上下文基准：

```bash
npm run token:report
```

它会实际执行一次 `read → edit → write → bash`，基于项目自己的 `measureContext` 输出工具定义开销、单次结果对比、整个 run 的累计输入成本，以及每个工具对上下文的累计贡献。

分析真实会话：

```bash
npm run token:report -- --session ~/.owl/sessions/<cwd-hash>/<session-id>.jsonl
```

会按工具统计工具调用参数、模型可见结果和消息元数据，并显示会话的 provider 用量。
