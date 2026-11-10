# 登录自检与解决方案（0.4.1）

适用：本机 macOS + Node.js 20+ + Codex 插件。固定官方 DWS 1.0.67。插件管理官方 CLI 的设备授权进程，凭据仍由官方 CLI 和系统凭据存储管理。

## 正常连接

安装后新开聊天，说“连接钉钉”。有可读取的授权会直接复用；缺 CLI 时下载固定版本并校验 SHA-256；需要授权时打开本机官方页面。本人扫码、选择组织并确认，保持 Codex 和当前会话开启。助手查询进度，拿到 `ready` 和对应 profile 后，再做一次有界业务读取。

首次工具返回 `starting` 或 `awaiting_authorization` 是等待状态。每 2–5 秒查询进度即可，不需要重复登录。握手最多等待 90 秒；整个设备登录子进程最多 11 分钟。官方重试换码时会打开新页面，以最新页面为准；显示的截止时间受整个会话上限约束。

`ready` 是本机登录确认。进度成功状态缓存 5 秒，超过后按同一 profile 只读复查。它不证明全部业务权限有效；接口无权访问时不要因此强制重新扫码。

## 已修复的边界

| 问题 | 0.4.1 行为与验证 |
|---|---|
| 官方重试换了设备码，浏览器还停在旧页面 | 打开新码对应的官方页；旧启动器的迟到结果不覆盖新页面状态。合成进程测试通过。 |
| 会话关闭后，刚返回的检查继续安装或初始化 | 每个后续阶段先检查关闭/取消状态；依赖下载支持取消。延迟回执测试通过。 |
| 成功退出和取消撞在一起，误报取消 | 保留原生成功回执，等输出排空并确认其精确身份。竞态测试通过。 |
| 手机已确认，取消打断保存 | 进入官方换取/保存阶段后继续等待原保存结果；关闭或硬超时导致结果不明时返回 `AUTH_SAVE_OUTCOME_UNKNOWN`。测试通过。 |
| 已有新登录，但只读快照提示官方初始化未完成 | 仅在显式连接流程中，按成功回执中的精确 profile 执行官方初始化并确认，不能拿其他旧账号充当成功。测试通过。 |
| 后来退出登录，进度永久显示成功 | 成功快照过期后重新只读检查；失效与无法判断分别返回 `needs_setup`、`needs_attention`。测试通过。 |
| 没拿到授权页却一直提示扫码 | 区分握手和用户等待；握手超时返回 `AUTH_HANDSHAKE_TIMEOUT`。静默子进程测试通过。 |
| MCP 调用被取消，后台还继续首次安装/登录 | 处理该连接请求的 `notifications/cancelled`，取消下载/等待，抑制迟到响应。已经开始的官方状态写入会先完成，再阻止下一步。协议与进程测试通过。 |
| 原生进度文字夹在最终错误 JSON 前 | 仅登录解析器识别结尾完整的失败 JSON，返回固定错误类别，不返回原始诊断、授权码、链接或管理员姓名。测试通过。 |
| macOS 图形应用 PATH 缺少 open/curl/tar | PATH 查找失败后回退到 `/usr/bin/` 的同名系统工具；缺依赖、执行拒绝和进程中断分别报告。测试通过。Node.js 仍须由宿主正常启动。 |

## 出问题时怎么处理

