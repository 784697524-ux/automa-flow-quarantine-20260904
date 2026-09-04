import { genId } from './id.js';
import type { AutomaWorkflowJson, FlowEdge, FlowNode, LintIssue } from './types.js';
import { lintWorkflow } from './lint/lint.js';

const SELECTOR_LABELS = new Set([
  'event-click',
  'forms',
  'upload-file',
  'element-scroll',
  'link',
  'trigger-event',
  'get-text',
  'element-exists',
  'hover-element',
]);

export interface RecordedSelectorBlock {
  id: string;
  label: string;
  description: string;
  selector: string;
  findBy: string;
  value?: unknown;
  filePaths?: string[];
}

export interface RecordedWorkflowAnalysis {
  name: string;
  nodes: number;
  edges: number;
  triggers: number;
  selectorBlocks: RecordedSelectorBlock[];
  noise: RecordedNoise[];
  defects: RecordedDefect[];
  hardcoded: RecordedHardcodedValue[];
  issues: LintIssue[];
}

export interface MergeRecordedOptions {
  after: string;
  dropNoise?: boolean;
  parametrize?: RecordedParametrizeOptions;
}

export interface TransformRecordedOptions {
  dropNoise?: boolean;
  parametrize?: RecordedParametrizeOptions;
}

export interface RecordedParametrizeOptions {
  forms?: Record<string, string>;
  upload?: Record<string, string>;
}

export interface RecordedNoise {
  id: string;
  label: string;
  reason: string;
}

export interface RecordedDefect {
  kind: 'ime-contenteditable' | 'empty-trigger-event';
  id: string;
  label: string;
  suggestion: string;
  clickId?: string;
  pressGroupId?: string;
  clickSelector?: string;
}

export interface RecordedHardcodedValue {
  id: string;
  label: string;
  selector: string;
  kind: 'forms-value' | 'upload-filePaths';
  value: unknown;
  suggestion: string;
}

export function analyzeRecordedWorkflow(
  json: AutomaWorkflowJson
): RecordedWorkflowAnalysis {
  const nodes = json.drawflow?.nodes ?? [];
  const noise = collectNoise(nodes);
  return {
    name: json.name,
    nodes: nodes.length,
    edges: json.drawflow?.edges?.length ?? 0,
    triggers: nodes.filter((n) => n.label === 'trigger').length,
    selectorBlocks: nodes
      .filter((n) => SELECTOR_LABELS.has(n.label) && typeof n.data.selector === 'string')
      .map((n) => selectorSummary(n)),
    noise,
    defects: collectDefects(nodes, noise),
    hardcoded: collectHardcodedValues(nodes),
    issues: lintWorkflow(json),
  };
}

export function transformRecordedWorkflow(
  json: AutomaWorkflowJson,
  options: TransformRecordedOptions = {}
): AutomaWorkflowJson {
  let result = clone(json);
  if (options.dropNoise) {
    const noiseIds = new Set(collectNoise(result.drawflow.nodes).map((item) => item.id));
    result = removeNodesAndReconnect(result, noiseIds);
  }
  if (options.parametrize) {
    result = parametrizeRecordedValues(result, options.parametrize);
  }
  return result;
}

