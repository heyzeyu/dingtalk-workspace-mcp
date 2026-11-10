# 常用读写范例

以下都是 `write_dingtalk_sheet_operation` 的参数范例。业务 ID 来自当前真实结果。

## 少量单元格、公式与格式

```json
{
  "operation": "range update",
  "url": "https://alidocs.dingtalk.com/i/nodes/REAL_NODE",
  "profile": "CORP_ID:USER_ID",
  "sheet_id": "REAL_SHEET_ID",
  "parameters": {
    "range": "B2:C2",
    "values": [[
      {"type":"text","text":"4"},
      {"type":"text","text":"=B2*10"}
    ]]
  }
}
```

回读 B2:C2 的 raw_value；需要核对公式时另读 formula 模式。只改格式用 `range set-style`，例如 `{"range":"A1:D1","bg-color":"#0089FF","font-color":"#FFFFFF","font-weight":"bold"}`。不要用重写整格值的方式设置样式。

## CSV 与追加

`csv-put` 的 parameters 示例：

```json
{"start-cell":"A1","csv":"编号,数量\n00123,4\n","auto-convert":false}
```

首次写入空范围不需要 allow-overwrite。用户明确覆盖已有内容时传 `allow-overwrite:true`。多行字段、逗号和引号按 RFC 4180 转义；不要用简单 split(',') 解析结果。

`append` 的 parameters 示例：`{"values":[["测试C",1,30,"=B4*C4"]]}`。追加位置由服务端确定；不能为了重试而再次追加同一行。

## 工作簿和工作表

- `create-with-data`：仅传 profile 与 parameters，不传已有 url/sheet_id。例如 `{"name":"月报","values":[["项目","金额"],["测试",10]]}`。创建、写入、样式是多步操作，失败时先检查恢复事实。
- `new`：已有 url，parameters=`{"name":"明细"}`，不传 sheet_id；从返回与工作表列表取真实新 ID。
- `update`：已有 url/sheet_id，parameters=`{"name":"新名称","frozen-row-count":1}`。
- `copy`、`delete-sheet`：使用真实工作表 ID，删除时须有精确授权并传 confirmed。
- 行列数量、位置和索引各命令语义不同，先 describe 对应的 `insert-dimension`、`delete-dimension`、`update-dimension`，不要混用 0-based 数字和 A1/UI 行号。

## 其他操作

使用 category=`chart`、`pivot-table`、`filter`、`filter-view`、`cond-format`、`version` 等发现精确操作，再 describe 对应 leaf。图表 properties、透视表 properties 是完整 JSON 配置，不猜字段；如果已加载描述不足，用固定版本官方参考核对，再执行并 list/get 回读。

图表 list 的实际返回可能是 `floatCharts[]`，包含 `anchorRow/anchorCol/width/height`，数据引用是 `{sheetId,row,col,rowCount,colCount}` 的 0-based 矩形。更新前要重建 CLI 的 `properties={position,dimensions,chart}`：锚点行仍是 0-based，锚点列转为列字母；数据矩形转换成 A1 范围（row+1、col+1，按 count 计算终点）。同一工作表的引用可不带前缀，跨表引用先按真实 sheetId 找到工作表名称。保留轴、图例、标题等已有配置；不要将 readback 对象原样当成 PUT 输入。

导出 xlsx：读工具的 operation=`export`，parameters=`{"output":"月报-20261109.xlsx"}`，url 指向原生在线表格，不传 sheet_id。结果中 `local_file.verified_nonempty=true` 后可交付文件。

导入 xlsx/xls：写工具的 operation=`import create`，parameters 含 file，以及 folder-token/workspace 至少一个。导入只新建表格；若返回 taskId 未终态，用读工具 `import get` 查询，不重新导入同一任务。

完整接口定义来自插件内 `mcp/sheet-catalog.json`，与固定 DWS 版本绑定；参数进一步由官方 CLI 校验。