| 表现或错误 | 判断与处理 |
|---|---|
| 扫码后出现 `127.0.0.1` / `ERR_CONNECTION_REFUSED` | 新引导使用设备流，不依赖本地回调。旧终端 `login --browser` 可能因进程结束、端口不可用或跨机器访问而失联；成功后刷新旧回调页也可能报错。先查登录状态，再用“连接钉钉”走新流程；不要据此清除授权。 |
| 安装后没有工具 / `node` 找不到 | MCP 还未启动，扫码无法解决。确认 `node --version` 为 20+，`command -v node` 能找到可执行文件；确认 macOS 图形应用的启动环境也可用，重启 Codex。若终端有 Node 而 Codex 没有，修复其启动 PATH 或由安装者将插件 `.mcp.json` 的 command 配为本机 Node 的实际绝对路径，再重新安装。不要把自己的绝对路径分发给别人。 |
| 仍显示旧版本，或没有连接工具 | 确认 marketplace 指向当前完整解压目录，重新执行 `codex plugin add dingtalk-codex-bridge@dingtalk-local`，新开聊天；必要时重启 Codex。当前版本应为 0.4.1、20 项工具。 |
| `DOWNLOAD_FAILED` / `AUTH_NETWORK_FAILED` / `AUTH_HANDSHAKE_TIMEOUT` | 检查本机代理、DNS 和网络。下载需要 GitHub 官方发行站，授权需要钉钉官方服务。修复网络后重新连接；不复制别人的缓存或登录目录。 |
| GitHub 无法下载，但能访问钉钉 | 从可信网络下载同平台的官方 v1.0.67 发行包，用 `node plugins/dingtalk-codex-bridge/scripts/setup.mjs install-cli --archive /absolute/path/to/archive` 离线安装。安装器仍验证固定 SHA-256，然后在聊天连接。 |
| `CHECKSUM_MISMATCH` | 不执行该文件。重新获取同版本、同平台官方发行包；不要跳过校验。 |
| `CLI_VERSION_MISMATCH` | 使用固定 1.0.67。未设 `DWS_CLI_PATH` 时引导可安装受管版本；显式覆盖不会被擅自替换，需修正该路径/版本后重试。 |
| `SETUP_TOOL_MISSING` / `CLI_EXECUTION_DENIED` | 检查系统 curl/tar、文件权限。若 macOS 明确阻止已核验来源的官方程序，按系统“隐私与安全性”提供的单项允许方式处理；企业策略可能需要管理员。不要关闭全局系统防护。 |
| `AUTH_STATE_UNAVAILABLE` / `AUTH_STORE_UNAVAILABLE` / `needs_attention` | 无法安全确定凭据状态，不等于未登录。确认处于原用户的 macOS 登录会话、钥匙串已解锁，处理系统访问提示或组织限制。先运行只读 status 诊断；必要时在相同 profile 下运行官方普通 status。不要运行 reset、删除凭据、钥匙串迁移或导出 Token 来“修复”。 |
| `AUTH_ORGANIZATION_DENIED` | 组织未开启 CLI、当前用户/渠道未获准，或企业安全认证拒绝；联系组织管理员按官方入口开通。扫码成功并不保证组织准入通过。 |
| 授权页没有打开 | 保持当前会话，说“重新打开钉钉授权页面”，使用同一会话 `reopen_browser=true`。它不生成新码。无桌面/SSH 环境改用终端 `setup.mjs login --device`，保持原进程，在自己浏览器完成官方授权。 |
| 用户拒绝、设备码过期或 `expired` | 确认当前等待已结束，再发起一次新连接。不要同时在多个窗口重复扫码。 |
| `AUTH_SAVE_OUTCOME_UNKNOWN` 或保存时被中断 | 保存可能已经完成。先读取本机状态、确认同一 profile，再尝试有界业务读取；未查明前不要反复强制登录或清空数据。 |
| `AUTH_SESSION_UNKNOWN` / Codex 重启后找不到进度 | 会话 ID 只属于原 MCP 进程。新进程先查本机状态；已保存则复用，确认未登录后才重新连接。 |
| 登录成功，但文档/表格/审批返回无权操作 | 检查所选组织、账号、资源共享范围和接口权限。与登录握手失败分别处理，不反复扫码、不重复业务写入。 |

终端只读诊断（在安装包根目录）：

```bash
node plugins/dingtalk-codex-bridge/scripts/setup.mjs status
```

诊断信息可能含个人/组织信息，只在自己的电脑查看。反馈问题只提供插件版本、系统架构、错误类别、发生阶段，以及脱敏的状态；不要发送完整授权网址、设备码、Cookie、Token 或配置目录。

## 验收边界

自动回归覆盖的是可控失败条件，实机验收范围与结果见根目录 [VALIDATION.md](../../VALIDATION.md)。其他同事的新 macOS 账号、不同钥匙串策略、公司网络、国际版组织、Windows/Linux 仍需各自验收。新引导当前只接受已核对的国内官方设备页；国际版需官方 CLI 对应流程。

同一个 MCP 进程会复用正在等待的授权；多个 Codex 进程之间没有共享进度，不能并发发起登录来解决等待。重启、强制退出、系统休眠、外部撤权和服务故障仍可能使连接失败，不能承诺永远登录成功。

## 依据

- 固定官方源码：[设备登录及组织检查](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/63a7c4906c7dee10750011ea309b9eb78abb7eb0/internal/auth/device_flow.go)、[状态与刷新](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/63a7c4906c7dee10750011ea309b9eb78abb7eb0/internal/app/auth_command.go)、[只读状态](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/63a7c4906c7dee10750011ea309b9eb78abb7eb0/internal/app/auth_status_readonly.go)。
- [MCP 请求取消规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)。
- [Apple：安全打开 Mac 上的 App](https://support.apple.com/102445)。
