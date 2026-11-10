# dingtalk-workspace-mcp

<img src="plugins/dingtalk-codex-bridge/assets/dingtalk.png" width="80" height="80" alt="DingTalk" />

钉钉 Workspace MCP，当前版本 **0.3.3**。

将固定版本官方 DWS CLI 整理为可发现、可描述、可调用的 Codex MCP。覆盖 33 个业务域，保留在线电子表格全部 99 项接入。

- 索引 **1,596** 条命令：1,559 条官方 Schema 命令 + 37 条本机工具命令。
- **1,502** 条业务命令接入统一结构化读写；事件、Raw API、已发布 MCP、只读诊断分别适配。
- **52** 条登录、凭据、配置与持久 Agent 命令保留本机流程指引；**33** 条官方不可用/兼容占位明确标注。
- **59 项 Node.js 测试和 9 项 Python 打包测试通过**；1,502 条业务命令完成本地参数编译检查。授权后完成读取、独立文档/本人待办/多维表写入及在线 Excel 验收；账号权限和服务端异常见验收记录。

完整目录不等于每条 API 都已实机执行。真实覆盖范围见 [验收记录](VALIDATION.md)，逐命令状态见 [功能清单](CLI-COVERAGE.md) / [CSV](CLI-COVERAGE.csv)。

## 安装

从 Gitee 克隆并安装：

```bash
git clone https://gitee.com/qts_server/dingtalk-workspace-mcp.git
cd dingtalk-workspace-mcp
node plugins/dingtalk-codex-bridge/scripts/setup.mjs install-cli
codex plugin marketplace add .
codex plugin add dingtalk-codex-bridge@dingtalk-local
```

使用 ZIP 时，保留整个解压目录，包括隐藏的 `.agents/`，进入根目录后从安装 CLI 的命令开始执行。Node.js 要求 20 或以上；Python 仅用于维护与重新打包。

安装后确认版本为 0.3.3；新开聊天加载，必要时重启 Codex。已有 DWS 登录直接复用。安装包不含凭据、企业资源内容、真实账号 ID 或 CLI 二进制。

[使用和环境配置](plugins/dingtalk-codex-bridge/README.md) · [依赖来源与许可](plugins/dingtalk-codex-bridge/UPSTREAM.md)

分享前请使用 [发布打包脚本](plugins/dingtalk-codex-bridge/scripts/package-release.py)，以 release-files.json 为逐文件允许清单。分发检查与边界见 [RELEASE-REVIEW.md](RELEASE-REVIEW.md)。
