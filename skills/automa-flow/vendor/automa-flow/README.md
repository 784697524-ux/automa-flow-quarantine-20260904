# automa-flow CLI snapshot

Automa 浏览器自动化工作流的**离线生成器**：把「在 Automa 编辑器里手工拖拽搭流程」
变成「代码/CLI/agent 直接生成 `.automa.json`」。

这是随 `automa-flow` Skill 分发的可执行 CLI 快照。

## 为什么可行

- Automa 导入链路零校验（`src/utils/workflowData.js#importWorkflow`），
  JSON 就是唯一契约；
- 块注册表是纯数据（`src/utils/shared.js` 的 `tasks`），P0 脚本把它提取成
  `src/generated/block-registry.json` 作为唯一块事实源；
- 边规则确定：`sourceHandle = ${nodeId}-output-${port}`、
  `targetHandle = ${nodeId}-input-1`（引擎按此解析）。

## 分层

| 目录 | 职责 |
|---|---|
| `scripts/extract-block-registry.mjs` | P0：从 automa 源码提取块注册表（`pnpm registry`） |
| `src/registry.ts` | 注册表加载器（唯一块事实源入口） |
| `src/builder/` | `WorkflowBuilder`：addBlock/connect/addCondition/emit |
| `src/lint/` | 生成期质检：G*（图结构/引擎硬约束）、B*（官方块校验移植）、T*（模板语法） |
| `src/templating.ts` | mustache `{{ns@key}}` 语法解析 |
| `src/nl-case.ts` | NL 验收用例解析与断言（frontmatter 断言 + 正文自然语言） |
| `src/templates/` | 场景模板（`xhs-publish` / `douyin-publish`） |
| `src/cli/` | CLI：list-blocks / inspect-block / generate / import / merge / validate / doctor / check-nl-case |
| `skills/automa-flow/` | agent 契约：自然语言 → JSON、录制辅助定位、交付验证 |
| `test/nl-cases/` | NL 验收用例（YAML/JSON frontmatter = 断言，正文 = 自然语言） |

## 快速上手

### 交付形态先选清楚

- 普通业务用户：使用公网安装的 Automa 扩展，导入生成好的 `.automa.json` 即可；不需要本地 fork 扩展，不需要这个源码包，也不需要 Automa 仓库根目录。
- Agent/实施者：需要 `automa-flow` CLI。可使用本仓 `packages/automa-flow`，也可用 `pnpm skill:pack` 打出的 `.skill` 包；skill 包内会带 `vendor/automa-flow` CLI 代码快照。
- 扩展开发/fork 验证：不属于 skill 交付路径；只有明确要验证本仓浏览器扩展源码时，才需要完整 Automa 仓库根目录，执行 `npm run build` 后加载 `build/`。

```bash
cd packages/automa-flow
pnpm install            # 本包自包含安装（不依赖 automa 根的依赖）
pnpm registry           # 重新提取块注册表（automa 升级后；事实源默认取两级上的仓库根）
pnpm test
pnpm skill:pack         # 生成 dist/automa-flow.skill 和 dist/automa-flow.zip

# 生成 xhs-publish 工作流（appKey/appSecret 默认走 Automa Credentials）
node bin/automa-flow.mjs generate xhs-publish \
  --config ./xhs.config.json \
  -o ~/Downloads/xhs-publish.automa.json

# 少量顶层配置也可用 --set 覆盖，适合临时验证
node bin/automa-flow.mjs generate xhs-publish \
  --set baseId=<baseId> --set sheetId=<sheetId> \
  -o ~/Downloads/xhs-publish.automa.json

# 生成 douyin-publish
node bin/automa-flow.mjs generate douyin-publish \
  --config ./douyin.config.json \
  -o ~/Downloads/douyin-publish.automa.json

# 质检任意 .automa.json
node bin/automa-flow.mjs validate ~/Downloads/xhs-publish.automa.json --production

# 输出业务用户运行前检查清单
node bin/automa-flow.mjs doctor ~/Downloads/xhs-publish.automa.json

# 分析 Automa 录制/导出的工作流，抽取选择器清单
node bin/automa-flow.mjs import ~/Downloads/recorded.automa.json

# 可选：清理录制噪音，并把录制里的文本/文件路径按 nodeId 参数化
node bin/automa-flow.mjs import ~/Downloads/recorded.automa.json \
  --drop-noise \
  --parametrize '{"forms":{"<formsNodeId>":"postTitle"},"upload":{"<uploadNodeId>":"mediaPath"}}' \
  -o ~/Downloads/recorded.cleaned.automa.json

# 把录制片段插入骨架工作流指定 block 后
node bin/automa-flow.mjs merge ~/Downloads/skeleton.automa.json ~/Downloads/recorded.automa.json \
  --after <blockId> -o ~/Downloads/merged.automa.json

# 用 NL 验收用例断言一份生成物
node bin/automa-flow.mjs check-nl-case test/nl-cases/douyin-publish.md ~/Downloads/douyin-publish.automa.json
```

