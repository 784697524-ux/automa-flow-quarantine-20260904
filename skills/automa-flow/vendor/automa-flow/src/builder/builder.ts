/**
 * WorkflowBuilder —— .automa.json 的程序化构建器（P1 核心）。
 *
 * 对齐三条源码事实：
 *   1. 节点形态 = `{ id, type: tasks[label].component, initialized, position,
 *      data: tasks[label].data(深合并), label }`
 *      （src/newtab/pages/workflows/[id].vue#onDropInEditor）；
 *   2. 边 handle = `sourceHandle: ${source}-output-${port}` /
 *      `targetHandle: ${target}-input-1`，引擎按此解析连接
 *      （src/utils/convertWorkflowData.js、WorkflowWorker.js）；
 *   3. 顶层键集合 = extVersion/name/icon/table/version/drawflow/settings/
 *      globalData/description/includedWorkflows
 *      （src/utils/workflowData.js#convertWorkflow；导入零校验）。
 *
 * conditions 块的输出端口不是数字，而是条件组 id：先 `addCondition` 拿到
 * conditionId，再 `connect(condNode, next, { port: conditionId })`。
 */
import { genId } from '../id.js';
import { cloneDefaultData, getBlock, getRegistry } from '../registry.js';
import type {
  AutomaWorkflowJson,
  FlowEdge,
  FlowNode,
  WorkflowSettings,
} from '../types.js';

export interface WorkflowBuilderOptions {
  name: string;
  description?: string;
  icon?: string;
  /** 不传则用注册表提取时的 automa 版本水印 */
  extVersion?: string;
  settings?: WorkflowSettings;
  /** 预置 CustomEvent 触发用的 publicId（不依赖导入后的本地 id） */
  publicId?: string;
  /** 官方默认 `{"key": "value"}`；可传对象或已序列化的字符串 */
  globalData?: Record<string, unknown> | string;
}

export interface AddBlockOptions {
  id?: string;
  /** 深合并进块默认 data（对象递归合并，其余类型直接替换） */
  data?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface ConnectOptions {
  /** 输出端口：默认 '1'；fallback 块可传 'fallback'；conditions 块传条件组 id */
  port?: string;
}

export interface ConditionOptions {
  name?: string;
  /** 左值，通常是 mustache 引用，如 `{{variables@hasRow}}` */
  left: string;
  /** 比较类型：'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' 等 */
  compare?: string;
  /** 右值；需要类型语义时用前缀：'string::' / 'number::' / 'boolean::' / 'json::' */
  right: string;
}

/** settings 默认值：对齐官方新建工作流默认（样本逐项验证过） */
const DEFAULT_SETTINGS: Required<
  Pick<
    WorkflowSettings,
    | 'publicId'
    | 'aipowerToken'
    | 'blockDelay'
    | 'saveLog'
    | 'debugMode'
    | 'restartTimes'
    | 'notification'
    | 'execContext'
    | 'reuseLastState'
    | 'inputAutocomplete'
    | 'onError'
    | 'executedBlockOnWeb'
    | 'insertDefaultColumn'
    | 'defaultColumnName'
  >
> = {
  publicId: '',
  aipowerToken: '',
  blockDelay: 0,
  saveLog: true,
  debugMode: false,
  // 默认不重试：发布、POST/PUT 回写等副作用在结果不明时重试会造成重复数据。
  restartTimes: 0,
  notification: false,
  execContext: 'popup',
  reuseLastState: false,
  inputAutocomplete: true,
  onError: 'stop-workflow',
  executedBlockOnWeb: false,
  insertDefaultColumn: false,
  defaultColumnName: 'column',
};

/** 自动布局：每行 6 个，横向 320、纵向 380 间距（纯视觉，引擎不消费坐标） */
const COLS = 6;
const COL_GAP = 320;
const ROW_GAP = 380;

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!patch) return base;
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      base[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      base[key] = value;
    }
  }
  return base;
}

export class WorkflowBuilder {
  private readonly nodes: FlowNode[] = [];
  private readonly edges: FlowEdge[] = [];
  private placed = 0;

  constructor(private readonly opts: WorkflowBuilderOptions) {
    if (!opts.name?.trim()) throw new Error('工作流 name 不能为空');
  }

  /** 添加块节点，返回节点 id。data 深合并进注册表默认值 */
  addBlock(label: string, options: AddBlockOptions = {}): string {
    const spec = getBlock(label);
    const id = options.id ?? genId();
    if (this.nodes.some((n) => n.id === id)) {
      throw new Error(`节点 id 重复：${id}`);
    }
    const position =
      options.position ??
      (() => {
        const col = this.placed % COLS;
        const row = Math.floor(this.placed / COLS);
        this.placed += 1;
        return { x: col * COL_GAP, y: row * ROW_GAP };
      })();
    // 键序与官方导出样本保持一致：id, type, initialized, position, data, label
    this.nodes.push({
      id,
      type: spec.component,
      initialized: false,
      position,
      data: deepMerge(cloneDefaultData(label), options.data),
      label,
    });
    return id;
  }

