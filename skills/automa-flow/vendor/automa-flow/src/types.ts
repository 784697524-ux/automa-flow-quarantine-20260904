/**
 * automa-flow 核心类型定义。
 *
 * 对齐 Automa 扩展的 .automa.json 导入契约（vue-flow 格式）。字段名与语义以
 * automa 源码为准：`src/utils/shared.js`（块注册表）、`src/utils/convertWorkflowData.js`
 * （边 handle 规则）、`src/utils/workflowData.js`（导入/导出键集合）。
 */

/** 块注册表单条记录（由 scripts/extract-block-registry.mjs 从 automa 源码生成） */
export interface BlockSpec {
  /** 块 label，即节点的 `label` 字段，如 'webhook' / 'event-click' */
  id: string;
  /** 人类可读名称，如 'HTTP Request' */
  name: string;
  description: string;
  /** vue-flow 节点类型：'BlockBasic' | 'BlockBasicWithFallback' | 'BlockConditions' | 'BlockDelay' 等 */
  component: string;
  category: string;
  /** 输入端口数 */
  inputs: number;
  /** 输出端口数（conditions 块为 0，输出端口由条件项 id 决定） */
  outputs: number;
  allowedInputs: boolean;
  /** 单个输出端口允许的最大下游连接数 */
  maxConnection: number;
  /** 块的默认 data（新建节点时的完整初始配置） */
  defaultData: Record<string, unknown>;
}

export interface BlockRegistryFile {
  $schemaNote?: string;
  source: { repo: string; file: string; automaVersion: string };
  extractedAt: string;
  blockCount: number;
  blocks: Record<string, BlockSpec>;
}

/** vue-flow 节点 */
export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  /** 块 label（对应注册表 key） */
  label: string;
  data: Record<string, unknown>;
  /** Automa 导入后的编辑器初始化标记；导出样本中为 false */
  initialized?: boolean;
}

/** vue-flow 边。引擎只消费 source/target/sourceHandle/targetHandle 四个字段 */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  type?: string;
  updatable?: boolean;
  selectable?: boolean;
  data?: Record<string, unknown>;
  label?: string;
  markerEnd?: string;
  class?: string;
}

/** 工作流 settings（与样本/官方默认值对齐，execContext=popup） */
export interface WorkflowSettings {
  /** CustomEvent 触发用的公开 id；生成期可预置，不依赖导入后的本地 id */
  publicId?: string;
  aipowerToken?: string;
  blockDelay?: number;
  saveLog?: boolean;
  debugMode?: boolean;
  restartTimes?: number;
  notification?: boolean;
  /** 'popup' | 'background'。popup 时长无限且支持 !! JS 表达式 */
  execContext?: 'popup' | 'background';
  reuseLastState?: boolean;
  inputAutocomplete?: boolean;
  /** 'stop-workflow' | 'restart-workflow' | 'continue-flow' */
  onError?: string;
  executedBlockOnWeb?: boolean;
  insertDefaultColumn?: boolean;
  defaultColumnName?: string;
  [key: string]: unknown;
}

/** .automa.json 顶层结构（导出键集合对齐 src/utils/workflowData.js#convertWorkflow） */
export interface AutomaWorkflowJson {
  extVersion: string;
  name: string;
  icon: string;
  table: unknown[];
  version: string;
  drawflow: {
    nodes: FlowNode[];
    edges: FlowEdge[];
    position?: [number, number];
    zoom?: number;
  };
  settings: WorkflowSettings;
  /** JSON 字符串（官方就是字符串形态） */
  globalData: string;
  description: string;
  includedWorkflows: Record<string, unknown>;
}

/** lint 结果条目 */
export interface LintIssue {
  rule: string;
  severity: 'error' | 'warning';
  /** 关联节点 id（图级问题可为空） */
  nodeId?: string;
  message: string;
}

/** conditions 块的单个条件组（顶层一条 = 一个输出端口） */
export interface ConditionGroup {
  id: string;
  name: string;
  conditions: unknown[];
}