export function mergeRecordedFragment(
  skeleton: AutomaWorkflowJson,
  fragment: AutomaWorkflowJson,
  options: MergeRecordedOptions
): AutomaWorkflowJson {
  const afterNode = skeleton.drawflow.nodes.find((n) => n.id === options.after);
  if (!afterNode) throw new Error(`after 节点不存在：${options.after}`);

  const transformedFragment = transformRecordedWorkflow(fragment, {
    dropNoise: options.dropNoise,
    parametrize: options.parametrize,
  });
  const fragmentTriggers = transformedFragment.drawflow.nodes.filter((n) => n.label === 'trigger');
  if (fragmentTriggers.length > 1) {
    throw new Error('录制片段不能包含多个 trigger');
  }

  const triggerId = fragmentTriggers[0]?.id;
  const fragmentNodes = transformedFragment.drawflow.nodes.filter((n) => n.id !== triggerId);
  if (fragmentNodes.length === 0) {
    throw new Error('录制片段没有可合并的页面操作节点');
  }
  const fragmentNodeIds = new Set(fragmentNodes.map((n) => n.id));
  const fragmentEdges = transformedFragment.drawflow.edges.filter(
    (e) => fragmentNodeIds.has(e.source) && fragmentNodeIds.has(e.target)
  );

  const entryOldIds = triggerId
    ? transformedFragment.drawflow.edges
        .filter((e) => e.source === triggerId && fragmentNodeIds.has(e.target))
        .map((e) => e.target)
    : findEntryNodeIds(fragmentNodes, fragmentEdges);
  const uniqueEntries = [...new Set(entryOldIds)];
  if (uniqueEntries.length !== 1) {
    throw new Error(`录制片段必须有且只有一个入口节点，当前 ${uniqueEntries.length} 个`);
  }

  const tailOldIds = findTailNodeIds(fragmentNodes, fragmentEdges);
  if (tailOldIds.length !== 1) {
    throw new Error(`录制片段必须有且只有一个尾节点，当前 ${tailOldIds.length} 个`);
  }

  const afterMainHandle = `${options.after}-output-1`;
  const outgoing = skeleton.drawflow.edges.filter((e) => e.sourceHandle === afterMainHandle);
  if (outgoing.length > 1) {
    throw new Error(`after 节点 ${options.after} 的主输出端口存在多个下游，无法自动插入`);
  }

  const skeletonIds = new Set(skeleton.drawflow.nodes.map((n) => n.id));
  const idMap = new Map<string, string>();
  for (const node of fragmentNodes) {
    let nextId = `rec_${genId()}`;
    while (skeletonIds.has(nextId) || idMapHasValue(idMap, nextId)) {
      nextId = `rec_${genId()}`;
    }
    idMap.set(node.id, nextId);
  }

  const afterPos = afterNode.position ?? { x: 0, y: 0 };
  const remappedNodes = fragmentNodes.map((node, index) => ({
    ...clone(node),
    id: idMap.get(node.id)!,
    position: {
      x: afterPos.x + 320 * (index + 1),
      y: afterPos.y,
    },
  }));

  const remappedEdges = fragmentEdges.map((edge) =>
    createEdge({
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
      port: edgePort(edge),
    })
  );

  const existingEdges = skeleton.drawflow.edges.filter((e) => !outgoing.includes(e));
  const entryId = idMap.get(uniqueEntries[0]!)!;
  const tailId = idMap.get(tailOldIds[0]!)!;
  const insertedEdges = [
    createEdge({ source: options.after, target: entryId, port: '1' }),
    ...remappedEdges,
  ];
  if (outgoing[0]) {
    insertedEdges.push(createEdge({ source: tailId, target: outgoing[0].target, port: '1' }));
  }

  return {
    ...clone(skeleton),
    drawflow: {
      ...clone(skeleton.drawflow),
      nodes: [...clone(skeleton.drawflow.nodes), ...remappedNodes],
      edges: [...existingEdges, ...insertedEdges],
    },
    settings: clone(skeleton.settings),
  };
}

function selectorSummary(node: FlowNode): RecordedSelectorBlock {
  const summary: RecordedSelectorBlock = {
    id: node.id,
    label: node.label,
    description: typeof node.data.description === 'string' ? node.data.description : '',
    selector: String(node.data.selector ?? ''),
    findBy: typeof node.data.findBy === 'string' ? node.data.findBy : 'cssSelector',
  };
  if ('value' in node.data) summary.value = node.data.value;
  if (Array.isArray(node.data.filePaths)) {
    summary.filePaths = node.data.filePaths.filter((p): p is string => typeof p === 'string');
  }
  return summary;
}

