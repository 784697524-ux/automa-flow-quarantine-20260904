# 交付与浏览器验证

打包、安装、或声明生成的 Automa 工作流已经验证前，使用本参考。

## 先选交付对象

普通业务用户：

- 推荐使用公网安装的 Automa 浏览器扩展。
- 用户只需要导入生成好的 `.automa.json`、按 `doctor` 配置 Credentials 或 Variables、开启所需权限。
- 不需要安装本地 fork 扩展，不需要拿到 Automa 仓库，也不需要 `packages/automa-flow`。

Agent 或实施者：

- 需要 `automa-flow` CLI 来生成、校验、分析录制片段和合并工作流。
- 推荐交付 `.skill` 包，包内应包含 `vendor/automa-flow` CLI 代码快照。
- 如果在源码工作区实施，也可以直接交付/使用 Automa 仓库里的 `packages/automa-flow`。

扩展开发或 fork 验证者：

- 这不是 skill 包交付路径。只有用户明确要验证本仓 fork 扩展源码、改录制 UI、或重新打浏览器扩展包时，才需要完整 Automa 仓库根目录。
- 这类验证需要 build 后从 `build/` 加载本地 unpacked extension，或用 `build:zip` 打浏览器扩展包。

## CLI 与 skill 包关系

`SKILL.md` 本身只是 agent 的操作说明；真正生成 `.automa.json` 的代码在 `automa-flow` CLI 中。

推荐打包方式：

```bash
cd packages/automa-flow
node scripts/pack-skill.mjs
```

产物有两个：

- `dist/automa-flow.skill`：Codex 本地 agent 安装形态，包根目录就是 `SKILL.md`。
- `dist/automa-flow.zip`：标准生态/千问提交形态，包内必须带外层目录
  `automa-flow/SKILL.md`。

两者由同一个 staging 目录生成，内容一致，只差是否带外层目录。脚本会写入
`MANIFEST.json`，按字典序列出包内文件 sha256；打包时固定文件时间戳并使用 `zip -X`。

Codex `.skill` 包内结构应包含：

```text
SKILL.md
recording.md
delivery.md
openapi.md
production-hardening.md
MANIFEST.json
vendor/automa-flow/
```

标准 `.zip` 包内结构应包含：

```text
automa-flow/SKILL.md
automa-flow/recording.md
automa-flow/delivery.md
automa-flow/openapi.md
automa-flow/production-hardening.md
automa-flow/MANIFEST.json
automa-flow/vendor/automa-flow/
```

`vendor/automa-flow` 包含 CLI 源码、模板、lint、测试、lockfile 和已生成的 block registry，不包含 `node_modules`。安装 skill 后，首次使用 CLI 时进入 `vendor/automa-flow` 执行 `pnpm install`。

如果只把 `skills/automa-flow/` 三个 Markdown 文件复制出去，而不带 `vendor/automa-flow` 或源码仓库路径，那么这个 skill 只能指导流程，不能独立运行生成、校验、import、merge。

标准生态提交必须使用 `.zip`，并压缩整个 `automa-flow/` 目录，而不是进入目录后压缩内部文件。
验收时至少检查：

```bash
unzip -t dist/automa-flow.skill
unzip -t dist/automa-flow.zip
unzip -Z1 dist/automa-flow.zip | grep '^automa-flow/SKILL.md$'
unzip -Z1 dist/automa-flow.zip | wc -l
du -h dist/automa-flow.zip
shasum -a 256 dist/automa-flow.skill dist/automa-flow.zip
```

## 选择运行路径

只生成 CLI `.automa.json`：

- 在 `vendor/automa-flow` 或 `packages/automa-flow` 下工作。
- 不需要 build 整个 Automa 仓库。
- CLI 通过包内 `tsx` 运行 TypeScript；需要当前 CLI 目录的 `node_modules` 已存在。
- 交付前运行 `node bin/automa-flow.mjs validate <file> --production`；普通 `validate` 只审计历史 JSON。

浏览器导入与执行验证：

- 需要已安装 Automa 浏览器扩展。
- 如果不验证本仓 fork 的扩展代码，可以直接使用正常安装的 Automa 扩展。
- 在 Automa 中通过 `Workflows -> Import workflow from file` 导入。
- 根据 `doctor` 输出配置 JSON 实际引用的 `Storage -> Credentials` 或 `Storage -> Variables`；
  不得把用户已验证的 Variables 认证链静默换成 Credentials。
- `doctor` 如果报告动态 Storage Variables 引用，新生成的生产 JSON 必须改成字面量名读取后再交付。
- 使用 `upload-file` 时，为扩展开启文件网址访问权限，并确保文件路径是绝对路径。
- 如果素材来自 AI 表格附件字段，先确认附件 cell 的读回结构。附件 URL 不等于本地文件路径，
  也不保证能在目标网站页面里直接 `fetch`。
