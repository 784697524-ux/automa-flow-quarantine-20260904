/**
 * douyin-publish 场景模板 —— 客户抖音团购图文发布链路的程序化复刻。
 *
 * 选择器事实源：客户已验证的 Automa 选择器集
 *（douyin-groupbuy-auto-publish-main/references/automa-selectors.md）：
 *
 *   trigger → HTTP(token) → HTTP(ListRecords) → JS(挑「待发布」+ 平台过滤拆变量)
 *     → conditions(hasRow) → new-tab(抖音创作页) → wait-connections
 *     → 切图文 tab → upload-file → 填标题
 *     → 选音乐（入口 + 第一首推荐）
 *     → 纠偏链：位置入口 → 国内 tab → 填位置 → 点候选项
 *       （已知坑：选音乐后页面可能把标签类型切走，发布前必须重设位置/国内）
 *     → 点发布 → HTTP(回写「已发布」)
 *
 * 与 xhs 模板的差异：
 *   - 浏览器操作全部用原生交互块（event-click / forms / upload-file），
 *     不再用 website JS 填表——验证这批块的端到端可用性；
 *   - POI 链可选（`poi: false` 时不生成纠偏链，适配非团购场景）；
 *   - 发布按钮选择器未经客户文档验证，默认 xpath 兜底、`publishSelector` 可覆盖。
 */
import { WorkflowBuilder } from '../builder/builder.js';
import type { AutomaWorkflowJson } from '../types.js';

export interface DouyinPublishTemplateOptions {
  /** 不传时默认引用 `{{secrets@dingtalkAppKey}}`（Automa Credentials） */
  appKey?: string;
  /** 不传时默认引用 `{{secrets@dingtalkAppSecret}}`（Automa Credentials） */
  appSecret?: string;
  /** AI 表格 baseId / sheetId */
  baseId: string;
  sheetId: string;
  /** 不传时默认引用 `{{secrets@dingtalkOperatorId}}`（Automa Credentials） */
  operatorId?: string;
  /** 抖音创作者发布页 */
  publishUrl?: string;
  /** 状态列列名与取值 */
  statusField?: string;
  pendingValue?: string;
  publishedValue?: string;
  /** 平台过滤：平台列列名与期望值（表里无平台列时传 platformField: '' 关闭） */
  platformField?: string;
  platformValue?: string;
  /** AI 表格列名 → 工作流变量名 映射 */
  fieldMap?: Record<string, string>;
  /** 页面语义变量名，必须由 fieldMap 或未来触发参数声明 */
  titleVar?: string;
  mediaVar?: string;
  poiVar?: string;
  /** 是否生成团购位置（POI）纠偏链，默认 true */
  poi?: boolean;
  /** 发布按钮选择器（客户文档未验证，默认 xpath 兜底，以站点实测为准） */
  publishSelector?: string;
  publishFindBy?: 'cssSelector' | 'xpath';
  /** 工作流名称 / 预置 publicId（CustomEvent 外部触发） */
  workflowName?: string;
  publicId?: string;
}

const DEFAULT_PUBLISH_URL = 'https://creator.douyin.com/creator-micro/content/upload';

/** 客户 automa-selectors.md 已验证选择器（抖音改版带 hash 后缀，失效需重抓） */
const SEL = {
  imageTab: 'div.tab-item-BcCLTS:nth-child(2)',
  uploadInput: '.semi-tabs-pane-active input',
  titleInput: 'input.semi-input',
  musicEntry: 'span.action-Q1y01k',
  musicFirst: '.card-container-tmocjc:nth-child(1) .semi-button-content',
  poiEntry: '.select-Ht3mEC .semi-select-selection-text',
  domesticTab: 'div.item-text-normal-MC1UEg',
  poiInput: '.semi-select-input > .semi-input',
  poiCandidate: '.semi-select-option-focused .detail-v2-uZaTIm',
} as const;

/** 交互块统一等待参数：抖音页面慢，放宽到 10s */
const WAIT = { waitForSelector: true, waitSelectorTimeout: 10000 } as const;

