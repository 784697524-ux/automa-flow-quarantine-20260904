/**
 * xhs-publish 场景模板（P3）—— 复刻并产品化
 * `.sandbox/automa-aitable-demo` 的金标准工作流：
 *
 *   trigger → HTTP(取 accessToken) → HTTP(ListRecords) → JS(挑「待发布」行拆变量)
 *     → conditions(hasRow eq true) → new-tab(小红书发布页) → upload-file(素材)
 *     → wait-connections → JS(填标题/正文) → HTTP(PUT 回写「已发布」)
 *
 * 与原手工样本的差异（均为有意为之）：
 *   - appKey/appSecret 默认走 Automa Credentials，不在 JSON 里落明文；
 *     调用方显式传入时才内联；
 *   - settings.publicId 可预置，交付后即可用
 *     `dispatchEvent(new CustomEvent('automa:execute-workflow', {detail:{publicId}}))`
 *     从任意页面触发，不依赖导入后的本地 id。
 */
import { WorkflowBuilder } from '../builder/builder.js';
import type { AutomaWorkflowJson } from '../types.js';

export interface XhsPublishTemplateOptions {
  /**
   * 钉钉应用 appKey。不传时默认引用 `{{secrets@dingtalkAppKey}}`，
   * 需在 Automa「Storage → Credentials」里创建同名 secret。
   */
  appKey?: string;
  /**
   * 钉钉应用 appSecret。不传时默认引用 `{{secrets@dingtalkAppSecret}}`，
   * 需在 Automa「Storage → Credentials」里创建同名 secret。
   */
  appSecret?: string;
  /** AI 表格 baseId / sheetId */
  baseId: string;
  sheetId: string;
  /**
   * OpenAPI operatorId（unionId）。不传时默认引用 Automa Credentials 中的
   * `{{secrets@dingtalkOperatorId}}`。
   */
  operatorId?: string;
  /** 小红书创作者发布页 */
  publishUrl?: string;
  /** 状态列列名与取值 */
  statusField?: string;
  pendingValue?: string;
  publishedValue?: string;
  /** AI 表格列名 → 工作流变量名 映射（标题/正文/素材路径） */
  fieldMap?: Record<string, string>;
  /** 页面语义变量名，必须由 fieldMap 或未来触发参数声明 */
  titleVar?: string;
  bodyVar?: string;
  mediaVar?: string;
  /** 标题/正文输入框选择器（以站点实测为准） */
  titleSelector?: string;
  bodySelector?: string;
  /** 工作流名称 */
  workflowName?: string;
  /** 预置 publicId 后可通过 CustomEvent 外部触发 */
  publicId?: string;
}

const DEFAULT_PUBLISH_URL =
  'https://creator.xiaohongshu.com/publish/publish?from=menu&target=image';

export function buildXhsPublish(opts: XhsPublishTemplateOptions): AutomaWorkflowJson {
  for (const key of ['baseId', 'sheetId'] as const) {
    if (!opts[key]?.trim()) throw new Error(`xhs-publish 模板缺少必填参数 ${key}`);
  }

  const statusField = opts.statusField ?? '状态';
  const pendingValue = opts.pendingValue ?? '待发布';
  const publishedValue = opts.publishedValue ?? '已发布';
  const fieldMap = opts.fieldMap ?? {
    标题: 'title',
    正文: 'body',
    素材路径: 'mediaPath',
  };
  const titleVar = opts.titleVar ?? 'title';
  const bodyVar = opts.bodyVar ?? 'body';
  const mediaVar = opts.mediaVar ?? 'mediaPath';
  assertFieldMapDeclares('xhs-publish', fieldMap, [titleVar, bodyVar, mediaVar]);
  const appKey = opts.appKey ?? '{{secrets@dingtalkAppKey}}';
  const appSecret = opts.appSecret ?? '{{secrets@dingtalkAppSecret}}';
  const operatorId = opts.operatorId ?? '{{secrets@dingtalkOperatorId}}';

  const builder = new WorkflowBuilder({
    name: opts.workflowName ?? 'xhs-publish',
    description:
      '从钉钉 AI 表格取「待发布」行，自动发布小红书图文并回写状态。由 automa-flow 生成。',
    publicId: opts.publicId,
    settings: { execContext: 'popup', onError: 'stop-workflow' },
  });

  // ── 节点 ────────────────────────────────────────────────────────────
  const trigger = builder.addBlock('trigger');

  const tokenReq = builder.addBlock('webhook', {
    data: {
      description: 'Get AccessToken',
      url: 'https://api.dingtalk.com/v1.0/oauth2/accessToken',
      method: 'POST',
      timeout: 30000,
      body: JSON.stringify({ appKey, appSecret }, null, 2),
      variableName: 'tokenResp',
      assignVariable: true,
    },
  });

  const listReq = builder.addBlock('webhook', {
    data: {
      description: 'GetRecords',
      url: `https://api.dingtalk.com/v1.0/notable/bases/${opts.baseId}/sheets/${opts.sheetId}/records/list?operatorId=${operatorId}`,
      method: 'POST',
      timeout: 30000,
      body: JSON.stringify({ maxResults: 50 }, null, 2),
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        {
          name: 'x-acs-dingtalk-access-token',
          value: '{{variables@tokenResp.accessToken}}',
        },
      ],
      variableName: 'listResp',
      assignVariable: true,
    },
  });

  const pickJs = builder.addBlock('javascript-code', {
    data: {
      description: 'setVariables',
      context: 'background',
      timeout: 20000,
      code: buildPickRowCode({ statusField, pendingValue, fieldMap }),
    },
  });

  const cond = builder.addBlock('conditions');
  const condId = builder.addCondition(cond, {
    name: 'hasRow',
    left: '{{variables@hasRow}}',
    compare: 'eq',
    right: 'true',
  });

  const newTab = builder.addBlock('new-tab', {
    data: { url: opts.publishUrl ?? DEFAULT_PUBLISH_URL, active: true },
  });

  const upload = builder.addBlock('upload-file', {
    data: {
      findBy: 'cssSelector',
      selector: 'input[type="file"]',
      filePaths: [`{{variables@${mediaVar}}}`],
    },
  });

  const waitConn = builder.addBlock('wait-connections', {
    data: { timeout: 10000 },
  });

  const fillJs = builder.addBlock('javascript-code', {
    data: {
      context: 'website',
      timeout: 20000,
      code: buildFillCode({
        titleSelector: opts.titleSelector ?? '.d-input > .d-text',
        bodySelector: opts.bodySelector ?? 'div.tiptap',
        titleVar,
        bodyVar,
      }),
    },
  });

  const writeBack = builder.addBlock('webhook', {
    data: {
      url: `https://api.dingtalk.com/v1.0/notable/bases/${opts.baseId}/sheets/${opts.sheetId}/records?operatorId=${operatorId}`,
      method: 'PUT',
      timeout: 30000,
      body: JSON.stringify(
        { records: [{ id: '{{variables@recordId}}', fields: { [statusField]: publishedValue } }] },
        null,
        2
      ),
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        {
          name: 'x-acs-dingtalk-access-token',
          value: '{{variables@tokenResp.accessToken}}',
        },
      ],
    },
  });

  // ── 连线（与金标准样本拓扑一致） ────────────────────────────────────
  builder.chain([trigger, tokenReq, listReq, pickJs, cond]);
  builder.connect(cond, newTab, { port: condId });
  builder.chain([newTab, upload, waitConn, fillJs, writeBack]);

  return builder.emit();
}