生成物直接在 Automa 扩展里 `Workflows → Import workflow from file` 导入即可运行。
若使用默认的 secrets 引用，导入后在 Automa「Storage → Credentials」创建
`dingtalkAppKey`、`dingtalkAppSecret` 和 `dingtalkOperatorId`。
可先运行 `doctor` 命令得到可转交给业务用户的检查清单；其中会提示 secret 缺失时常见的
`paramError-operatorId` 等错误含义。

CLI 生成 `.automa.json` 不需要 build 整个 Automa 仓库；只有要验证本仓 fork 的浏览器
扩展、录制 UI 或扩展源码改动时，才需要在仓库根目录 `npm run build` / `npm run dev`，
并从 `build/` 加载 unpacked extension。更完整的交付检查见
[`delivery.md`](../../delivery.md)。

`.skill` 包不是浏览器扩展包。它服务 agent/实施者，里面包含中文 skill 文档和
`vendor/automa-flow` CLI 代码快照；浏览器端仍使用公网 Automa 扩展或本仓 build 出来的
扩展。

打包脚本会同时产出两种格式：

- `dist/automa-flow.skill`：Codex 本地安装使用，包根目录直接是 `SKILL.md`。
- `dist/automa-flow.zip`：标准生态/千问提交使用，包内路径是 `automa-flow/SKILL.md`，
  符合“压缩整个技能目录”的要求。

两个包都会包含 `MANIFEST.json`，记录包内文件 sha256。脚本按排序文件列表打包，固定文件
时间戳，并使用 `zip -X` 去掉额外属性；同一份源码重复打包应得到相同 sha256。

模板参数统一来自 `--config` 指向的 JSON object，`--set key=value` 只用于少量顶层字段覆盖。
CLI 不再把 `statusField`、`fieldMap`、页面 selector、平台过滤等业务含义设计成独立 option；
这些内容应由 agent 在自然语言澄清、OpenAPI/DWS 查表结构、Automa 录制抽 selector 后写入配置。

澄清后的配置示例：

```json
{
  "baseId": "base_xxx",
  "sheetId": "sheet_xxx",
  "publicId": "manual-trigger-001",
  "statusField": "处理状态",
  "pendingValue": "待处理",
  "publishedValue": "已完成",
  "fieldMap": {
    "标题": "postTitle",
    "正文": "postBody",
    "素材路径": "mediaPath"
  },
  "titleVar": "postTitle",
  "bodyVar": "postBody",
  "mediaVar": "mediaPath",
  "titleSelector": "[data-testid=\"title\"]",
  "bodySelector": "[data-testid=\"body\"]"
}
```

`fieldMap` 的 key 是 AI 表格字段名，value 是 Automa 变量名；页面操作块只认变量名。
因此表头可以完全自定义，但要在配置里说明页面元素读取哪个变量。不要把默认字段名理解成固定表结构。

## AI 表格 OpenAPI 边界

当前发布模板只覆盖必要的最小闭环：换 token、`records/list` 查第一条待处理记录、
`records` PUT 回写状态。`record-get` 对这个链路不是必需；如果要做生成前 schema
校验，再增加 sheet/field list/get；如果要自动建表、补字段、导入或写附件字段，应另建模板。
接口细节和凭据策略见 [`openapi.md`](../../openapi.md)。

