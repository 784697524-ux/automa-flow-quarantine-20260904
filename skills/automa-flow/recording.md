# 录制辅助选择器流程

当用户希望用 Automa 自带录制能力辅助定位页面元素，或页面 selector 事实不确定时，使用本参考。

## 录制能提供什么

Automa 录制会把真实 DOM 和浏览器事件转换成与生成工作流同构的 drawflow JSON：

- 点击转换成带 `selector` 和等待参数的 `event-click` block
- 文本输入转换成 `forms` block
- 文件选择转换成 `upload-file` block
- 滚动转换成 `element-scroll` block
- 新开标签页和切换标签页转换成浏览器导航类 block
- iframe 内操作使用 `frameSelector ||> childSelector` 形态的 selector 前缀

这不是屏幕录像，而是“DOM 事件到 block 序列”的编译结果。

## 推荐用法

1. 让用户尽量只录制不确定的页面操作片段。
2. 在 Automa 中开始录制，切到目标 tab 后先刷新一次页面，再执行真实操作，停止录制，
   删除误触动作，然后导出录制工作流 JSON。商店版扩展在部分站点首次注入可能不完整，
   刷新后通常更稳定；同时只保留一个 Automa 扩展实例，避免双扩展同时录制。
3. 用 CLI 读取录制产物并抽取选择器清单：

```bash
node bin/automa-flow.mjs import <recorded.automa.json>
node bin/automa-flow.mjs import <recorded.automa.json> --json
```

4. 从 `event-click`、`forms`、`upload-file`、`element-scroll`、`link`、`trigger-event` 等 block 中提取 selector 和关键参数。
5. selector 优先级：`data-testid` 或语义属性、稳定 id、block 支持时的稳定角色/文本定位、录制得到的最短唯一 CSS/XPath。
6. 把已验证 selector 回填到模板、参数或 `WorkflowBuilder` 代码，然后重新 `validate`。

## import 三层诊断

`automa-flow import` 默认只分析，不修改原始录制文件。除 selector 清单和 lint 外，它还会输出：

- 录制噪音：空 selector 的 `element-scroll`、空 selector 的 `trigger-event`、连续空 selector 的
  `press-key` 组。它们常来自页面滚动、误触或中文输入法逐键录制。
- 录制缺陷：典型是点击正文编辑器后出现一串空 selector 的 `press-key`。这类 IME 录制回放
  容易拼不出中文，建议改成变量化 `forms`，或用网站 JS 一次性设置 input/contenteditable
  的值并派发 `input/change` 事件。
- 硬编码值：`forms.data.value` 写死了录制时的文本，或 `upload-file.data.filePaths`
  写死了本机路径。交付给 AI 表格驱动的 workflow 前，通常要参数化为 `{{variables@...}}`。

显式转换示例：

```bash
node bin/automa-flow.mjs import <recorded.automa.json> \
  --drop-noise \
  --parametrize '{"forms":{"<formsNodeId>":"postTitle"},"upload":{"<uploadNodeId>":"mediaPath"}}' \
  -o <recorded.cleaned.automa.json>
```

`--parametrize` 使用 nodeId 映射。不要用 selector 作为映射 key，因为同一 selector 可能被多个
block 复用，也可能在录制重排后语义不同。

## 自动合并

当已有骨架工作流和录制片段时，可以把录制片段插入指定骨架节点之后：

```bash
node bin/automa-flow.mjs merge <skeleton.automa.json> <recorded.automa.json> \
  --after <blockId> -o <merged.automa.json>
node bin/automa-flow.mjs validate <merged.automa.json>
```

合并规则：

- 录制片段最多只能有一个 `trigger`；有一个时会丢弃该 trigger，并把它的下游作为片段入口。
- 片段必须是单入口、单尾节点的线性段。
- 片段节点会重写 id，避免和骨架冲突。
- 如果 `--after` 原本有一个主输出下游，合并会把片段插入 `after -> 片段 -> 原下游` 之间。
- 可用 `--drop-noise` 在合并前删除可识别噪音并重连边。
- 可用 `--parametrize <jsonOrFile>` 在合并前把录制文本/文件路径替换成变量引用。
- 合并后以骨架的 `settings.publicId` 为准。
- 合并后的文件必须 lint 零 error 才能交付。

## 局限

- 录制是线性的，不会推导 conditions、loop、fallback 路径或 AI 表格调用。
- 中文输入法和 contenteditable 正文编辑器容易录成 `press-key` 序列；不要把它当作可靠正文输入方案。
- 带 hash 的动态 class 录制后仍可能失效，要标为高维护风险。
- 录制只能证明当时页面存在这些元素，不能证明完整工作流端到端可用。
- 站点改版或浏览器执行失败在元素 block 时，应重新录制相关片段。
