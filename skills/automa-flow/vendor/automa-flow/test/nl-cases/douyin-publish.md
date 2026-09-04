---
name: douyin-publish
expect:
  labels:
    - trigger
    - webhook
    - webhook
    - webhook
    - javascript-code
    - conditions
    - new-tab
    - wait-connections
    - upload-file
    - event-click
    - event-click
    - event-click
    - event-click
    - event-click
    - event-click
    - event-click
    - forms
    - forms
  edges: 17
  maxLintErrors: 0
  contains:
    - "{{secrets@dingtalkAppKey}}"
    - "{{secrets@dingtalkAppSecret}}"
    - "div.tab-item-BcCLTS:nth-child(2)"
    - ".semi-tabs-pane-active input"
    - ".semi-select-option-focused .detail-v2-uZaTIm"
---
# 抖音团购图文发布

生成一个可导入 Automa 的抖音团购图文自动发布工作流。触发后先用 Automa
Credentials 中的 `dingtalkAppKey` 和 `dingtalkAppSecret` 换钉钉 accessToken，
再查询钉钉 AI 表格中平台为「抖音」且状态为「待发布」的第一行，拆出 `recordId`、
标题、素材路径、门店位置等变量。没有匹配行时流程结束。

有匹配行时，打开抖音创作者发布页，等待页面连接稳定，切到图文 tab，上传素材图片，
填写标题，然后执行选音乐动作：点击音乐入口，选择第一首推荐音乐。

由于抖音页面在选音乐后可能切走标签类型，发布前必须执行位置纠偏链：重新点击位置入口，
切到国内 tab，在位置输入框填入门店名，点击第一个候选项。最后点击发布按钮，并把
AI 表格原记录状态回写为「已发布」。

页面选择器必须使用客户已验证或 Automa 录制得到的 semi 前缀选择器事实源；未知元素不得
凭记忆编造，应先通过 Automa 录制补齐，再重新跑 `validate` 与 `check-nl-case`。
