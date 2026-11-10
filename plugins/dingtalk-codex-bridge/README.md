# 钉钉 Workspace Codex MCP 0.3.1

0.3.3 使用钉钉官网公开 Logo，同时配置插件页与聊天输入框图标，图片随包分发。

0.3.2 修复 macOS 运行时警告夹在原生错误 JSON 前时的解析，保留官方业务错误码，避免把权限不足误报为响应格式异常。

基于官方 [DingTalk Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) 的非官方适配插件，固定依赖 **DWS 1.0.67**。

## 接入范围

索引 33 个业务域和本机命令，共 1,596 条。1,502 条业务命令可通过结构化 MCP 路由调用（690 读、727 写、85 删除等操作）；事件流、Raw OpenAPI、已发布 MCP 和诊断单独适配。52 条登录、凭据、配置、持久 Agent 命令提供本机流程指引；33 条官方已撤下或占位命令不可执行。

业务包括文档、在线电子表格、AI 多维表、钉盘、知识库、日历、待办、通讯录、聊天、邮件、DING、审批、日志、合同、考勤、人才、听记、脑图、白板、HTML/Markdown、开发平台、审计与事件等。各操作能否在实际组织执行仍取决于授权和业务条件。

目录接入与本地参数编译不等于所有 API 已在真实账号验收。安装包根目录 CLI-COVERAGE.md/CSV 是逐项清单，VALIDATION.md 区分机械检查、模拟测试和真实业务验证。

## 17 个 MCP 工具

| 工具 | 用途 |
|---|---|
| discover_dingtalk_commands | 按业务域、关键词、接入模式分页发现命令 |
| describe_dingtalk_command | 读取精确命令、参数类型、原生 Usage、影响和限制 |
| read_dingtalk_command | 结构化业务查询、读取或导出，以及只读诊断 |
| write_dingtalk_command | 已授权的创建、修改、删除；可做纯本地预览 |
| listen_dingtalk_events | 1–30 秒、最多 20 条的事件接收，温和关闭 |
| call_dingtalk_openapi | 官方域名 Raw API，自建应用认证，默认本地预览 |
| invoke_dingtalk_published_mcp | 按真实服务/工具 Schema 调用已发布 MCP，默认本地预览 |
| get_dingtalk_status / list_dingtalk_profiles | 查看登录快照与候选账号 |
| inspect_dingtalk_resource | 识别资源类型及快捷方式目标 |
| get_dingtalk_workbook / get_dingtalk_sheet_info | 识别原生表格资源、工作表和结构 |
| read_dingtalk_sheet_csv / read_dingtalk_sheet_cells | 有界区域读取，区分值与公式 |
| describe_dingtalk_sheet_operation | 发现 99 项 Sheet 操作及参数 |
| read_dingtalk_sheet_operation / write_dingtalk_sheet_operation | 保留原版 Sheet 读写接口 |

MCP 服务名 `dingtalk_sheets` 为兼容保留。无需注册 1,500 多个工具：先发现和描述需要的命令，再用统一路由调用，避免占满模型上下文。

## 安装与升级

需要 Node.js 20+、Codex 本地插件支持、curl 与 tar。实际验证平台为 macOS ARM64；其他官方 macOS/Linux/Windows 架构提供固定下载映射，尚未实机验证。

保留完整解压目录，包括隐藏的 `.agents/`，在安装包根目录执行：

```bash
node plugins/dingtalk-codex-bridge/scripts/setup.mjs install-cli
codex plugin marketplace add /absolute/path/to/unpacked-directory
codex plugin add dingtalk-codex-bridge@dingtalk-local
```

升级已有来源时替换保留的源码目录，再执行 plugin add。若解压到新目录且同名 marketplace 仍指向旧目录，先将本地来源指向新目录。确认安装版本 0.3.1，新开聊天加载；必要时重启 Codex。

CLI 保存在 `~/.local/share/dingtalk-codex-bridge/dws/1.0.67/<platform>-<arch>/dws`（Windows 为 dws.exe）。下载按固定官方 SHA-256 校验，运行检查版本并禁用自动更新检查，不覆盖全局 CLI，也不安装上游其他 Skills。

离线安装同版本官方发行包：

```bash
node plugins/dingtalk-codex-bridge/scripts/setup.mjs install-cli --archive /path/to/official-archive.tar.gz
```

## 登录与配置

已有 DWS 登录直接复用；凭据由官方 CLI/系统钥匙串管理。实际组织、账号和资源必须有相应权限；本地登录快照不能证明线上访问。

```bash
node plugins/dingtalk-codex-bridge/scripts/setup.mjs status
node plugins/dingtalk-codex-bridge/scripts/setup.mjs login
# 无头终端使用设备流，保持该进程轮询：
node plugins/dingtalk-codex-bridge/scripts/setup.mjs login --device
```

不要通过重置授权解决沙箱/钥匙串限制，也不要在聊天中粘贴凭据。

