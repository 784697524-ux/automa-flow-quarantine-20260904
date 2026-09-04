/**
 * xhs-publish 模板测试：结构、拓扑、变量默认走 secrets、lint 干净。
 */
import { describe, expect, it } from 'vitest';
import { lintWorkflow } from '../src/lint/lint.js';
import { buildXhsPublish } from '../src/templates/xhs-publish.js';

const baseOpts = {
  baseId: 'BASE123',
  sheetId: 'SHEET456',
  operatorId: 'OPERATOR789',
};

describe('xhs-publish 模板', () => {
  it('拓扑与金标准一致：10 节点 9 边', () => {
    const json = buildXhsPublish(baseOpts);
    const labels = json.drawflow.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(
      [
        'conditions',
        'javascript-code',
        'javascript-code',
        'new-tab',
        'trigger',
        'upload-file',
        'wait-connections',
        'webhook',
        'webhook',
        'webhook',
      ].sort()
    );
    expect(json.drawflow.edges).toHaveLength(9);
  });

  it('默认 appKey/appSecret 都走 secrets 变量，不落明文', () => {
    const json = buildXhsPublish(baseOpts);
    const tokenReq = json.drawflow.nodes.find(
      (n) => n.label === 'webhook' && (n.data.description === 'Get AccessToken')
    )!;
    expect(tokenReq.data.body).toContain('{{secrets@dingtalkAppKey}}');
    expect(tokenReq.data.body).toContain('{{secrets@dingtalkAppSecret}}');
    expect(JSON.stringify(json)).not.toContain('ding-test-app-key');
    expect(JSON.stringify(json)).not.toContain('appSecret":"BN28'); // 无明文样式
  });

  it('默认 operatorId 也走 Credentials 配置，不写死个人 unionId', () => {
    const json = buildXhsPublish({ baseId: 'BASE123', sheetId: 'SHEET456' });
    const s = JSON.stringify(json);
    expect(s).toContain('operatorId={{secrets@dingtalkOperatorId}}');
    expect(s).not.toContain('OPERATOR789');
  });

  it('显式传 appKey 时内联', () => {
    const json = buildXhsPublish({ ...baseOpts, appKey: 'plain-key' });
    expect(JSON.stringify(json)).toContain('plain-key');
  });

  it('显式传 appSecret 时内联', () => {
    const json = buildXhsPublish({ ...baseOpts, appSecret: 'plain-secret' });
    expect(JSON.stringify(json)).toContain('plain-secret');
  });

  it('字段映射和页面变量可以脱钩于默认字段名', () => {
    const json = buildXhsPublish({
      ...baseOpts,
      fieldMap: {
        帖子标题: 'postTitle',
        帖子正文: 'postBody',
        图片路径: 'localImage',
      },
      titleVar: 'postTitle',
      bodyVar: 'postBody',
      mediaVar: 'localImage',
    });
    const s = JSON.stringify(json);
    expect(s).toContain('row.fields[\\"帖子标题\\"]');
    expect(s).toContain('row.fields[\\"帖子正文\\"]');
    expect(s).toContain('row.fields[\\"图片路径\\"]');
    expect(s).toContain('{{variables@localImage}}');
    expect(s).toContain('postTitle');
    expect(s).toContain('postBody');
  });

  it('字段映射未声明页面变量时报错，避免静默生成断链工作流', () => {
    expect(() =>
      buildXhsPublish({
        ...baseOpts,
        fieldMap: { 标题列: 'postTitle', 正文列: 'postBody', 图片列: 'localImage' },
      })
    ).toThrow(/fieldMap 没有声明页面所需变量/);
  });

  it('publicId 预置进 settings', () => {
    const json = buildXhsPublish({ ...baseOpts, publicId: 'xhs-trigger-001' });
    expect(json.settings.publicId).toBe('xhs-trigger-001');
  });

  it('生成物通过 lint（零 error）', () => {
    const json = buildXhsPublish(baseOpts);
    const errors = lintWorkflow(json).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('变更类模板默认禁止整流程重试，钉钉 HTTP 至少 30 秒', () => {
    const json = buildXhsPublish(baseOpts);
    expect(json.settings.restartTimes).toBe(0);
    const requests = json.drawflow.nodes.filter((n) => n.label === 'webhook');
    expect(requests.every((n) => Number(n.data.timeout) >= 30000)).toBe(true);
    expect(lintWorkflow(json).filter((i) => i.rule === 'G17')).toEqual([]);
  });

  it('conditions 端口与条件组 id 对齐，hasRow eq true', () => {
    const json = buildXhsPublish(baseOpts);
    const cond = json.drawflow.nodes.find((n) => n.label === 'conditions')!;
    const group = (cond.data.conditions as { id: string; name: string }[])[0]!;
    expect(group.name).toBe('hasRow');
    const edge = json.drawflow.edges.find((e) => e.source === cond.id)!;
    expect(edge.sourceHandle).toBe(`${cond.id}-output-${group.id}`);
    expect(edge.target).toBe(
      json.drawflow.nodes.find((n) => n.label === 'new-tab')!.id
    );
  });

  it('必填参数缺失时报错', () => {
    expect(() =>
      buildXhsPublish({ ...baseOpts, baseId: '' })
    ).toThrow(/baseId/);
  });
});
