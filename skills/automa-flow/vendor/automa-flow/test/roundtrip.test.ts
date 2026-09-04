/**
 * 往返测试：用 WorkflowBuilder 重建金标准样本（用户手工搭建的
 * xhs-publish.automa.json），验证语义等价。
 *
 * 判据（对齐 plan §2「允许 id/坐标差异」）：
 *   - 每个样本节点都能在产物中找到同 label 且 data 完全一致的节点；
 *   - 边的拓扑按 (源块序号, 端口, 目标块序号) 归一化后完全一致；
 *   - settings 与顶层键集合与样本一致（extVersion/version 除外——
 *     那是导出时的扩展版本水印，语义无关）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowBuilder } from '../src/builder/builder.js';
import type { AutomaWorkflowJson } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(join(here, 'fixtures', 'xhs-publish.sample.json'), 'utf8')
) as AutomaWorkflowJson;

/** 用样本的节点 data 逐块重建，并按样本边重连 */
function rebuild(): { json: AutomaWorkflowJson; idMap: Map<string, string> } {
  const builder = new WorkflowBuilder({
    name: sample.name,
    description: sample.description,
    icon: sample.icon,
    extVersion: sample.extVersion,
    settings: sample.settings,
    globalData: sample.globalData,
  });
  const idMap = new Map<string, string>();
  for (const node of sample.drawflow.nodes) {
    // 坐标无意义（引擎不消费），这里传回仅为还原方便，不参与断言
    const newId = builder.addBlock(node.label, {
      data: JSON.parse(JSON.stringify(node.data)) as Record<string, unknown>,
      position: { x: 0, y: 0 },
    });
    idMap.set(node.id, newId);
  }
  for (const edge of sample.drawflow.edges) {
    const port = edge.sourceHandle.split('-output-').slice(1).join('-output-');
    builder.connect(idMap.get(edge.source)!, idMap.get(edge.target)!, { port });
  }
  return { json: builder.emit(), idMap };
}

describe('roundtrip: 重建金标准样本', () => {
  const { json, idMap } = rebuild();
  const sampleNodes = sample.drawflow.nodes;
  const outNodes = json.drawflow.nodes;

  it('顶层键集合与样本一致', () => {
    expect(Object.keys(json).sort()).toEqual(Object.keys(sample).sort());
  });

  it('节点数量与 label 多重集一致', () => {
    expect(outNodes).toHaveLength(sampleNodes.length);
    expect(outNodes.map((n) => n.label).sort()).toEqual(
      sampleNodes.map((n) => n.label).sort()
    );
  });

  it('每个样本节点的 data 在产物中逐字段一致', () => {
    for (const sNode of sampleNodes) {
      const newId = idMap.get(sNode.id)!;
      const out = outNodes.find((n) => n.id === newId)!;
      expect(out.label).toBe(sNode.label);
      expect(out.type).toBe(sNode.type);
      // data 以样本为基准逐键相等（样本来自编辑器导出，是完整配置）
      for (const [key, value] of Object.entries(sNode.data)) {
        expect(out.data[key], `节点 ${sNode.id} 的 data.${key}`).toEqual(value);
      }
    }
  });

  it('边拓扑归一化后完全一致', () => {
    const labelOf = (nodes: AutomaWorkflowJson['drawflow']['nodes'], id: string) =>
      nodes.find((n) => n.id === id)?.label ?? '?';
    const normalize = (
      edges: AutomaWorkflowJson['drawflow']['edges'],
      nodes: AutomaWorkflowJson['drawflow']['nodes']
    ) =>
      edges
        .map((e) => {
          const port = e.sourceHandle.split('-output-').slice(1).join('-output-');
          return `${labelOf(nodes, e.source)}--${port}-->${labelOf(nodes, e.target)}`;
        })
        .sort();
    expect(normalize(json.drawflow.edges, outNodes)).toEqual(
      normalize(sample.drawflow.edges, sampleNodes)
    );
  });

  it('settings 与样本一致', () => {
    expect(json.settings).toEqual(sample.settings);
  });

  it('conditions 输出端口（条件组 id）被正确重建', () => {
    const sampleCondEdge = sample.drawflow.edges.find((e) =>
      e.sourceHandle.includes('-output-') && !e.sourceHandle.endsWith('-output-1') && !e.sourceHandle.endsWith('-output-fallback')
    )!;
    const condNode = sampleNodes.find((n) => n.id === sampleCondEdge.source)!;
    const condId = (condNode.data.conditions as { id: string }[])[0]!.id;
    expect(sampleCondEdge.sourceHandle).toBe(`${condNode.id}-output-${condId}`);
    // 产物里对应边使用新条件组 id
    const outCondNode = outNodes.find((n) => n.label === 'conditions')!;
    const outCondId = (outCondNode.data.conditions as { id: string }[])[0]!.id;
    const outEdge = json.drawflow.edges.find(
      (e) => e.source === outCondNode.id
    )!;
    expect(outEdge.sourceHandle).toBe(`${outCondNode.id}-output-${outCondId}`);
  });
});
