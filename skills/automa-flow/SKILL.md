---
name: automa-flow
description: 从自然语言、AI 表格变量、模板和 Automa 录制选择器证据生成并校验 Automa 浏览器自动化工作流 JSON。用于用户要求搭建 Automa 工作流、生成 .automa.json、把 AI 表格数据作为工作流变量、校验 Automa JSON，或用 Automa 录制辅助定位页面元素时。
---

# automa-flow

## 角色定位

把这个 skill 当作 `packages/automa-flow` 的自然语言入口。包本身是确定性后端：负责读取 Automa 块注册表、构建合法 drawflow JSON，并执行 lint 与自然语言验收用例。Agent 负责把用户描述翻译成模板参数或 `WorkflowBuilder` 代码，再交给 CLI 生成和校验 `.automa.json`。

不要凭记忆编造 block label、连线 handle、页面 selector 或 Automa 运行时行为。

## 快速流程

1. 先确认交付对象和运行位置：

- 终端用户只运行工作流：使用公网安装的 Automa 浏览器扩展即可，不需要本地 fork 扩展，不需要 `packages/automa-flow`，也不需要 Automa 仓库根目录。
- Agent 或实施者要生成/校验/合并工作流：必须能访问 `automa-flow` CLI。优先使用本 skill 包内的 `vendor/automa-flow`；如果当前工作区就是 Automa 仓库，也可使用 `packages/automa-flow`。
- 本 skill 包不包含完整 Automa 仓库，不把 `npm run build` 或加载 `build/` 作为交付前置；只有用户明确要求验证 fork 扩展源码时，才另行拿完整仓库处理。
- 把 JSON 发到另一台电脑或另一个浏览器 Profile 时，必须按 [delivery.md](delivery.md) 重新配置并只读预检目标端 Storage；导出文件不会迁移 Storage 值，源电脑的运行证据也不会自动继承。

2. 定位 CLI 后端：

```bash
# skill 包安装形态
cd vendor/automa-flow

# 源码仓库形态
cd packages/automa-flow
```

首次使用若缺少 `node_modules`，在选定的 CLI 目录执行 `pnpm install`。如果 `pnpm` 被宿主 Corepack 探测卡住，优先使用已有 `node_modules/.bin/*` 验证命令；不要把浏览器扩展 build 当成 CLI 依赖。

3. 生成前先读取本地事实：

```bash
node bin/automa-flow.mjs list-blocks
node bin/automa-flow.mjs inspect-block <label>
```

如果工作流包含认证、分页、附件、发布、查联系方式或 AI 表回写，必须先读
[production-hardening.md](production-hardening.md)，冻结运行契约和验收级别。已有真实运行成功的 JSON 时，
优先把它当作 golden artifact 做最小修改和语义回归，不从空白模板重建。

4. 场景匹配时优先复用内置模板：

```bash
node bin/automa-flow.mjs generate xhs-publish \
  --config <template.config.json> \
  -o <output.automa.json>
```

当前模板：`xhs-publish`、`douyin-publish`。它们是结构脚手架，不是未经现场契约和浏览器验证就能交付的生产版。
`generate` 的业务参数统一来自 `--config` JSON；`--set key=value` 只用于少量顶层覆盖。
不要把状态字段、平台字段、表字段映射、页面 selector 等场景含义设计成 CLI option。
这些内容由 agent 在自然语言澄清后写入配置：selector 优先来自 Automa 录制产物，
表字段优先通过 OpenAPI 或 DWS 在生成前读取确认。`fieldMap` 的 key 是表字段名，value 是
Automa 变量名；页面块通过变量名读取数据，不能靠默认字段名隐式推导。

5. 新场景用 `WorkflowBuilder` 小步构建，使用 `addBlock`、`addCondition`、`connect` 和 `chain`。不熟悉的块必须先 `inspect-block`。

6. 交付前必须校验：

```bash
node bin/automa-flow.mjs validate <output.automa.json> --production
node bin/automa-flow.mjs doctor <output.automa.json>
node bin/automa-flow.mjs check-nl-case test/nl-cases/<case>.md <output.automa.json>
```

新生产文件只有在 `validate --production` 零 error 时才能交付；普通 `validate` 仅用于审计历史 JSON。warning 需要解释。`doctor` 输出的 Credentials、Storage Variables 和权限清单
必须转写给用户，不能只把 `.automa.json` 文件丢出去。

## AI 表格变量边界

AI 表格驱动的工作流，用 Automa 变量作为边界：

- 生成前必须让用户给出或确认：`baseId`、`sheetId/tableId`、`operatorId`、表结构、状态字段取值，以及“表字段 → Automa 变量 → 页面元素”的映射。
- `operatorId` 可以由用户给出，也可以让用户在 Automa Credentials 中配置 `dingtalkOperatorId`；默认不要写死个人 unionId。
- 内置模板的默认字段名只用于快速样例。真实表头不一致时必须在配置 JSON 写 `fieldMap`，并确认每个页面语义变量都由字段映射声明，例如标题变量、正文变量、素材变量。
- HTTP block 调钉钉 OpenAPI，并把响应赋值到 `tokenResp`、`listResp` 等变量。
- background `javascript-code` block 负责挑选目标记录，并用字面量变量名调用 `automaSetVariable('name', value)`。
- 页面操作 block 用 `{{variables@name}}` 引用变量。
- AI 表格附件字段不是本地路径。生成前要先确认 OpenAPI/DWS 读回结构，找到真实的
  `url`、`resourceUrl`、`downloadUrl`、`previewUrl`、文件名和 mime 字段；不要把附件
  cell 原样塞给 `upload-file`。