function collectNoise(nodes: FlowNode[]): RecordedNoise[] {
  const noise: RecordedNoise[] = [];
  const pressKeyNoiseIds = collectEmptyPressKeyNoiseIds(nodes);
  for (const node of nodes) {
    if (node.label === 'element-scroll' && isBlank(node.data.selector)) {
      noise.push({
        id: node.id,
        label: node.label,
        reason: '录制到了空 selector 的滚动动作，通常只是页面定位噪音',
      });
    } else if (node.label === 'trigger-event' && isBlank(node.data.selector)) {
      noise.push({
        id: node.id,
        label: node.label,
        reason: '录制到了空 selector 的事件触发，运行期无法定位元素',
      });
    } else if (pressKeyNoiseIds.has(node.id)) {
      noise.push({
        id: node.id,
        label: node.label,
        reason: '录制到了空 selector 的连续按键，常见于中文输入法或裸按键噪音',
      });
    }
  }
  return noise;
}

function collectDefects(nodes: FlowNode[], noise: RecordedNoise[]): RecordedDefect[] {
  const defects: RecordedDefect[] = [];
  const noiseIds = new Set(noise.map((item) => item.id));
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    if (node.label === 'trigger-event' && isBlank(node.data.selector)) {
      defects.push({
        kind: 'empty-trigger-event',
        id: node.id,
        label: node.label,
        suggestion: '这个 trigger-event 没有 selector，不能稳定回放；如果是受控组件 change 事件，请重新录制或补 selector 后保留。',
      });
    }
    if (node.label !== 'event-click') continue;
    const group = collectFollowingPressKeyGroup(nodes, i + 1);
    if (group.length < 2) continue;
    if (!group.every((press) => noiseIds.has(press.id))) continue;
    defects.push({
      kind: 'ime-contenteditable',
      id: group[0]!.id,
      label: 'press-key',
      clickId: node.id,
      pressGroupId: String(recordingGroupId(group[0]!) ?? group[0]!.id),
      clickSelector: typeof node.data.selector === 'string' ? node.data.selector : undefined,
      suggestion: '中文输入法在录制里常变成空 selector 的逐键 press-key，回放容易拼不出中文；建议改成变量化 forms，或用网站 JS 一次性设置 input/contenteditable 的值并派发 input/change 事件。',
    });
  }
  return defects;
}

function collectHardcodedValues(nodes: FlowNode[]): RecordedHardcodedValue[] {
  const hardcoded: RecordedHardcodedValue[] = [];
  for (const node of nodes) {
    if (node.label === 'forms') {
      const value = node.data.value;
      if (typeof value === 'string' && value.trim() && !value.includes('{{variables@')) {
        hardcoded.push({
          id: node.id,
          label: node.label,
          selector: typeof node.data.selector === 'string' ? node.data.selector : '',
          kind: 'forms-value',
          value,
          suggestion: `用 --parametrize '{"forms":{"${node.id}":"变量名"}}' 改成 {{variables@变量名}}`,
        });
      }
    }
    if (node.label === 'upload-file' && Array.isArray(node.data.filePaths)) {
      const paths = node.data.filePaths.filter((p): p is string => typeof p === 'string');
      const literalPaths = paths.filter((p) => p.trim() && !p.includes('{{variables@'));
      if (literalPaths.length > 0) {
        hardcoded.push({
          id: node.id,
          label: node.label,
          selector: typeof node.data.selector === 'string' ? node.data.selector : '',
          kind: 'upload-filePaths',
          value: literalPaths,
          suggestion: `用 --parametrize '{"upload":{"${node.id}":"变量名"}}' 改成 {{variables@变量名}}`,
        });
      }
    }
  }
  return hardcoded;
}

function collectEmptyPressKeyNoiseIds(nodes: FlowNode[]): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < nodes.length; i += 1) {
    const group = collectFollowingPressKeyGroup(nodes, i);
    if (group.length < 2) continue;
    if (
      group.every(
        (node) => isBlank(node.data.selector) && isTypingLikePressKey(String(node.data.keys ?? ''))
      )
    ) {
      for (const node of group) result.add(node.id);
    }
    i += Math.max(group.length - 1, 0);
  }
  return result;
}

