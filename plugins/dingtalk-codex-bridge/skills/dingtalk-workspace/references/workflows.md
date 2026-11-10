# 工作流程与范围

## 按业务选择

| 需求 | product | 常见流程 |
|---|---|---|
| 原生在线 Excel | sheet | dingtalk-sheets Skill，检查资源类型、选择真实 sheetId、有界读取、编辑并回读 |
| AI 多维表 | aitable | 查 Base → table → 字段/记录/视图；先描述 leaf，保留 fieldId/recordId |
| 文档、知识库、钉盘 | doc / wiki / drive | 列目录/搜索 → 查看节点类型与权限 → 读取 → 修改或创建 → 回读 |
| Markdown、HTML、脑图、白板 | markdown / html / mind / whiteboard | 按文档类型选择产品，确认节点与内容格式后操作 |
| 自己的待办 | todo | list/get → create/update → get；明确 executor，不能顺带给他人派任务 |
| 日历、会议室 | calendar | book list → schedule/freebusy → 用户授权的安排 → get；参会人邀请属于有影响的写入 |
| 通讯录、考勤、人才 | contact / attendance / hrbrain | 使用真实组织/用户 ID，查询已授权范围；组织与人事写入需要具体任务意图 |
| 聊天、DING、邮件 | chat / ding / mail | 先读或搜索定位目标；用户明确发送意图才发送；测试只做本地预览 |
| 审批、日志、合同 | oa / report / contract | 查询定义/实例及权限 → 查看精确动作；处理审批或签署必须有对应授权 |
| 听记、直播、AI 搜问 | minutes / live / aisearch | 分页查找再读取；异步产物检查处理状态 |
| 开发平台、A2UI、目标 | dev / devapp / devdoc / aicard / agoal | 查询文档与资源 → 描述目标命令 → 有授权的操作 → 回读 |
| 审计、授权、Agent 通道 | audit / pat / dingtalk-tag | 审计查询可读；凭据、行为授权及持久通道依目录走本机流程 |
| 已发布 MCP、事件 | mcp / event | 发现服务/工具或 EventKey，然后使用专用适配器 |

每种产品都有 discover/describe 入口；此表中的流程不代表所有命令都在当前账号有权限。列表返回应检查是否存在下一页，工具不自动承诺遍历全部资源。

## 最小调用示例

先 `describe_dingtalk_command` 查看 `doc read`，再使用真实节点与已选账号：

```json
{"command":"doc read","profile":"CORP_ID:USER_ID","parameters":{"node":"REAL_NODE_ID"}}
```

创建独立文档的本地预览（无需远端访问）：

```json
{"command":"doc create","profile":"CORP_ID:USER_ID","parameters":{"name":"示例","content":"# 示例\n\n正文"},"dry_run":true}
```

预览参数通过仅证明本插件的本地类型和 flag 契约检查。执行时移除 dry_run，记录真实返回的 nodeId，再用 doc read 校验内容。不要从示例中复制假 ID 执行。

## 本机工作流程

`describe_dingtalk_command` 会对本机命令返回原生 Help 或参数及不可直接调用原因。安装/升级 DWS 使用本插件 setup，保持固定版本。首次桌面连接用专用 connect_dingtalk / get_dingtalk_connection 流程；目录中的 auth login、profile/config 修改、应用凭据及 webhook/Agent 通道生命周期需要用户相应任务意图，由本机官方 CLI 完成；不要将 Token、AppSecret、配置导出或设备凭据复制到聊天。

官方不提供的能力保持 unavailable。不要把其他版本/产品的命令猜加到当前 CLI。升级依赖时重新采集 schema 和所有 leaf Help，构建目录并重新验证，不直接放开任意 shell/API 地址。