| 环境变量 | 用途 |
|---|---|
| DWS_CLI_PATH | 另一份同版本官方 CLI 的绝对路径 |
| DWS_CONFIG_DIR | 显式选择官方 DWS 配置目录 |
| DINGTALK_BRIDGE_CACHE_DIR | 本插件 CLI 缓存目录 |
| DINGTALK_BRIDGE_FILES_DIR | 文件允许目录，默认 ~/Downloads |
| DWS_CLIENT_ID / DWS_CLIENT_SECRET | 原生 Raw API 的独立自建应用认证；用户 OAuth 不替代它 |
| DINGTALK_BRIDGE_SECRET_DOC_PASSWORD | 文档口令引用，实际值仅由本机服务器环境传入 |
| DINGTALK_BRIDGE_SECRET_WEBHOOK_TOKEN | Webhook Token 引用 |

其他 `DINGTALK_BRIDGE_SECRET_*` 名称必须先在 MCP env_vars 中声明并由服务器环境配置；工具请求只传变量名。

## 使用流程

先 discover 找业务命令，再 describe 查看精确 leaf。所有业务调用显式传 `profile=CORP_ID:USER_ID`，parameters 使用原生 flag 名，不带 `--`；JSON 字段可直接传对象或数组，位置参数仅在 Usage 声明时使用。

读取示例（ID 必须来自真实读取结果）：

```json
{"command":"doc read","profile":"CORP_ID:USER_ID","parameters":{"node":"REAL_NODE_ID"}}
```

创建的纯本地预览：

```json
{"command":"doc create","profile":"CORP_ID:USER_ID","parameters":{"name":"示例","content":"# 示例\n\n正文"},"dry_run":true}
```

本地预览不启动 CLI、不访问远端，仅验证本地类型及 flag 契约。实际创建后记录 nodeId，再回读；不能凭提交回执宣称完成。

用户既有明确目标与动作即为授权，普通编辑无需重复确认；官方要求确认的精确动作已有授权时用 `confirmed=true`。发送消息、邮件、评论、DING、通知他人或处理审批须有对应明确意图。仅要求测试插件时，这些操作只做本地预览。

超时或 `MUTATION_OUTCOME_UNKNOWN` 后先读回/查任务，不能盲目重放创建、追加、发送和审批。后台任务被接受与最终完成应分别报告。

## 文件与专门适配器

文件、JSON 文件替代、文件数组、检查点和 `@file` 都限制在 Downloads 或配置目录，检查真实路径和符号链接；输入文件/目录累计最大 20 MB，目录最多 1,000 项且不接受符号链接。显式 stdin 或单参数最多 150 KB。下载及落盘模式必须指定新输出文件/目录（父目录已存在），不开放原生 overwrite 开关；普通业务 CLI 的工作目录也固定在允许目录。检查返回 local_files 的 verified_nonempty 后再宣称导出成功。正文中的内联图片只接受已上传的 mediaid: 引用；本地文件通过显式 file/media-files 等受控参数处理，避免正文隐式读取文件。

事件适配器按原生归属规则清理订阅并温和退出，不 SIGKILL 事件进程。零事件只证明启动和退出，投递仍需真实事件验证。Raw API 默认本地预览，仅允许 api.dingtalk.com / oapi.dingtalk.com，最多 10 页；实际调用需要独立应用凭据和精确授权。已发布 MCP 必须先发现真实工具，实际执行由原生 CLI 刷新并校验 Schema。

原生在线 Sheet 保留资源类型检查、有界 5,000 格读取、明确 sheetId、公式与显示值区分和独立读写验证。上传 xlsx 及 AI 多维表是不同产品，不能直接当 Sheet 节点操作。

## 开发验证

```bash
cd plugins/dingtalk-codex-bridge
npm test
npm run verify:catalog
node scripts/smoke.mjs
node scripts/workspace-smoke.mjs --profile CORP_ID:USER_ID --report /path/to/new-report.json
```

具备用户测试写入授权时，增加 `--write own-fixtures` 会创建独立文档、自有待办和 AI 表格 Base，并逐步回读。报告包含私有资源 ID，不能随插件分发；已有报告拒绝重放。失败后审查 started/needs_audit 步骤并回查，而不是重复创建。Sheet 写入脚本为 `scripts/write-smoke.mjs`，具体参数查看其 Usage。

Schema/Help 采集和目录重建流程见安装包根目录 CLI-COVERAGE.md。插件 MIT，官方 Schema/Help/CLI 采用 Apache-2.0，来源见 [UPSTREAM.md](UPSTREAM.md)。


## 隐私与分发

0.3.1 增加逐文件发布清单和 ZIP 字节检查。不要直接压缩使用中的项目目录：运行日志、验收报告、导出文件和登录配置都不属于分发材料。收件人在自己的电脑上安装官方 CLI 并使用自己的账号授权；压缩包不会携带原作者的登录状态。DWS 原生凭据/系统钥匙串及远端权限不由本插件复制或转交。

在安装包根目录执行（Python 3.9+，仅用于重新打包）：

```bash
python3 plugins/dingtalk-codex-bridge/scripts/package-release.py --output /path/outside/source/release.zip
```

维护者还可通过 `--private-markers /path/to/private-marker-list.json` 检查自己已知的名字、账号/资源 ID 和路径。该 JSON 为字符串数组，保存在源码目录外，不随包分发。打包脚本拒绝符号链接、运行数据/凭据文件、可识别凭据形态、已知私有标记，以及覆盖已有 ZIP；生成 FILES.sha256 并重验 CRC、成员集合与原始字节。静态规则不能替代来源审查，使用者仍应核对实际待分享 ZIP。