- AI 表附件优先在 website JavaScript 使用 `automaFetch('base64', { url })`，再转成
  Blob/File/DataTransfer；不在 background/popup JS 这样调用。`upload-file` 仍需文件网址权限。

## 跨电脑与浏览器 Profile 交付

- `.automa.json` 只携带工作流和依赖名称，不会迁移另一台电脑、另一浏览器或另一 Profile 的 Automa Storage 值。源电脑已运行成功，只证明源环境成立。
- 交付前用 `doctor` 导出 names-only 依赖清单；接收方在目标 Profile 中逐项配置同名 Credentials/Variables，名称和值都做非空校验。不要把真实值塞进共享 JSON。
- 目标端先运行不含发布和写回的只读预检：`Storage 非空 → accessToken → 已确认 userId 的用户详情 → unionId → 目标 AI 表只读请求`。任一步失败即停止，不进入浏览器发布。
- 用户详情请求返回 `50002` 时，先核对该 userId 是否在当前应用可见/授权范围。扩大应用范围或改用另一身份都要由业务方明确确认；不能随便换成一个“能查到”的用户。
- 可取得 unionId 仍不代表可读目标 Base/Table；两层权限必须分别验证。目标环境完成只读预检后，才从 `imported` 晋级；真实发布和外部回读成功后才算该目标环境端到端成功。
- 若排障临时生成了内嵌真实配置的本地文件，不得把它当成交付包、fixture 或版本库文件。使用后删除，并轮换通过文件、日志或截图暴露的凭据。
- Automa 日志的 `referenceData.variables` 可能包含 Storage、运行时 token 或签名附件 URL。只共享脱敏后的首个失败节点、stage、status、code 和 message，不粘贴完整变量快照。

验证本仓 fork 扩展或录制 UI：

- 在仓库根目录工作。
- 根目录依赖缺失时先安装。
- `npm run build` 会把可加载的 Chrome 扩展写到 `build/`。
- `npm run dev` 也会写出 `build/`，并用于开发期重建。
- 在 Chrome/Edge 扩展页面打开开发者模式，从仓库 `build/` 目录加载 unpacked extension。
- `npm run build:zip` 会把当前 `build/` 打成 `build-zip/<version>/automa-<browser>-v<version>.zip`。

## 验证清单

先标记证据级别：`generated` 只表示静态校验，`imported` 表示导入，
`offline-replay` 表示离线业务分支测试，`browser-run` 表示真实页面执行，
`side-effect-readback` 才表示发布/写入成功且已从目标系统回读。详细门禁见
[production-hardening.md](production-hardening.md)。

按场景运行：

```bash
# 在 vendor/automa-flow 或 packages/automa-flow 下
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsc -p tsconfig.test.json --noEmit
node_modules/.bin/vitest run
node bin/automa-flow.mjs validate <output.automa.json> --production
node bin/automa-flow.mjs doctor <output.automa.json>
node bin/automa-flow.mjs check-nl-case test/nl-cases/<case>.md <output.automa.json>
```

如果 `pnpm` 被宿主的 Corepack 项目探测卡住，使用上面的包内本地二进制。

浏览器验证还要记录：

- 生成 JSON 的绝对路径
- 扩展来源：正常安装的 Automa，或本仓 `build/`
- 导入是否成功
- `doctor` 输出的 Credentials、Storage Variables 和文件网址权限是否逐项配置
- notable `operatorId` 是否为 unionId，而不是数字 userId
- 手动触发或 `settings.publicId` CustomEvent 触发是否成功
- 如果首个失败信息是 `Failed to fetch`，且失败节点是上传附件或页面 JS，优先检查附件
  URL 的鉴权、有效期和 CORS；不要先盲目重录 selector。
- 未完成时的首个失败 block、selector 和页面证据

## 用户运行前提示

交付给无开发经验用户时，回复里必须包含这段信息的等价表述：

```text
导入 workflow 后，先按 doctor 结果打开 Automa Storage，逐项确认 JSON 引用的
Credentials 或 Variables。名称必须完全一致，Variables 中的 $$ 前缀不能省略。
Storage 值不会随 .automa.json 迁移；换电脑、浏览器或 Profile 后必须重新配置并做只读预检。
如果 HTTP request 返回 400 且 message 是 paramError-operatorId，通常是
operatorId 为空、误传了 userId，或不是当前钉钉应用可用的 unionId。
```

不要使用 `notification` block 作为成功/失败提示；当前环境可能不支持
`notifications.create`。失败信息应进入 Automa Logs 或变量，再让用户截图首个失败 block。

## CustomEvent 触发

设置 `settings.publicId` 后，页面可以这样触发工作流：

```js
dispatchEvent(new CustomEvent('automa:execute-workflow', {
  detail: { publicId: '<publicId>', data: { variables: {} } }
}));
```

URL query 触发也可用，但依赖导入后的 workflow id。AI 表格按钮或本地页面桥接场景优先使用 `publicId`。
