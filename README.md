# dingtalk-workspace-mcp

<img src="plugins/dingtalk-codex-bridge/assets/dingtalk.png" width="80" height="80" alt="DingTalk" />

钉钉 Workspace MCP，当前版本 **0.4.1**。

将固定版本官方 DWS CLI 整理为可发现、可描述、可调用的 Codex MCP。覆盖 33 个业务域，保留在线电子表格全部 99 项接入。

这是基于官方 CLI 的非官方开源适配插件。插件实现采用 [MIT 许可证](LICENSE)；上游元数据、第三方声明与钉钉品牌资源的来源见 [UPSTREAM.md](plugins/dingtalk-codex-bridge/UPSTREAM.md)。

- 索引 **1,596** 条命令：1,559 条官方 Schema 命令 + 37 条本机工具命令。
- **1,502** 条业务命令接入统一结构化读写；事件、Raw API、已发布 MCP、只读诊断分别适配。
- **52** 条登录、凭据、配置与持久 Agent 命令保留本机流程指引；**33** 条官方不可用/兼容占位明确标注。
- **96 项 Node.js 测试和 9 项 Python 打包测试通过**；1,502 条业务命令完成本地参数编译检查。授权后完成读取、独立文档/本人待办/多维表写入及在线 Excel 验收；账号权限和服务端异常见验收记录。

完整目录不等于每条 API 都已实机执行。真实覆盖范围见 [验收记录](VALIDATION.md)，逐命令状态见 [功能清单](CLI-COVERAGE.md) / [CSV](CLI-COVERAGE.csv)。

## 安装与首次连接

本机需要 Node.js 20 或以上。官方 DWS CLI 会在首次连接时由插件下载并校验。

从 GitHub 克隆并安装：

```bash
git clone https://github.com/heyzeyu/dingtalk-workspace-mcp.git
cd dingtalk-workspace-mcp
codex plugin marketplace add .
codex plugin add dingtalk-codex-bridge@dingtalk-local
```

也可使用 [Gitee 仓库](https://gitee.com/qts_server/dingtalk-workspace-mcp)，安装步骤相同。

使用 ZIP 时，保留整个解压目录，包括隐藏的 `.agents/`，进入根目录后从添加 marketplace 的命令开始执行。Node.js 要求 20 或以上；Python 仅用于维护与重新打包。

安装后新开一个聊天，直接说：

> 连接钉钉，帮我完成首次授权。

插件会检查并准备官方 CLI，在本机浏览器打开钉钉官方授权页。你只需扫码、选择组织并确认；插件会保持设备授权进程，检查完成后继续原来的操作。首次连接不使用 `127.0.0.1` 回调，也不要求把 Token 或授权链接粘贴到聊天中。

已有可读取的 DWS 登录会直接复用。若授权页没有打开，可以说“重新打开钉钉授权页面”；等待期间不要重复发起登录。通过当前账号读取真实资源后，才能确认对应的组织与资源权限。

当前插件版本为 0.4.1，提供 20 个 MCP 工具。本机真实扫码、保存、新进程复用及本人信息读取已通过。更新旧版后需重新打开聊天，必要时重启 Codex。安装包不含凭据、企业资源内容、真实账号 ID 或 CLI 二进制。

SSH/无桌面环境、无法访问 GitHub、Node.js 不可用以及组织尚未开通 CLI，仍需要相应环境处理；本次桌面引导重点验证 macOS。手动安装、离线安装与终端设备授权见插件 README。

[登录故障与解决方案](plugins/dingtalk-codex-bridge/LOGIN-TROUBLESHOOTING.md) · [使用和环境配置](plugins/dingtalk-codex-bridge/README.md) · [依赖来源与许可](plugins/dingtalk-codex-bridge/UPSTREAM.md)

分享前请使用 [发布打包脚本](plugins/dingtalk-codex-bridge/scripts/package-release.py)，以 release-files.json 为逐文件允许清单。分发检查与边界见 [RELEASE-REVIEW.md](RELEASE-REVIEW.md)。
