# 官方 CLI 功能接入清单 0.4.0

基准：DWS 1.0.67。1,559 条官方运行时 Schema 命令 + 37 条公开本机工具 leaf，共 1,596 条唯一命令。分组父命令、help 别名及全局 flag 不另计为业务能力。公开 Help 未暴露的内部/隐藏命令不在支持契约内。

## 接入模式

| 模式 | 数量 | 实际处理 |
|---|---:|---|
| mcp | 1,502 | 通用结构化读写（含 99 项 Sheet） |
| utility_adapter | 5 | 只读 auth status、profile/config list、version、doctor |
| event_adapter | 2 | consume / +listen-im 有界流适配 |
| raw_adapter | 1 | api 官方域名适配，需要自建应用认证 |
| published_adapter | 1 | 已发布 MCP 动态工具，原生 Schema gate |
| local_workflow | 52 | 凭据、配置、安装、行为授权及持久 Agent 的本机指引 |
| unavailable | 33 | 31 条 Schema 撤下能力 + cache/recovery 两个兼容占位 |

逐命令状态、效果与原因见 [CLI-COVERAGE.csv](CLI-COVERAGE.csv)。本机流程有发现/描述入口，不通过业务执行器直接运行。接入数不等于线上逐项通过数。

## 33 个业务域

| 产品 | 原生描述 | Schema 命令 | 通用 MCP | 专门适配 | 本机流程 | 官方不可用 |
|---|---|---:|---:|---:|---:|---:|
| agoal | Agoal 管理 | 5 | 5 | 0 | 0 | 0 |
| aicard | Inspect, validate, preview, and manage DingTalk A2UI templates | 6 | 6 | 0 | 0 | 0 |
| aisearch | AI 搜问 | 6 | 4 | 0 | 0 | 2 |
| aitable | AI 表格操作 | 313 | 313 | 0 | 0 | 0 |
| attendance | 考勤打卡 / 排班 / 统计 | 66 | 65 | 0 | 0 | 1 |
| audit | 操作审计日志管理 | 3 | 3 | 0 | 0 | 0 |
| calendar | 日历日程 / 会议室 / 闲忙 | 49 | 49 | 0 | 0 | 0 |
| chat | 群聊 / 消息 / 机器人 | 243 | 242 | 0 | 0 | 1 |
| contact | 通讯录 / 用户 / 部门 / 角色 / 人员关系 | 68 | 66 | 0 | 0 | 2 |
| contract | 智能合同管理 | 44 | 40 | 0 | 0 | 4 |
| dev | 开放平台开发者能力 | 75 | 63 | 0 | 12 | 0 |
| devapp | devapp shortcuts | 25 | 24 | 0 | 1 | 0 |
| devdoc | 开放平台文档搜索 | 2 | 1 | 0 | 0 | 1 |
| ding | DING 消息 / 发送 / 撤回 | 7 | 6 | 0 | 0 | 1 |
| dingtalk-tag | DEAP 平台 | 30 | 24 | 0 | 6 | 0 |
| doc | 钉钉文档管理 | 99 | 99 | 0 | 0 | 0 |
| drive | 钉盘文件管理 | 86 | 84 | 0 | 0 | 2 |
| event | 事件订阅 (DingTalk Stream 长连接) | 6 | 4 | 2 | 0 | 0 |
| hrbrain | 组织大脑：人才池、员工档案与人才搜索 | 24 | 13 | 0 | 0 | 11 |
| html | HTML 文件处理 | 4 | 4 | 0 | 0 | 0 |
| live | 直播列表 / 信息 | 2 | 1 | 0 | 0 | 1 |
| mail | 邮箱 / 邮件收发 | 56 | 52 | 0 | 0 | 4 |
| markdown | Markdown 文件处理 | 6 | 6 | 0 | 0 | 0 |
| mcp | 管理和调用已发布 MCP 服务 | 4 | 2 | 1 | 1 | 0 |
| mind | 钉钉脑图 | 5 | 5 | 0 | 0 | 0 |
| minutes | AI 听记 / 会议纪要 | 75 | 75 | 0 | 0 | 0 |
| oa | OA 审批 / 同意 / 拒绝 / 撤销 | 38 | 38 | 0 | 0 | 0 |
| pat | 行为授权管理 | 4 | 0 | 0 | 3 | 1 |
| report | 钉钉日志（OA 周报应用 / 日志模版填报） | 11 | 11 | 0 | 0 | 0 |
| sheet | 钉钉表格管理 | 99 | 99 | 0 | 0 | 0 |
| todo | 待办任务管理 | 44 | 44 | 0 | 0 | 0 |
| whiteboard | 钉钉白板管理 | 17 | 17 | 0 | 0 | 0 |
| wiki | 知识库 / 空间管理 / 节点管理 / 成员管理 / 权限管理 / 动态查询 | 37 | 37 | 0 | 0 | 0 |

## 如何复核与更新

目录从真实固定版本可执行文件的 Schema 与每条 leaf Help 双重生成。1,559 条 Help 均已采集；两个 dev mcp tool 的长 --help 上游解析异常以原生 -h 取得。共匹配 5,874 个原生参数条目，其中可用命令的 5,794 个参数全部匹配，无漂移；其余匹配项属于官方不可用命令。1,502 个通用业务路径用必填合成参数编译，不调用网络；这不等于可选参数的所有组合都已验证。

以下步骤只采集静态元数据，不执行业务 handler（需 Python 3，目录采集约数分钟）：

```bash
cd plugins/dingtalk-codex-bridge
python3 scripts/collect-cli-contracts.py --cli /absolute/path/to/dws --output /tmp/dws-contracts
python3 scripts/build-workspace-catalog.py \
  --schema /tmp/dws-contracts/schemas-all.json \
  --contracts /tmp/dws-contracts/all-contracts.json \
  --utilities /tmp/dws-contracts/utility-help.json --root "$PWD"
npm run verify:catalog
npm test
```

只使用 1.0.67 executable；换版本需要同步固定版本检查、安装器 SHA-256、目录与回归验证。完整原始 Schema/Help 不随包重复分发，派生目录、构建脚本和许可随包提供。真实验收范围见 [VALIDATION.md](VALIDATION.md)。

## 0.4.0 的本地 I/O 约束

在原生参数契约之上，下载/落盘必须指定允许目录内的新目的地，url-only/inline 模式无需落盘路径；不启用 overwrite。JSON 或文件、检查点/基线、文件数组及原生 @文件别名都采用共同路径检查。正文图片只使用已上传的 mediaid: 或显式受控文件上传，避免正文隐式读取文件。describe 返回 bridge_required_destinations 和 local_io_policy；这些是本插件的额外边界，CSV 保留原生目录状态。
