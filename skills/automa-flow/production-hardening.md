# 生产工作流生成与验收门禁

当工作流包含登录态、认证、分页、附件、发布、查询联系方式或外部系统回写时，在生成 JSON 前读本文。

## 先冻结运行契约

不先写节点。先记录并用实际样本确认：

1. Automa 版本、执行上下文和触发方式。
2. 认证来源：生产交付只选 `credentials` 或 `storage-variables` 一条主链；用户明确要求的内联值仅限不共享的临时排障文件。
3. 用户身份转换链。钉钉 notable `operatorId` 是 unionId；数字 userId 不能直接使用。
4. 真实 Base/Sheet/字段类型与读回样本，包括单选、多选和附件的实际形状。
5. 队列唯一开关、数量字段、配额、去重键、结束条件与成功判定。
6. selector 证据来源：当前 DOM、Automa 录制、成功 JSON 或可核对的 RPA 元素文件。

契约未确认的字段不得靠名称相似自动推断。对用户的真实正例和反例各至少一条，再写筛选代码。

## 跨环境交付门禁

- Automa Storage 按电脑、浏览器和 Profile 隔离；`.automa.json` 不迁移其中的值。每个目标环境都重新运行 `doctor`、配置 names-only 清单并校验非空。
- 不把 appSecret、token 或其他敏感值写入共享 JSON 的 `globalData`。`validate --production` 出现 G19 时停止交付；`doctor` 只允许显示字段名，不能显示值。
- 目标端先使用无发布、无写回的安全副本验证：Storage 非空、token、业务方确认的 userId 用户详情、unionId、目标表只读访问。未通过前不触发任何副作用。
- 用户详情阶段的 `50002` 进入应用可见/授权范围诊断；不能用任意可查询 userId 绕过。取得 unionId 后还要单独确认目标 Base/Table 权限。
- 源环境的 `browser-run` 或 `side-effect-readback` 不可迁移。证据级别必须绑定具体电脑、浏览器 Profile、Automa 版本和身份配置重新计算。
- 临时内嵌配置的排障文件不进入交付包、fixture 或版本库；使用后删除，已通过文件、日志或截图暴露的凭据必须轮换。
- 日志里的 `referenceData.variables` 可能序列化 Storage、token 和签名附件 URL；排障只保留脱敏后的首错 stage/status/code/message，不把完整变量快照作为可分享证据。

## 成功产物优先

已有真实运行成功的 `.automa.json` 时，它是 golden artifact：

- 先用 `import` 和普通 `validate` 分析历史成功 JSON，再在其上做最小语义差异；新交付物必须通过 `validate --production`，不从空白模板重建。
- 冻结已成功前缀：节点类型、关键 data、上下文、连线和顺序。后续只改用户要求的差异。
- 回归比较忽略随机 node/edge id 和画布坐标，但不忽略运行上下文、HTTP 方法、dataPath、超时、分页、业务判定和副作用顺序。
- 成功样本可以被脱敏后转成回归用例；不得把 appSecret、token、个人身份或客户数据放进 skill fixture。

内置 `xhs-publish` 和 `douyin-publish` 只是结构脚手架。未经上述契约和真实浏览器验证，不得直接称为生产版。

## 两类已验证成功指纹

达人查询与联系方式回写：

- 保留用户现有 Storage Variables 认证链，先用 userId 查用户详情，再以 unionId 作为 notable `operatorId`。
- 历史结果、主档、联系方式日志和游标全页读取，分页 token 必须前进。
- 配置中的查询次数同时约束查联系方式次数、结果数和配额数；不用页面每页数代替。
- 历史、本轮跨页、提交前三层去重，并用 runId 防同轮重入。
- 原生 HTTP 串行回写，所有写入成功后才 finalize。

浏览器发布与 AI 表回写：

- 冻结已验收的前置节点，只追加一次发布点击、强成功判定和回写，不重建整条链。
- AI 表附件在 website JavaScript 中转 File 并注入 file input；上传后回读真实 input/媒体状态。
- 页面字段和 POI 选择器来自当前 DOM/录制证据，不做文本相似度猜测。
- 发布后只接受预期站点的作品管理页或同等强状态；再用原生 HTTP PUT 回写并 GET 读回。

这些是可复用的运行契约，不是对任何新站点、新表结构或新 Automa 版本的自动保证。

## 运行上下文分工

