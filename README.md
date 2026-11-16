# Owl

Owl 是一个 TypeScript 编码 Agent，提供终端交互、Bash 工具、会话恢复和上下文压缩。

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
