/**
 * P0 验收：块注册表产物质量。
 *   - 块数与源码水印；
 *   - demo 用到的 8 个块全部存在；
 *   - 关键块的默认 data 与金标准样本逐字段一致（以样本为基准）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getBlock, getRegistry } from '../src/registry.js';
import type { AutomaWorkflowJson } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(join(here, 'fixtures', 'xhs-publish.sample.json'), 'utf8')
) as AutomaWorkflowJson;

/** demo 用到的块 */
const DEMO_BLOCKS = [
  'trigger',
  'webhook',
  'javascript-code',
  'conditions',
  'new-tab',
  'upload-file',
  'wait-connections',
  'loop-breakpoint', // 多行模式 2 需要
];

describe('block registry', () => {
  const registry = getRegistry();

  it('带源码水印且块数 ≥ 60', () => {
    expect(registry.source.automaVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(registry.blockCount).toBeGreaterThanOrEqual(60);
    expect(Object.keys(registry.blocks)).toHaveLength(registry.blockCount);
  });

  it('demo 用到的块全部存在', () => {
    for (const label of DEMO_BLOCKS) {
      expect(registry.blocks[label], `缺少块 ${label}`).toBeDefined();
    }
  });

  it('样本每个节点的 data 覆盖注册表默认值（默认键 ⊆ 样本键）', () => {
    // 判据：注册表默认 data 的每个键都出现在样本节点 data 中且类型一致。
    // 若失败说明 automa 升级新增了默认字段，需要重跑 `pnpm registry` 并核对。
    for (const node of sample.drawflow.nodes) {
      const spec = getBlock(node.label);
      for (const key of Object.keys(spec.defaultData)) {
        expect(
          Object.prototype.hasOwnProperty.call(node.data, key),
          `块 ${node.label}（${node.id}）样本缺少默认键 ${key}`
        ).toBe(true);
      }
    }
  });

  it('端口事实：conditions 无输出端口、webhook 是 fallback 组件', () => {
    expect(getBlock('conditions').component).toBe('BlockConditions');
    expect(getBlock('conditions').outputs).toBe(0);
    expect(getBlock('webhook').component).toBe('BlockBasicWithFallback');
    expect(getBlock('trigger').inputs).toBe(0);
  });

  it('未知块抛带指引的错误', () => {
    expect(() => getBlock('click-element')).toThrow(/未知块类型/);
  });
});
