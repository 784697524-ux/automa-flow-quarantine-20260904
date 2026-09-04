---
name: xhs-publish
expect:
  labels:
    - trigger
    - webhook
    - webhook
    - webhook
    - javascript-code
    - javascript-code
    - conditions
    - new-tab
    - upload-file
    - wait-connections
  edges: 9
  maxLintErrors: 0
  contains:
    - "{{secrets@dingtalkAppKey}}"
    - "{{secrets@dingtalkAppSecret}}"
    - "notable/bases/BASE123/sheets/SHEET456/records/list"
    - "\"状态\""
    - "\"待发布\""
    - "\"已发布\""
    - "\"标题\""
    - "\"正文\""
    - "\"素材路径\""
    - "{{variables@mediaPath}}"
    - ".d-input > .d-text"
    - "div.tiptap"
---
# 小红书图文发布

我想把 AI 表格里准备好的内容自动发到小红书。表里会有一批待处理素材，每行大概包含
处理状态、标题、正文、图片素材路径之类的信息，但字段名和表结构可能会按实际表调整。

请先跟我确认 baseId、tableId、操作者身份、哪一列表示待处理/已完成，以及哪些表字段要
变成 Automa 变量。确认后通过 AI 表格接口读取字段结构，别只按默认字段名猜。

页面侧如果标题、正文、上传或发布按钮的选择器不确定，请让我先用公网 Automa 插件录制
一小段操作并导出 workflow，再从录制产物里抽 selector。最后生成一个可导入 Automa 的
workflow JSON：手动触发后读取第一条待处理记录，把表格字段拆成变量，完成页面填写和
素材上传，成功后回写状态。先不要求批量 loop；如果后续要批量，再单独补循环模板和验收。