function assertFieldMapDeclares(
  template: string,
  fieldMap: Record<string, string>,
  requiredVars: string[]
): void {
  const declared = new Set(Object.values(fieldMap));
  const missing = requiredVars.filter((name) => !declared.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${template} 的 fieldMap 没有声明页面所需变量：${missing.join(', ')}。` +
        '请调整模板配置里的 fieldMap，或用 titleVar/bodyVar/mediaVar 指定对应变量名'
    );
  }
}

/** 挑行 + 拆变量的 JS（background 上下文，对齐样本逻辑） */
function buildPickRowCode(cfg: {
  statusField: string;
  pendingValue: string;
  fieldMap: Record<string, string>;
}): string {
  return `/**
 * 前置：HTTP Request 块（ListRecords）已把响应赋值给变量 listResp。
 * 作用：挑第一条「${cfg.pendingValue}」行，拆成工作流变量；无待处理行置 hasRow=false。
 */
const CONFIG = {
  statusField: ${JSON.stringify(cfg.statusField)},
  pendingValue: ${JSON.stringify(cfg.pendingValue)},
};

const resp = automaRefData('variables', 'listResp');
const records = (resp && resp.records) || [];

// 单选字段读回是对象 {name, id}（也可能嵌套数组），归一化出选项名
const optionName = (v) => {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return optionName(v[0]);
  if (typeof v === 'object') return v.name ?? v.text ?? v.value;
  return String(v);
};

const row = records.find((r) => optionName((r.fields || {})[CONFIG.statusField]) === CONFIG.pendingValue);

// 字段值归一化：单选对象取选项名；文本/数字 -> 字符串；附件等复杂结构 -> JSON
const toText = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const name = optionName(v);
  return typeof name === 'string' ? name : JSON.stringify(v);
};

if (!row) {
  automaSetVariable('hasRow', false);
} else {
  automaSetVariable('hasRow', true);
  automaSetVariable('recordId', row.recordId ?? row.id);
${Object.entries(cfg.fieldMap)
  .map(
    ([column, varName]) =>
      `  automaSetVariable(${JSON.stringify(varName)}, toText(row.fields[${JSON.stringify(column)}]));`
  )
  .join('\n')}
}
automaNextBlock();`;
}

/** 页面内填写标题/正文的 JS（website 上下文，对齐样本逻辑） */
function buildFillCode(cfg: {
  titleSelector: string;
  bodySelector: string;
  titleVar: string;
  bodyVar: string;
}): string {
  return `const set = (sel, text) => {
  const el = document.querySelector(sel);
  if (!el) return;
  el.focus();
  if (el.isContentEditable) el.innerText = text;  // 正文富文本走这条
  else el.value = text;                            // 标题 input 走这条
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
set(${JSON.stringify(cfg.titleSelector)}, automaRefData('variables', ${JSON.stringify(cfg.titleVar)}));
set(${JSON.stringify(cfg.bodySelector)}, automaRefData('variables', ${JSON.stringify(cfg.bodyVar)}));
automaNextBlock();`;
}
