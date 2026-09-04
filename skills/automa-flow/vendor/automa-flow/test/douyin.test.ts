/**
 * douyin-publish 模板测试：结构、客户已验证选择器、纠偏链顺序、lint 干净。
 */
import { describe, expect, it } from 'vitest';
import { lintWorkflow } from '../src/lint/lint.js';
import { buildDouyinPublish } from '../src/templates/douyin-publish.js';
import type { AutomaWorkflowJson } from '../src/types.js';

const baseOpts = {
  baseId: 'BASE123',
  sheetId: 'SHEET456',
  operatorId: 'OPERATOR789',
};

/** 按 label 取节点序列（按边排序太脆，直接按 description 找） */
const byDesc = (json: AutomaWorkflowJson, desc: string) =>
  json.drawflow.nodes.find((n) => (n.data as { description?: string }).description === desc);

describe('douyin-publish 模板', () => {
  it('默认（含 POI 链）：18 节点 17 边', () => {
    const json = buildDouyinPublish(baseOpts);
    const labels = json.drawflow.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(
      [
        'trigger',
        'webhook',
        'webhook',
        'webhook',
        'javascript-code',
        'conditions',
        'new-tab',
        'wait-connections',
        'upload-file',
        'event-click',
        'event-click',
        'event-click',
        'event-click',
        'event-click',
        'event-click',
        'event-click',
        'forms',
        'forms',
      ].sort()
    );
    expect(json.drawflow.edges).toHaveLength(17);
  });

  it('模板配置关闭 POI：14 节点 13 边，无 POI 选择器', () => {
    const json = buildDouyinPublish({ ...baseOpts, poi: false });
    expect(json.drawflow.nodes).toHaveLength(14);
    expect(json.drawflow.edges).toHaveLength(13);
    expect(JSON.stringify(json)).not.toContain('.semi-select-option-focused');
  });

  it('客户 automa-selectors.md 已验证选择器全部落位', () => {
    const json = buildDouyinPublish(baseOpts);
    const s = JSON.stringify(json);
    for (const sel of [
      'div.tab-item-BcCLTS:nth-child(2)',
      '.semi-tabs-pane-active input',
      'input.semi-input',
      'span.action-Q1y01k',
      '.card-container-tmocjc:nth-child(1) .semi-button-content',
      '.select-Ht3mEC .semi-select-selection-text',
      'div.item-text-normal-MC1UEg',
      '.semi-select-input > .semi-input',
      '.semi-select-option-focused .detail-v2-uZaTIm',
    ]) {
      expect(s, `缺少选择器 ${sel}`).toContain(sel);
    }
  });

  it('纠偏链顺序：音乐 → 位置入口 → 国内 → 填位置 → 候选 → 发布', () => {
    const json = buildDouyinPublish(baseOpts);
    const order = [
      '用第一首推荐音乐',
      '重设位置入口',
      '切国内 tab',
      '填门店位置',
      '点 POI 候选项',
      '点发布',
    ].map((d) => {
      const node = byDesc(json, d);
      expect(node, `缺少节点 ${d}`).toBeDefined();
      return json.drawflow.nodes.indexOf(node!);
    });
    // 用边做拓扑序校验：description 序列必须是链上连续路径
    const descs = ['用第一首推荐音乐', '重设位置入口', '切国内 tab', '填门店位置', '点 POI 候选项', '点发布'];
    for (let i = 0; i < descs.length - 1; i++) {
      const from = byDesc(json, descs[i]!)!;
      const to = byDesc(json, descs[i + 1]!);
      const edge = json.drawflow.edges.find((e) => e.source === from.id);
      expect(edge?.target, `${descs[i]} 应直连 ${descs[i + 1]}`).toBe(to?.id);
    }
    expect(order).toHaveLength(6);
  });

  it('pick 代码含平台过滤且变量字面量声明（G07 可枚举）', () => {
    const json = buildDouyinPublish(baseOpts);
    const pick = json.drawflow.nodes.find((n) => n.label === 'javascript-code')!;
    const code = (pick.data as { code: string }).code;
    expect(code).toContain('"平台"');
    expect(code).toContain('"抖音"');
    expect(code).toContain("automaSetVariable(\"title\"");
    expect(code).toContain("automaSetVariable(\"mediaPath\"");
    expect(code).toContain("automaSetVariable(\"poi\"");

    const noPlatform = buildDouyinPublish({ ...baseOpts, platformField: '' });
    const code2 = (noPlatform.drawflow.nodes.find((n) => n.label === 'javascript-code')!.data as { code: string }).code;
    expect(code2).not.toContain('"平台"');
  });

  it('生成物通过 lint（零 error）', () => {
    for (const poi of [true, false]) {
      const json = buildDouyinPublish({ ...baseOpts, poi });
      const errors = lintWorkflow(json).filter((i) => i.severity === 'error');
      expect(errors, `poi=${poi}`).toEqual([]);
    }
  });

  it('变更类模板默认禁止整流程重试，钉钉 HTTP 至少 30 秒', () => {
    const json = buildDouyinPublish(baseOpts);
    expect(json.settings.restartTimes).toBe(0);
    const requests = json.drawflow.nodes.filter((n) => n.label === 'webhook');
    expect(requests.every((n) => Number(n.data.timeout) >= 30000)).toBe(true);
    expect(lintWorkflow(json).filter((i) => i.rule === 'G17')).toEqual([]);
  });

  it('默认 appKey/appSecret 都走 Automa Credentials', () => {
    const json = buildDouyinPublish(baseOpts);
    const tokenReq = json.drawflow.nodes.find(
      (n) => n.label === 'webhook' && n.data.description === 'Get AccessToken'
    )!;
    expect(tokenReq.data.body).toContain('{{secrets@dingtalkAppKey}}');
    expect(tokenReq.data.body).toContain('{{secrets@dingtalkAppSecret}}');
  });

  it('默认 operatorId 走 Automa Credentials', () => {
    const json = buildDouyinPublish({ baseId: 'BASE123', sheetId: 'SHEET456' });
    expect(JSON.stringify(json)).toContain('operatorId={{secrets@dingtalkOperatorId}}');
  });

  it('抖音字段映射和页面变量可以脱钩于默认字段名', () => {
    const json = buildDouyinPublish({
      ...baseOpts,
      fieldMap: {
        抖音标题: 'dyTitle',
        本地素材: 'dyImage',
        门店名: 'shopName',
      },
      titleVar: 'dyTitle',
      mediaVar: 'dyImage',
      poiVar: 'shopName',
    });
    const s = JSON.stringify(json);
    expect(s).toContain('row.fields[\\"抖音标题\\"]');
    expect(s).toContain('row.fields[\\"本地素材\\"]');
    expect(s).toContain('row.fields[\\"门店名\\"]');
    expect(s).toContain('{{variables@dyImage}}');
    expect(s).toContain('{{variables@dyTitle}}');
    expect(s).toContain('{{variables@shopName}}');
  });

  it('关闭平台过滤时不要求平台字段名', () => {
    const json = buildDouyinPublish({ ...baseOpts, platformField: '' });
    expect(JSON.stringify(json)).not.toContain('"平台"');
  });

  it('必填参数缺失时报错', () => {
    expect(() => buildDouyinPublish({ ...baseOpts, baseId: '' })).toThrow(/baseId/);
  });
});