- 网站页面上下文不要直接 `fetch(attachment.url)` 下载 AI 表格附件。附件 URL 可能有
  鉴权、CORS 或临时有效期限制。优先在 `context: "website"` 的 JavaScript 中用
  `automaFetch('base64', { url })`，再转 Blob/File/DataTransfer 注入 `input.files`。不得在 background/popup JS 使用这个 base64 路径。
  原生 `upload-file` 仍需扩展的文件网址访问权限，不假设内联数据能绕过该检查。
- 应用凭据必须和用户已验证的运行环境一致：明确选择 `Credentials` 或 `Storage -> Variables`，
  不得默认改用 `{{secrets@...}}`，也不得 token 失败后静默切换来源。除非用户明确要求，
  不把 appKey/appSecret/operatorId 明文写入 JSON；明确要求的内联值也只能用于不共享的临时排障文件，不能通过生产交付门禁。
- 认证变量用字面量名读取，如 `automaRefData('variables', '$$dd_app_id')`。不用
  `'$$' + name` 或模板字符串动态拼变量名，否则 `doctor` 无法列全运行依赖（G18）。
- 钉钉 notable `operatorId` 必须是当前应用可用的 unionId。如果用户只配置了数字 userId，
  生成 `userId -> 用户详情 -> unionId -> operatorId` 链路。该 userId 还必须是业务方确认的预期操作者，
  处于应用可见/授权范围并有目标 Base/Table 权限；不能为了绕过错误静默换成任意可查询用户。
- 交付回复必须转写 `doctor` 列出的 Credentials 和 Storage Variables，不能只报一种。
- 钉钉 AI 表格 OpenAPI 的当前模板边界读 [openapi.md](openapi.md)；不要从调试 skill
  或本地 token/env 文件复制任何 secret。

## 录制辅助元素定位

selector 不确定时，先用 Automa 录制得到页面操作证据，不要猜。读 [recording.md](recording.md)。

常用闭环：

```bash
node bin/automa-flow.mjs import <recorded.automa.json>
node bin/automa-flow.mjs merge <skeleton.automa.json> <recorded.automa.json> \
  --after <blockId> -o <merged.automa.json>
node bin/automa-flow.mjs validate <merged.automa.json> --production
```

录制片段是线性的页面操作捕获，适合补 selector；它不会自动设计 API 调用、循环、条件分支或业务判断。
录制产物可能包含硬编码值、IME 逐键输入和滚动噪音；导入后按 [recording.md](recording.md) 的三层诊断处理。

## 运行硬规则

- `loop-data` 必须到达同 `loopId` 的 `loop-breakpoint`，否则可能无限循环。
- 内置发布模板默认只处理第一条待发布记录；不要把它描述成批量 loop。需要批量发布时，必须新增 loop 模板和对应 NL 用例，并验证每轮记录选择、状态回写、终止条件。
- `conditions` 的输出端口是条件组 id，不是数字端口；所有节点的每个输出端口都必须遵守注册表 `maxConnection`，不得靠一个端口隐式扇出。
- `new-tab` 上游的 `javascript-code` 必须使用 `context: "background"`。
- `upload-file` 路径必须是绝对路径，或运行时能解析成绝对路径的变量。
- 若上传素材来自 AI 表格附件字段，不能默认走页面 JS 直接 fetch 附件 URL；validate 出现
  G11 warning 时必须改成 `automaFetch('base64')` 或 `filename|mime|dataUrl`。
- 手动触发工作流在引用变量前必须有声明点。
- 不要使用 `notification` block，也不要把浏览器通知当作失败提示路径。当前环境可能报
  `notifications.create is invalid method`。失败提示优先用 JS `throw new Error(...)`、
  Automa Logs 和 `automaSetVariable('xxxError', message)`。
- 默认保持 `settings.notification=false`，避免工作流完成通知依赖浏览器 notifications 权限。
- 含发布或 POST/PUT/PATCH/DELETE 回写时，默认 `settings.restartTimes=0`；用 runId/业务唯一键做幂等。
- 钉钉读写用原生 HTTP Request 块，不在 website JavaScript 里发起变更请求；钉钉 HTTP 超时至少 30000ms。
- 变量字面量读取必须有声明点，且声明节点必须在读取节点的同一上游路径；每个嵌入 JavaScript 必须通过 G15 语法/局部变量交接检查。
- `doctor` 出现“Storage Variables 动态引用”或 validate 出现 G18 时，必须改成字面量变量名后再交付新 JSON；`--production` 会将 G18 升级为 error。

## 交付与浏览器验证

声明工作流可用前，读 [delivery.md](delivery.md) 和 [production-hardening.md](production-hardening.md)，
并说明实际达到 generated/imported/offline-replay/browser-run/side-effect-readback 的哪一级：

- 只生成 CLI JSON：不需要 build 整个 Automa 扩展。
- 浏览器导入/执行验证：需要已安装 Automa 扩展。
- 本地 fork 扩展 build 不属于 skill 交付前置；只有明确做扩展源码验证时才另开完整仓库流程。

## 验收用例

新自然语言场景要新增或更新 `test/nl-cases/*.md`：YAML frontmatter 写机器断言，正文写中文自然语言需求。生成物必须同时通过 `validate --production` 和 `check-nl-case`。

交付示例 prompt 在 `examples/`（如 `mall-coupon-publish`），随 skill 原样交给客户、由其 agent 现场追问运行时事实；客户首跑通过后再固化为验收用例。
