# 钉钉 AI 表格数据接口边界

当用户要求把 AI 表格数据传给 Automa 工作流，或要调整模板里的钉钉数据读取/回写逻辑时，使用本参考。

## 运行期选型

Automa 浏览器扩展运行在浏览器里，不能直接执行本机 `dws` CLI。交付给业务用户的 `.automa.json` 运行期应使用 HTTP block 调 OpenAPI。

`dws` 适合实施期和 agent 侧前置准备：查表结构、拿 fieldId、建表、补字段、做一次性数据导入或排障。用 `dws` 前必须先前台探活 `dws profile list --format json`，再用精确的 `dws aitable table get --base-id ... --table-ids ... --format json` 验证目标 Base/Table；不能只凭 profile 正常就认为资源可用。

## 当前发布模板的边界

发布类模板当前只实现结构脚手架：

- `POST https://api.dingtalk.com/v1.0/oauth2/accessToken`：用 appKey/appSecret 换 accessToken。
- `POST /v1.0/notable/bases/{baseId}/sheets/{sheetId}/records/list?operatorId={operatorId}`：列出记录，筛选第一条待发布行。
- `PUT /v1.0/notable/bases/{baseId}/sheets/{sheetId}/records?operatorId={operatorId}`：用 `records[].id` 回写状态。

它不证明认证通道、分页、页面发布成功判定或回写读回已在用户环境成立。
生产工作流必须按 [production-hardening.md](production-hardening.md) 补齐全页读取、强状态成功判定和回读。

## 凭据与运行变量

- 先按用户已成功环境明确选择 Automa `Storage -> Credentials` 或 `Storage -> Variables`；不得默认切换。
- `Credentials` 方案可引用 `{{secrets@dingtalkAppKey}}`、`{{secrets@dingtalkAppSecret}}`。
- `Storage Variables` 方案使用用户环境中已存在的 `$$` 变量，并在 token 请求前校验非空。
- 只有用户明确要求本机临时排障时，才可把 `appKey` / `appSecret` / `operatorId` 明文内联；该文件不能作为生产或共享交付物，也不要把值写入 CLI 命令、日志或文档。
- `baseId`、`sheetId/tableId` 是目标表配置，通常写入模板配置；如果同一个工作流要跨环境复用，应新增模板参数或改成 Automa 变量。
- 不要从 notable 调试 skill 的 `env-config.json`、token 缓存或任何本地凭据文件复制 appKey/appSecret/operatorId。
- 用户只有数字 userId 时，先用用户详情接口获取 unionId，再将 unionId 作为 notable `operatorId`。
- 如果用户详情接口返回 `50002`，应在该阶段检查 userId 是否处于当前应用可见/授权范围；不要把它误诊为 notable `operatorId` 格式问题，也不要静默替换成任意可查询用户。预期操作者及其目标 Base/Table 权限须由业务方确认。

## OpenAPI 能力速查

固定前缀：`https://api.dingtalk.com/v1.0/notable/bases/{baseId}`。
鉴权 header：`x-acs-dingtalk-access-token: <accessToken>`。
操作者身份：query 参数 `operatorId=<unionId>`。

