/**
 * lint 测试：
 *   - 金标准样本零 error（只允许 fallback 未连接这类 warning）；
 *   - 每条规则一个负样本，逐条验证拦截。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowBuilder } from '../src/builder/builder.js';
import { lintWorkflow } from '../src/lint/lint.js';
import type { AutomaWorkflowJson } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(join(here, 'fixtures', 'xhs-publish.sample.json'), 'utf8')
) as AutomaWorkflowJson;

const rules = (issues: ReturnType<typeof lintWorkflow>, rule: string) =>
  issues.filter((i) => i.rule === rule);

describe('lint 金标准样本', () => {
  // 历史导出样本保持原样供 roundtrip 测试；生产 lint 先收紧副作重试与超时。
  const hardenedSample = structuredClone(sample);
  hardenedSample.settings.restartTimes = 0;
  for (const node of hardenedSample.drawflow.nodes) {
    if (node.label === 'webhook') node.data.timeout = 30000;
  }
  const issues = lintWorkflow(hardenedSample);

  it('零 error', () => {
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('三个 webhook 的 fallback 未连接 → 3 条 G03 warning', () => {
    expect(rules(issues, 'G03')).toHaveLength(3);
  });
});

describe('lint 负样本', () => {
  it('G01: 缺少 trigger', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const a = b.addBlock('webhook', { data: { url: 'https://x.test' } });
    const c = b.addBlock('new-tab', { data: { url: 'https://x.test' } });
    b.connect(a, c);
    expect(rules(lintWorkflow(b.emit()), 'G01').length).toBeGreaterThan(0);
  });

  it('G01: conditions 边引用不存在的条件组', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const cond = b.addBlock('conditions');
    const next = b.addBlock('new-tab', { data: { url: 'https://x.test' } });
    b.connect(t, cond);
    expect(() => b.connect(cond, next, { port: 'no-such-group' })).toThrow(
      /条件组/
    );
  });

  it('G01: 拦截重复节点 id、边 id 和逻辑连线', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const hook = b.addBlock('webhook', { data: { url: 'https://x.test' } });
    b.connect(t, hook);
    const json = b.emit();
    json.drawflow.nodes.push(structuredClone(json.drawflow.nodes[1]!));
    json.drawflow.edges.push(structuredClone(json.drawflow.edges[0]!));
    json.drawflow.edges.push({ ...structuredClone(json.drawflow.edges[0]!), id: 'other-edge' });

    const messages = rules(lintWorkflow(json), 'G01').map((item) => item.message);
    expect(messages.some((message) => message.includes('节点 id') && message.includes('重复'))).toBe(true);
    expect(messages.some((message) => message.includes('边 id') && message.includes('重复'))).toBe(true);
    expect(messages.some((message) => message.includes('重复逻辑连线'))).toBe(true);
  });

  it('G01: conditions 同一输出端口不得连接多个下游', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const cond = b.addBlock('conditions');
    const first = b.addBlock('new-tab', { data: { url: 'https://first.test' } });
    const second = b.addBlock('new-tab', { data: { url: 'https://second.test' } });
    b.connect(t, cond);
    const conditionId = b.addCondition(cond, { left: '{{variables@value}}', right: 'yes' });
    b.connect(cond, first, { port: conditionId });
    const json = b.emit();
    json.drawflow.edges.push({
      id: 'manual-second-condition-edge',
      source: cond,
      target: second,
      sourceHandle: `${cond}-output-${conditionId}`,
      targetHandle: `${second}-input-1`,
    });

    expect(
      rules(lintWorkflow(json), 'G01').some((item) => item.message.includes('maxConnection=1'))
    ).toBe(true);
  });

  it('G01: 普通节点同一输出端口也遵守 maxConnection', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const trigger = b.addBlock('trigger');
    const first = b.addBlock('new-tab', { data: { url: 'https://first.test' } });
    const second = b.addBlock('new-tab', { data: { url: 'https://second.test' } });
    b.connect(trigger, first);
    const json = b.emit();
    json.drawflow.edges.push({
      id: 'manual-second-trigger-edge',
      source: trigger,
      target: second,
      sourceHandle: `${trigger}-output-1`,
      targetHandle: `${second}-input-1`,
    });

    expect(
      rules(lintWorkflow(json), 'G01').some((item) => item.message.includes('maxConnection=1'))
    ).toBe(true);
  });

  it('G02: loop-data 缺 loop-breakpoint', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const loop = b.addBlock('loop-data', {
      data: { loopId: 'loop-1', loopThrough: 'variable', variableName: 'rows' },
    });
    b.connect(t, loop);
    const issues = lintWorkflow(b.emit());
    expect(rules(issues, 'G02').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G02: loop-breakpoint 存在但不在下游', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const loop = b.addBlock('loop-data', {
      data: { loopId: 'loop-1', loopThrough: 'variable', variableName: 'rows' },
    });
    const bp = b.addBlock('loop-breakpoint', { data: { loopId: 'loop-1' } });
    b.connect(t, loop);
    // breakpoint 孤立：与循环体无连接
    void bp;
    const issues = lintWorkflow(b.emit());
    expect(rules(issues, 'G02').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G05: new-tab 上游的 JS 块不是 background 上下文', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: { context: 'website', code: 'automaNextBlock();' },
    });
    const tab = b.addBlock('new-tab', { data: { url: 'https://x.test' } });
    b.chain([t, js, tab]);
    expect(rules(lintWorkflow(b.emit()), 'G05')).toHaveLength(1);
  });

  it('G06: upload-file 路径含 ~', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const up = b.addBlock('upload-file', {
      data: { selector: 'input[type="file"]', filePaths: ['~/a.jpg'] },
    });
    b.connect(t, up);
    expect(rules(lintWorkflow(b.emit()), 'G06')).toHaveLength(1);
  });

  it('G07: 引用的变量无声明点（manual 触发 → error）', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const hook = b.addBlock('webhook', {
      data: {
        url: 'https://x.test/{{variables@notDeclared}}',
        headers: [],
      },
    });
    b.connect(t, hook);
    expect(
      rules(lintWorkflow(b.emit()), 'G07').some((i) => i.severity === 'error')
    ).toBe(true);
  });

  it('G07: JS 里 automaSetVariable 声明的变量不算未声明', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: "automaSetVariable('foo', 1);\nautomaNextBlock();",
      },
    });
    const hook = b.addBlock('webhook', {
      data: { url: 'https://x.test/{{variables@foo}}' },
    });
    b.chain([t, js, hook]);
    expect(rules(lintWorkflow(b.emit()), 'G07')).toHaveLength(0);
  });

  it('G07: 变量不得在上游节点读取、到下游才声明', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const trigger = b.addBlock('trigger');
    const read = b.addBlock('webhook', {
      data: { url: 'https://x.test/{{variables@lateValue}}' },
    });
    const declare = b.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: "automaSetVariable('lateValue', 'now'); automaNextBlock();",
      },
    });
    b.chain([trigger, read, declare]);

    expect(
      rules(lintWorkflow(b.emit()), 'G07').some(
        (item) => item.severity === 'error' && item.message.includes('上游声明之前')
      )
    ).toBe(true);
  });

  it('G07: JS 里 automaRefData 字面量读取也校验声明点', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: "const value = automaRefData('variables', 'missing_runtime');\nautomaNextBlock(value);",
      },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G07').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G07: $$ Storage Variables 不要求工作流内部声明', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: "const value = automaRefData('variables', '$$dd_app_id');\nautomaNextBlock(value);",
      },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G07')).toHaveLength(0);
  });

  it('G09: notification block 在交付工作流中报错', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const notice = b.addBlock('notification', {
      data: { title: '完成', message: '流程已结束' },
    });
    b.connect(t, notice);
    const issues = lintWorkflow(b.emit());
    expect(rules(issues, 'G09').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G10: settings.notification=true 给运行环境提醒', () => {
    const b = new WorkflowBuilder({ name: 't', settings: { notification: true } });
    b.addBlock('trigger');
    const issues = lintWorkflow(b.emit());
    expect(rules(issues, 'G10').some((i) => i.severity === 'warning')).toBe(true);
  });

  it('G11: 页面 JS 直接 fetch 附件 URL 给出风险提醒', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'website',
        code: "const res = await fetch(attachment.url, { credentials: 'include' });\nautomaNextBlock();",
      },
    });
    b.connect(t, js);
    const issues = lintWorkflow(b.emit());
    expect(rules(issues, 'G11').some((i) => i.severity === 'warning')).toBe(true);
  });

  it("G11: 使用 automaFetch('base64') 下载附件时不误报", () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'website',
        code: "const dataUrl = await automaFetch('base64', { url: attachment.url });\nconst blob = await (await fetch(dataUrl)).blob();\nautomaNextBlock();",
      },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G11')).toHaveLength(0);
  });

  it("G12: background 上下文使用 automaFetch('base64') 报错", () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: "const data = await automaFetch('base64', { url: 'https://x.test/a.jpg' });\nautomaNextBlock(data);",
      },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G12').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G13: userId 变量不得直接用作 notable operatorId', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const hook = b.addBlock('webhook', {
      data: {
        url: 'https://api.dingtalk.com/v1.0/notable/bases/B/sheets/S/records/list?operatorId={{variables@dd_user_id_runtime}}',
        method: 'POST',
        timeout: 30000,
      },
    });
    b.connect(t, hook);
    expect(rules(lintWorkflow(b.emit()), 'G13').some((i) => i.severity === 'error')).toBe(true);
  });

  it.each([
    'operatorId=11231702',
    'operatorId={{secrets@dd_user_id}}',
  ])('G13: 数字或 secrets userId 也不得用作 notable operatorId（%s）', (query) => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const hook = b.addBlock('webhook', {
      data: {
        url: `https://api.dingtalk.com/v1.0/notable/bases/B/sheets/S/records/list?${query}`,
        method: 'POST',
        timeout: 30000,
      },
    });
    b.connect(t, hook);
    expect(rules(lintWorkflow(b.emit()), 'G13').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G14: website JavaScript 不得执行钉钉写请求', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'website',
        code: `await automaFetch('json', {
          url: 'https://api.dingtalk.com/v1.0/notable/bases/B/sheets/S/records',
          method: 'POST', body: '{}'
        });
        automaNextBlock();`,
      },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G14').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G14: endpoint 和 method 放在常量中也能识别钉钉写请求', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'website',
        code: `const endpoint = 'https://api.dingtalk.com/v1.0/notable/bases/B/sheets/S/records';
const requestMethod = 'POST';
await automaFetch('json', { url: endpoint, method: requestMethod, body: '{}' });
automaNextBlock();`,
      },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G14').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G15: JavaScript 语法错误在生成期拦截', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: { context: 'background', code: 'const value = ;\nautomaNextBlock();' },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G15').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G15: pagesScanned/scannedPages 这类局部变量换序拼错在生成期拦截', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'website',
        code: 'let pagesScanned = 1;\nconst summary = { scannedPages };\nautomaNextBlock(summary);',
      },
    });
    b.connect(t, js);
    const issues = rules(lintWorkflow(b.emit()), 'G15');
    expect(issues.some((i) => i.message.includes('scannedPages') && i.message.includes('pagesScanned'))).toBe(true);
  });

  it('G15: queryCount/queryCont 这类单字符拼写漂移在生成期拦截', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: 'const queryCount = 3; automaNextBlock(queryCont);',
      },
    });
    b.connect(t, js);
    const issues = rules(lintWorkflow(b.emit()), 'G15');
    expect(issues.some((i) => i.message.includes('queryCont') && i.message.includes('queryCount'))).toBe(true);
  });

  it('G15: Error/error 等仅大小写差异不误报', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: "const error = 'x'; const array = Array.from([]); const number = Number('1'); throw new Error(error + array.length + number);",
      },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G15')).toEqual([]);
  });

  it('G16: 含变更 HTTP 时禁止整流程自动重试', () => {
    const b = new WorkflowBuilder({ name: 't', settings: { restartTimes: 2 } });
    const t = b.addBlock('trigger');
    const hook = b.addBlock('webhook', {
      data: { url: 'https://x.test/records', method: 'POST' },
    });
    b.connect(t, hook);
    expect(rules(lintWorkflow(b.emit()), 'G16').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G17: 钉钉 HTTP 低于 30 秒直接拦截', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const hook = b.addBlock('webhook', {
      data: { url: 'https://api.dingtalk.com/v1.0/notable/bases/B/sheets/S/records/list', method: 'POST', timeout: 10000 },
    });
    b.connect(t, hook);
    expect(rules(lintWorkflow(b.emit()), 'G17').some((i) => i.severity === 'error')).toBe(true);
  });

  it('G18: 动态变量名读取给出运行依赖告警', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const js = b.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: "const name = 'dd_app_id'; const value = automaRefData('variables', '$$' + name); automaNextBlock(value);",
      },
    });
    b.connect(t, js);
    expect(rules(lintWorkflow(b.emit()), 'G18')).toHaveLength(1);
  });

  it('B:webhook URL 为空', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const hook = b.addBlock('webhook', { data: { url: '' } });
    b.connect(t, hook);
    expect(rules(lintWorkflow(b.emit()), 'B:webhook')).toHaveLength(1);
  });

  it('G04: conditions 左值是字面量 → warning', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const cond = b.addBlock('conditions');
    const next = b.addBlock('new-tab', { data: { url: 'https://x.test' } });
    b.connect(t, cond);
    const condId = b.addCondition(cond, { left: 'plain-literal', right: 'x' });
    b.connect(cond, next, { port: condId });
    const issues = lintWorkflow(b.emit());
    expect(rules(issues, 'G04').some((i) => i.severity === 'warning')).toBe(true);
  });

  it('T01: 未闭合的 mustache', () => {
    const b = new WorkflowBuilder({ name: 't' });
    const t = b.addBlock('trigger');
    const hook = b.addBlock('webhook', {
      data: { url: 'https://x.test/{{variables@foo' },
    });
    b.connect(t, hook);
    expect(rules(lintWorkflow(b.emit()), 'T01')).toHaveLength(1);
  });
});
