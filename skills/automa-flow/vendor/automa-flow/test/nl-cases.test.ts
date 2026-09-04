/**
 * NL 验收用例测试：每条自然语言用例 ↔ 当前生成器的机械对齐。
 *
 * 用例正文是自然语言（给人/agent 读），frontmatter 是验收断言（给机器跑）。
 * agent 用 NL 现搭流程时，同样用 `automa-flow check-nl-case` 走这套断言。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNlCase, parseNlCase } from '../src/nl-case.js';
import { buildDouyinPublish } from '../src/templates/douyin-publish.js';
import { buildXhsPublish } from '../src/templates/xhs-publish.js';
import type { AutomaWorkflowJson } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, 'nl-cases');

const baseOpts = {
  baseId: 'BASE123',
  sheetId: 'SHEET456',
  operatorId: 'OPERATOR789',
};

/** 用例名 → 当前基线生成器（NL 的「参考实现」） */
const generators: Record<string, () => AutomaWorkflowJson> = {
  'xhs-publish': () => buildXhsPublish(baseOpts),
  'douyin-publish': () => buildDouyinPublish(baseOpts),
};

const caseFiles = readdirSync(casesDir).filter((f) => f.endsWith('.md'));

describe('NL 验收用例', () => {
  it.each(caseFiles)('%s：基线生成器通过断言', (file) => {
    const kase = parseNlCase(readFileSync(join(casesDir, file), 'utf8'));
    const build = generators[kase.name];
    expect(build, `用例 ${kase.name} 无对应基线生成器`).toBeDefined();
    expect(checkNlCase(kase, build!())).toEqual([]);
    expect(kase.nl.length).toBeGreaterThan(50); // 正文确实是自然语言描述
  });

  it('负样本：douyin 用例断言 xhs 产物必须失败', () => {
    const kase = parseNlCase(readFileSync(join(casesDir, 'douyin-publish.md'), 'utf8'));
    const problems = checkNlCase(kase, buildXhsPublish(baseOpts));
    expect(problems.length).toBeGreaterThan(0);
  });

  it('兼容旧 JSON frontmatter 用例格式', () => {
    const kase = parseNlCase(`---
{"name":"legacy","expect":{"labels":["trigger"],"edges":0,"maxLintErrors":1}}
---
旧格式用例仍可解析。`);
    expect(kase).toEqual({
      name: 'legacy',
      expect: { labels: ['trigger'], edges: 0, maxLintErrors: 1 },
      nl: '旧格式用例仍可解析。',
    });
  });
});