| 能力 | 方法与路径 | 何时用于 Automa 模板 |
|---|---|---|
| 列表 | `GET /sheets` | 生成前或排障时确认表存在 |
| 取表 | `GET /sheets/{sheetId}` | 生成前 schema 校验可用 |
| 建表 | `POST /sheets` | 初始化模板另做，不塞进发布链路 |
| 改表 | `PUT /sheets/{sheetIdOrName}` | 管理动作另做 |
| 删表 | `DELETE /sheets/{sheetIdOrName}` | 高危管理动作，默认不用 |
| 列字段 | `GET /sheets/{sheetIdOrName}/fields` | 字段名/fieldId 校验可用 |
| 取字段 | `GET /sheets/{sheetIdOrName}/fields/{fieldIdOrName}` | 更新单选/多选选项前必取完整 choices |
| 建字段 | `POST /sheets/{sheetIdOrName}/fields` | 初始化表结构另做 |
| 改字段 | `PUT /sheets/{sheetIdOrName}/fields/{fieldIdOrName}` | 不能变更字段 type |
| 删字段 | `DELETE /sheets/{sheetIdOrName}/fields/{fieldIdOrName}` | 高危管理动作，默认不用 |
| 建记录 | `POST /sheets/{sheetId}/records` | 初始化/补数另做 |
| 列记录 | `POST /sheets/{sheetId}/records/list` | 发布模板读取候选行 |
| 取记录 | `GET /sheets/{sheetId}/records/{recordId}` | 已知 recordId 的二次校验 |
| 改记录 | `PUT /sheets/{sheetId}/records` | 发布模板回写状态 |
| 删记录 | `POST /sheets/{sheetId}/records/delete` | 高危管理动作，默认不用 |

## 字段和记录注意点

- `records/list` 是 POST，不是 GET。
- 可能超过一页的数据必须传递 `nextToken`；`hasMore=true` 却没有 token、token 重复或超过页数上限时立即失败，不得静默继续。
- 生产读写用原生 HTTP Request 块，超时至少 30000ms；不在 website JavaScript 中向 notable 发起变更请求。
- Credentials 或 Storage Variables 的必填名称要以字面量出现在 JSON 中；不用动态拼接变量名隐藏认证依赖。
- `record-update` 是 PUT 到 `/records`，recordId 放在 body 的 `records[].id`，不在 URL 路径里。
- singleSelect/multipleSelect 的 property key 是 `choices`；写记录时通常传选项名，读回可能是对象或数组，模板 JS 需要归一化 option name。
- 更新单选/多选选项时必须先 `field-get` 拿已有 `choices.id`，否则可能清空已有记录里的选项值。
- 字段更新接口不支持变更字段 type。
- filterUp 是计算字段，不能通过记录写入接口设置值。
- AI 字段复用 Field 接口，在 `property.decoratorConfigs` 中配置；`resultType=image/video` 时基础 type 是 `attachment`。

## 导入与附件

CSV/XLSX 导入是独立能力：申请 uploadUrl、PUT OSS、execute、poll status。它适合实施期初始化数据，不适合塞进普通发布工作流。

附件字段写入要先走文档资源上传三步：申请上传凭证、PUT 文件到 OSS、把返回的 `resourceUrl/resourceId` 写入附件字段。小红书发布模板里的 `素材路径` 是给浏览器 `upload-file` 用的本地文件路径，不是 AI 表格附件字段。

读取附件字段时，不同接口或字段形态可能返回数组、对象或嵌套 value，常见 URL key 包括
`url`、`resourceUrl`、`downloadUrl`、`previewUrl`、`thumbnailUrl`。这些 URL 可能是临时、
签名或需要登录态/应用鉴权的地址，不等价于本机文件路径。

如果要把 AI 表格附件上传到目标网站，网站页面上下文里直接 `fetch(attachment.url)` 很容易
遇到 CORS、鉴权或 URL 过期，Automa 日志常见表现是 `Failed to fetch`。优先在
`context: "website"` 的 `javascript-code` 中使用 `automaFetch('base64', { url })`，再构造 Blob/File/DataTransfer 注入真实 file input。
当前已验证版本的 background/popup JavaScript 不支持这个 base64 调用；原生 `upload-file` 仍会检查扩展的文件网址权限。

## DWS 对照

agent 侧可用 `dws aitable table get` 查字段目录，用 `dws aitable record query` 查询记录，用 `dws aitable record update` 回写记录；DWS 写入使用 fieldId 作为 cells key，和 OpenAPI 按字段名写入不同。

如果 DWS profile 探活失败、token lock 超时、目标 `table get` 返回 `not_authenticated` 或 `BASE_NOT_FOUND`，停止 DWS 路径，保留 OpenAPI 运行期模板，不要静默替换 Base/Table。