  /** 取节点（用于模板里继续改 data） */
  getNode(id: string): FlowNode {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`节点不存在：${id}`);
    return node;
  }

  /**
   * 连接两个节点。端口规则与引擎解析一致：
   *   - 普通块只有 '1' 端口；
   *   - BlockBasicWithFallback（webhook 等）额外有 'fallback'；
   *   - BlockConditions 的端口是条件组 id（见 addCondition）。
   */
  connect(fromId: string, toId: string, options: ConnectOptions = {}): void {
    const from = this.getNode(fromId);
    const to = this.getNode(toId);
    const fromSpec = getBlock(from.label);
    const toSpec = getBlock(to.label);
    if (toSpec.inputs < 1) {
      throw new Error(`块 "${to.label}"（${toId}）没有输入端口`);
    }

    const port = options.port ?? '1';
    if (fromSpec.component === 'BlockConditions') {
      const groups = (from.data.conditions ?? []) as { id?: string }[];
      if (!groups.some((g) => g.id === port)) {
        throw new Error(
          `conditions 节点 ${fromId} 没有 id 为 "${port}" 的条件组，` +
            '请先用 addCondition 创建条件并传回其 conditionId'
        );
      }
    } else if (port === 'fallback') {
      if (fromSpec.component !== 'BlockBasicWithFallback') {
        throw new Error(`块 "${from.label}" 没有 fallback 端口`);
      }
    } else if (port !== '1') {
      throw new Error(`块 "${from.label}" 只支持端口 '1'，收到 "${port}"`);
    } else if (fromSpec.outputs < 1) {
      throw new Error(`块 "${from.label}" 没有 '1' 输出端口`);
    }

    const sourceHandle = `${fromId}-output-${port}`;
    const samePortEdges = this.edges.filter((e) => e.sourceHandle === sourceHandle);
    if (samePortEdges.length >= fromSpec.maxConnection) {
      throw new Error(
        `端口 ${sourceHandle} 已达最大连接数 ${fromSpec.maxConnection}（块 "${from.label}"）`
      );
    }

    const targetHandle = `${toId}-input-1`;
    // 键序对齐 convertWorkflowData.js + 官方导出样本
    this.edges.push({
      id: `vueflow__edge-${sourceHandle}-${targetHandle}`,
      type: 'custom',
      source: fromId,
      target: toId,
      sourceHandle,
      targetHandle,
      updatable: true,
      selectable: true,
      data: {},
      label: '',
      markerEnd: 'arrowclosed',
      class: `source-${sourceHandle} target-${targetHandle}`,
    });
  }

  /** 顺序串联一组节点（语法糖） */
  chain(ids: string[]): void {
    for (let i = 0; i < ids.length - 1; i += 1) {
      this.connect(ids[i]!, ids[i + 1]!);
    }
  }

  /**
   * 给 conditions 节点追加一个条件组（= 一个输出端口），返回条件组 id。
   * 数据结构对齐官方导出样本的三层嵌套：
   *   { id, name, conditions: [{ id, conditions: [{ id, items: [值, 比较, 值] }] }] }
   */
  addCondition(nodeId: string, options: ConditionOptions): string {
    const node = this.getNode(nodeId);
    if (node.label !== 'conditions') {
      throw new Error(`addCondition 只能用于 conditions 块，收到 "${node.label}"`);
    }
    const compare = options.compare ?? 'eq';
    const groupId = genId();
    const group = {
      id: groupId,
      name: options.name ?? '',
      conditions: [
        {
          id: genId(),
          conditions: [
            {
              id: genId(),
              items: [
                {
                  type: 'value',
                  category: 'value',
                  data: { value: options.left },
                  id: genId(),
                },
                { id: genId(), category: 'compare', type: compare },
                {
                  type: 'value',
                  category: 'value',
                  data: { value: options.right },
                  id: genId(),
                },
              ],
            },
          ],
        },
      ],
    };
    const conditions = (node.data.conditions ?? []) as unknown[];
    conditions.push(group);
    node.data.conditions = conditions;
    return groupId;
  }

  /** 产出 .automa.json 顶层对象 */
  emit(): AutomaWorkflowJson {
    const version = this.opts.extVersion ?? getRegistry().source.automaVersion;
    const globalData =
      typeof this.opts.globalData === 'string'
        ? this.opts.globalData
        : JSON.stringify(this.opts.globalData ?? { key: 'value' });
    const settings: WorkflowSettings = {
      ...DEFAULT_SETTINGS,
      ...(this.opts.settings ?? {}),
      publicId:
        this.opts.publicId ?? this.opts.settings?.publicId ?? DEFAULT_SETTINGS.publicId,
    };
    // 键序对齐官方导出（convertWorkflow 的 defaultValue 集合）
    return {
      extVersion: version,
      name: this.opts.name,
      icon: this.opts.icon ?? 'riGlobalLine',
      table: [],
      version,
      drawflow: {
        nodes: JSON.parse(JSON.stringify(this.nodes)) as FlowNode[],
        edges: JSON.parse(JSON.stringify(this.edges)) as FlowEdge[],
        position: [0, 0],
        zoom: 1,
      },
      settings,
      globalData,
      description: this.opts.description ?? '',
      includedWorkflows: {},
    };
  }

  /** 序列化成可直接导入的 JSON 文本 */
  toJSON(pretty = true): string {
    return JSON.stringify(this.emit(), null, pretty ? 2 : 0);
  }
}