export function buildDouyinPublish(
  opts: DouyinPublishTemplateOptions
): AutomaWorkflowJson {
  for (const key of ['baseId', 'sheetId'] as const) {
    if (!opts[key]?.trim()) throw new Error(`douyin-publish 模板缺少必填参数 ${key}`);
  }

  const statusField = opts.statusField ?? '状态';
  const pendingValue = opts.pendingValue ?? '待发布';
  const publishedValue = opts.publishedValue ?? '已发布';
  const platformField = opts.platformField ?? '平台';
  const platformValue = opts.platformValue ?? '抖音';
  const fieldMap = opts.fieldMap ?? {
    标题: 'title',
    素材路径: 'mediaPath',
    位置: 'poi',
  };
  const withPoi = opts.poi ?? true;
  const titleVar = opts.titleVar ?? 'title';
  const mediaVar = opts.mediaVar ?? 'mediaPath';
  const poiVar = opts.poiVar ?? 'poi';
  assertFieldMapDeclares(
    'douyin-publish',
    fieldMap,
    withPoi ? [titleVar, mediaVar, poiVar] : [titleVar, mediaVar]
  );
  const appKey = opts.appKey ?? '{{secrets@dingtalkAppKey}}';
  const appSecret = opts.appSecret ?? '{{secrets@dingtalkAppSecret}}';
  const operatorId = opts.operatorId ?? '{{secrets@dingtalkOperatorId}}';

  const builder = new WorkflowBuilder({
    name: opts.workflowName ?? 'douyin-publish',
    description:
      '从钉钉 AI 表格取「待发布」抖音行，自动发布团购图文（音乐+POI）并回写状态。由 automa-flow 生成。',
    publicId: opts.publicId,
    settings: { execContext: 'popup', onError: 'stop-workflow' },
  });

  // ── 数据 preamble（与 xhs 模板同构） ────────────────────────────────
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
      code: buildPickCode({ statusField, pendingValue, platformField, platformValue, fieldMap }),
    },
  });

  const cond = builder.addBlock('conditions');
  const condId = builder.addCondition(cond, {
    name: 'hasRow',
    left: '{{variables@hasRow}}',
    compare: 'eq',
    right: 'true',
  });

  // ── 浏览器操作链（客户已验证选择器） ────────────────────────────────
  const newTab = builder.addBlock('new-tab', {
    data: { url: opts.publishUrl ?? DEFAULT_PUBLISH_URL, active: true },
  });

  const waitConn = builder.addBlock('wait-connections', { data: { timeout: 10000 } });

  const clickImageTab = builder.addBlock('event-click', {
    data: { description: '切图文 tab', selector: SEL.imageTab, ...WAIT },
  });

  const upload = builder.addBlock('upload-file', {
    data: { selector: SEL.uploadInput, ...WAIT, filePaths: [`{{variables@${mediaVar}}}`] },
  });

  const fillTitle = builder.addBlock('forms', {
    data: {
      description: '填标题',
      type: 'text-field',
      selector: SEL.titleInput,
      ...WAIT,
      value: `{{variables@${titleVar}}}`,
    },
  });

  const clickMusicEntry = builder.addBlock('event-click', {
    data: { description: '选音乐入口', selector: SEL.musicEntry, ...WAIT },
  });

  const clickMusicFirst = builder.addBlock('event-click', {
    data: { description: '用第一首推荐音乐', selector: SEL.musicFirst, ...WAIT },
  });

  const browserChain = [newTab, waitConn, clickImageTab, upload, fillTitle, clickMusicEntry, clickMusicFirst];

  if (withPoi) {
    // 纠偏链：选音乐后页面可能切走标签类型，发布前必须重设 位置 → 国内 → 填门店 → 点候选
    browserChain.push(
      builder.addBlock('event-click', {
        data: { description: '重设位置入口', selector: SEL.poiEntry, ...WAIT },
      }),
      builder.addBlock('event-click', {
        data: { description: '切国内 tab', selector: SEL.domesticTab, ...WAIT },
      }),
      builder.addBlock('forms', {
        data: {
          description: '填门店位置',
          type: 'text-field',
          selector: SEL.poiInput,
          ...WAIT,
          value: `{{variables@${poiVar}}}`,
        },
      }),
      builder.addBlock('event-click', {
        data: { description: '点 POI 候选项', selector: SEL.poiCandidate, ...WAIT },
      })
    );
  }

  const clickPublish = builder.addBlock('event-click', {
    data: {
      description: '点发布',
      findBy: opts.publishFindBy ?? 'xpath',
      selector: opts.publishSelector ?? '//button[contains(., "发布")]',
      ...WAIT,
    },
  });
  browserChain.push(clickPublish);

  const writeBack = builder.addBlock('webhook', {
    data: {
      description: '回写已发布',
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

  // ── 连线 ────────────────────────────────────────────────────────────
  builder.chain([trigger, tokenReq, listReq, pickJs, cond]);
  builder.connect(cond, newTab, { port: condId });
  builder.chain([...browserChain, writeBack]);

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
        '请调整模板配置里的 fieldMap，或用 titleVar/mediaVar/poiVar 指定对应变量名'
    );
  }
}

/** 挑行 + 平台过滤 + 拆变量的 JS（background 上下文；变量声明全部字面量，G07 可静态枚举） */
function buildPickCode(cfg: {
  statusField: string;
  pendingValue: string;
  platformField: string;
  platformValue: string;
  fieldMap: Record<string, string>;
}): string {
  const platformFilter = cfg.platformField
    ? `  optionName((r.fields || {})[${JSON.stringify(cfg.platformField)}]) === ${JSON.stringify(cfg.platformValue)} &&\n`
    : '';
  return `/**
 * 前置：HTTP Request 块（ListRecords）已把响应赋值给变量 listResp。
 * 作用：挑第一条「${cfg.pendingValue}」${cfg.platformField ? `且平台为「${cfg.platformValue}」` : ''}的行，
 * 拆成工作流变量；无待处理行置 hasRow=false。
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

const toText = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const name = optionName(v);
  return typeof name === 'string' ? name : JSON.stringify(v);
};

const row = records.find((r) =>
  optionName((r.fields || {})[CONFIG.statusField]) === CONFIG.pendingValue &&
${platformFilter}  true);

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