| 能力 | 节点/上下文 | 硬规则 |
|---|---|---|
| 数据整理、变量交接 | background JavaScript | 不操作 DOM，不使用 `automaFetch('base64')` |
| 页面筛选、输入、附件注入和状态读回 | website JavaScript | 允许 DOM；不在这里向钉钉发 POST/PUT/PATCH/DELETE |
| AI 表读写 | 原生 HTTP Request | 每次请求只执行一次，独立记录状态码和响应，超时至少 30 秒 |
| 本地绝对路径上传 | `upload-file` | 必须开启扩展的文件网址访问权限 |
| AI 表附件上传 | website JavaScript | `automaFetch('base64') -> Blob -> File -> DataTransfer -> input.files -> input/change` |

附件注入完成后，必须回读 `input.files`、文件大小、媒体 `readyState/error`或页面明确状态；JavaScript 节点绿色不等于上传成功。

## AI 表分页与身份

当前已成功样本使用这个配方：

1. 原生 HTTP `POST .../records/list?operatorId=<unionId>`，body 携带 `maxResults` 和可选 `nextToken`。
2. 数据响应通过已验证的 `dataPath` 交给 background JavaScript 解析。
3. 只有 `hasMore=true` 且 `nextToken` 非空、与上次不同时才继续。
4. 受 `maxPages`、`scanLimit`和单请求超时保护。
5. 测试重复 token、缺 token、空页、超过 500 条、末页无候选和单请求失败。

接口方法和响应形状仍需以当前 OpenAPI 或已成功样本确认，不能把历史某一次 GET/POST 写法当成永久不变的规则。

认证依赖必须能被 `doctor` 穷举：用字面量名读取 Credentials/Storage Variables。
动态拼接变量名会产生 G18；普通审计为 warning，`validate --production` 中为 error。生产模式也会拦截同时依赖 Credentials 与 Storage Variables 的混用认证链。

## 业务数量、去重与幂等

- 队列入选只使用用户明确的唯一开关。单选/多选先归一化选项名，再严格等于比较；拒绝空白、“否”、缺失和混合值。
- 查询目标数必须来至实际配置且是正整数；不得再用 `|| 1` 静默覆盖非法配置。
- 实际上限是查询数、可用配额和安全保留量的契约结果；同一个值同时约束采集与回写。
- 副作用前至少有：历史去重、本轮跨页去重、回写前再去重。
- 每轮生成 runId，写回前设置 started marker；同一 runId 二次进入必须零写入。
- 含发布或写入的工作流使用 `restartTimes=0`、`reuseLastState=false`、`onError=stop-workflow`。结果不明时先人工回读，不自动再做一次。

## 生成后回归矩阵

通用静态检查外，为当次场景写离线回放测试：

- 节点 id、边 id、逻辑连线唯一，每个输出端口遵守 `maxConnection`；变量声明在读取节点上游。
- 认证值空、认证来源混用、userId/unionId 传错。
- 目标端 Storage 缺失、用户详情返回 50002、可取得 unionId 但无目标 Base/Table 权限。
- 分页正常前进、重复 token、缺 token、超上限、末页。
- 开关是/否/空白/缺失/多选混合值。
- 数量 1、3、5、非法数量、配额不足。
- 历史重复、本页重复、跨页重复、同 runId 重进。
- 任一 HTTP 失败时不 finalize；发布未得到强状态时不回写。
- 嵌入的每个 JavaScript 都做语法检查和关键数据交接回放，专门覆盖变量名拼写漂移。

离线回放不访问真实 API，使用固定 fixture 和可观测的写入计数。

## 验收证据分级

| 级别 | 证据 | 允许的结论 |
|---|---|---|
| 1 generated | JSON 生成、lint/doctor/NL case 通过 | “已生成，静态校验通过” |
| 2 imported | 指定 Automa 版本导入成功 | “已导入” |
| 3 offline-replay | 场景 fixture 覆盖业务分支 | “离线业务回放通过” |
| 4 browser-run | 真实页面的运行日志和动作后状态 | “浏览器阶段运行成功” |
| 5 side-effect-readback | 目标站强状态/API 成功，且外部表回读值与预期一致 | “端到端成功” |

回复必须标出实际达到的最高级别。不得用“可导入”、“节点是绿色”或“离线测试全过”代替端到端成功。
证据级别只对记录中的具体电脑、浏览器 Profile、Automa 版本和身份配置有效。

## 失败诊断

每个阶段写明确 stage 变量。一次运行失败只先定位第一个红色节点的 node id、description、status 和 response。不因“附件没出现”就跳过更早的认证/分页错误。修复后从前一层已验证证据继续，不重写无关节点。