function collectFollowingPressKeyGroup(nodes: FlowNode[], start: number): FlowNode[] {
  const group: FlowNode[] = [];
  for (let i = start; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    if (node.label !== 'press-key') break;
    const currentGroupId = recordingGroupId(node);
    const firstGroupId = group[0] ? recordingGroupId(group[0]) : undefined;
    if (group.length > 0 && currentGroupId && firstGroupId && currentGroupId !== firstGroupId) {
      break;
    }
    group.push(node);
  }
  return group;
}

function isTypingLikePressKey(keys: string): boolean {
  if (!keys.trim()) return true;
  if (/(^|\+)(Control|Meta|Alt)(\+|$)/.test(keys)) return false;
  return true;
}

function recordingGroupId(node: FlowNode): unknown {
  return (node as FlowNode & { groupId?: unknown }).groupId;
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function parametrizeRecordedValues(
  json: AutomaWorkflowJson,
  parametrize: RecordedParametrizeOptions
): AutomaWorkflowJson {
  const result = clone(json);
  for (const node of result.drawflow.nodes) {
    if (node.label === 'forms') {
      const variableName = parametrize.forms?.[node.id];
      if (variableName) {
        node.data.value = `{{variables@${variableName}}}`;
        node.data.clearValue = true;
      }
    } else if (node.label === 'upload-file') {
      const variableName = parametrize.upload?.[node.id];
      if (variableName) {
        node.data.filePaths = [`{{variables@${variableName}}}`];
      }
    }
  }
  return result;
}

function removeNodesAndReconnect(
  json: AutomaWorkflowJson,
  removeIds: Set<string>
): AutomaWorkflowJson {
  if (removeIds.size === 0) return json;
  const result = clone(json);
  let edges = [...result.drawflow.edges];
  for (const id of removeIds) {
    const incoming = edges.filter((e) => e.target === id);
    const outgoing = edges.filter((e) => e.source === id);
    edges = edges.filter((e) => e.source !== id && e.target !== id);
    if (incoming.length === 1 && outgoing.length === 1) {
      edges.push(
        createEdge({
          source: incoming[0]!.source,
          target: outgoing[0]!.target,
          port: edgePort(incoming[0]!),
        })
      );
    }
  }
  result.drawflow.nodes = result.drawflow.nodes.filter((node) => !removeIds.has(node.id));
  result.drawflow.edges = dedupeEdges(edges).filter(
    (edge) => !removeIds.has(edge.source) && !removeIds.has(edge.target)
  );
  return result;
}

function dedupeEdges(edges: FlowEdge[]): FlowEdge[] {
  const result: FlowEdge[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.sourceHandle}->${edge.targetHandle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function findEntryNodeIds(nodes: FlowNode[], edges: FlowEdge[]): string[] {
  const targets = new Set(edges.map((e) => e.target));
  return nodes.filter((n) => !targets.has(n.id)).map((n) => n.id);
}

function findTailNodeIds(nodes: FlowNode[], edges: FlowEdge[]): string[] {
  const sources = new Set(edges.map((e) => e.source));
  return nodes.filter((n) => !sources.has(n.id)).map((n) => n.id);
}

function edgePort(edge: FlowEdge): string {
  return edge.sourceHandle?.split('-output-').slice(1).join('-output-') || '1';
}

function createEdge(input: { source: string; target: string; port: string }): FlowEdge {
  const sourceHandle = `${input.source}-output-${input.port}`;
  const targetHandle = `${input.target}-input-1`;
  return {
    id: `vueflow__edge-${sourceHandle}-${targetHandle}`,
    type: 'custom',
    source: input.source,
    target: input.target,
    sourceHandle,
    targetHandle,
    updatable: true,
    selectable: true,
    data: {},
    label: '',
    markerEnd: 'arrowclosed',
    class: `source-${sourceHandle} target-${targetHandle}`,
  };
}

function idMapHasValue(idMap: Map<string, string>, value: string): boolean {
  for (const current of idMap.values()) {
    if (current === value) return true;
  }
  return false;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