DWS CLI 可以用于实施期查表结构、拿 fieldId、创建/补字段或排障，但 Automa 浏览器扩展
运行期不能直接执行本机 `dws`；交付给业务用户的 `.automa.json` 仍使用 HTTP block 调
OpenAPI。

## 自然语言 → JSON（NL 验收）

本包**不内置 NL 解析器**（设计如此）：LLM agent 当 NL 前端，本包当确定性后端。
契约见 [`SKILL.md`](../../SKILL.md)：
先查注册表事实 → Builder/模板生成 → `validate --production` 零 error 才交付。

NL 的「不确定性」关在 LLM 层，落盘 JSON 永远过确定性闸门；验收用
`test/nl-cases/*.md`（YAML/JSON frontmatter 是机器断言，正文是自然语言描述）：

```bash
node bin/automa-flow.mjs check-nl-case test/nl-cases/<case>.md <generated.json>
```

新场景照现有两条用例新增即可，把「NL 描述 ↔ 结构断言」沉淀为回归资产。

## 录制辅助选择器

当页面元素选择器不稳定时，先用 Automa 自带 Recording 录一小段真实操作，把导出的
`event-click` / `forms` / `upload-file` 等 block 当作选择器事实源，再回填模板或
`WorkflowBuilder` 代码。录制只解决页面操作选择器，不会自动推导 AI 表格 API、条件、
循环和业务分支。

`automa-flow import` 可从录制/导出的工作流里打印选择器清单；`automa-flow merge`
可把单入口、单尾节点的线性录制片段插入骨架指定 block 之后。录制仍只负责页面操作片段，
不会推导 AI 表格 API、条件、循环和业务分支。详细流程见
[`recording.md`](../../recording.md)。

`import` 还会诊断三类录制问题：噪音节点、IME/contenteditable 输入缺陷、硬编码文本或
本地文件路径。默认只报告不修改；需要写出转换结果时显式加 `--drop-noise` 和
`--parametrize`。参数化使用 nodeId 映射，避免同 selector 多节点时撞车。

## 通知能力避坑

面向业务用户交付的工作流不要使用 `notification` block；部分 Automa/浏览器环境会报
`notifications.create is invalid method`。生成器默认 `settings.notification=false`，
避免工作流完成通知依赖浏览器通知权限。成功时自然结束；失败时用 Automa Logs、变量或
明确 `throw new Error(...)` 暴露原因。

## 附件字段与上传

AI 表格附件字段读出来通常是对象/数组，里面的 `url`、`resourceUrl`、`downloadUrl`
或 `previewUrl` 可能是临时、签名或需要鉴权的地址，不是本地文件路径。

如果要把附件上传到小红书等目标网站，不要在网站页面 JS 里默认直接
`fetch(attachment.url)`；这很容易在 Automa 运行日志里表现为 `Failed to fetch`。
优先在 `context: "website"` 的 JavaScript 中用 Automa 注入的
`automaFetch('base64', { url })` 取回 data URL，再构造 Blob/File/DataTransfer
注入真实 file input。已验证的当前运行时不支持在 background/popup JavaScript
这样调用；原生 `upload-file` 仍会检查扩展的文件网址权限。`validate` 会用
G11/G12 检查危险写法，`doctor` 会输出面向业务用户的排查提示。

## 关键引擎约束（写模板/用 Builder 必读）

1. **循环必须收尾**：`loop-data` 后必须接同 `loopId` 的 `loop-breakpoint`，
   引擎只在 breakpoint 做终止判断，直连回 `loop-data` 会无限循环（G02 拦截）。
2. **conditions 端口是条件组 id**：先 `addCondition` 拿 id，再
   `connect(cond, next, { port: condId })`。
3. **new-tab 上游的 JS 块必须 `context: "background"`**（G05）。
4. **执行上下文**：`settings.execContext = "popup"` 时长无限且支持 `!!` JS 表达式；
   `background` ≈5 分钟。
5. **外部触发**：预置 `settings.publicId` 后，任意页面可
   `dispatchEvent(new CustomEvent('automa:execute-workflow', {detail: {publicId, data: {variables}}}))`
   触发；或打开 `chrome-extension://<extId>/execute.html#/<workflowId>?key=value`。
