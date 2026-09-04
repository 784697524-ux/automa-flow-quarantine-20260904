import { collectRefsInData } from './templating.js';
import { inspectAttachmentDownloadCode } from './attachment-download.js';
import type { AutomaWorkflowJson } from './types.js';

export interface RuntimeDoctorReport {
  workflowName: string;
  secrets: string[];
  storageVariables: string[];
  dynamicVariableReadNodes: string[];
  notificationBlocks: Array<{ id: string; title?: string; message?: string }>;
  workflowNotificationEnabled: boolean;
  uploads: Array<{ id: string; selector?: string; filePaths: string[] }>;
  attachmentDownloads: Array<{
    id: string;
    context?: string;
    directFetch: boolean;
    usesAutomaFetchBase64: boolean;
    risky: boolean;
    base64ContextValid: boolean;
  }>;
  hints: string[];
}

export function inspectRuntimePrerequisites(json: AutomaWorkflowJson): RuntimeDoctorReport {
  const secrets = new Set<string>();
  const storageVariables = new Set<string>();
  const dynamicVariableReadNodes = new Set<string>();
  const uploads: RuntimeDoctorReport['uploads'] = [];
  const notificationBlocks: RuntimeDoctorReport['notificationBlocks'] = [];
  const attachmentDownloads: RuntimeDoctorReport['attachmentDownloads'] = [];

  for (const node of json.drawflow?.nodes ?? []) {
    for (const { ref } of collectRefsInData(node.data)) {
      if (ref.namespace === 'secrets' && ref.key.trim()) secrets.add(ref.key.trim());
      if (ref.namespace === 'variables' && ref.key.trim().startsWith('$$')) {
        storageVariables.add(ref.key.trim());
      }
    }

    if (node.label === 'upload-file') {
      uploads.push({
        id: node.id,
        selector: typeof node.data.selector === 'string' ? node.data.selector : undefined,
        filePaths: Array.isArray(node.data.filePaths)
          ? node.data.filePaths.filter((p): p is string => typeof p === 'string')
          : [],
      });
    }

    if (node.label === 'notification') {
      notificationBlocks.push({
        id: node.id,
        title: typeof node.data.title === 'string' ? node.data.title : undefined,
        message: typeof node.data.message === 'string' ? node.data.message : undefined,
      });
    }

    if (node.label === 'javascript-code' && typeof node.data.code === 'string') {
      const storageRefRe = /automaRefData\(\s*['"]variables['"]\s*,\s*['"](\$\$[^'"]+)['"]/g;
      let storageMatch: RegExpExecArray | null;
      while ((storageMatch = storageRefRe.exec(node.data.code)) !== null) {
        if (storageMatch[1]) storageVariables.add(storageMatch[1]);
      }
      if (hasDynamicAutomaVariableRead(node.data.code)) {
        dynamicVariableReadNodes.add(node.id);
      }
      const inspection = inspectAttachmentDownloadCode(node.data.code);
      if (inspection.directFetch || inspection.usesAutomaFetchBase64) {
        const context = typeof node.data.context === 'string' ? node.data.context : undefined;
        attachmentDownloads.push({
          id: node.id,
          context,
          ...inspection,
          base64ContextValid: !inspection.usesAutomaFetchBase64 || context === 'website',
        });
      }
    }
  }

  const hints: string[] = [];
  if (secrets.size > 0) {
    hints.push(
      '导入后先到 Automa -> Storage -> Credentials 创建同名凭据；值为空会被替换成空字符串。'
    );
    hints.push(
      'HTTP 400 且 message=paramError-operatorId 时，优先检查 dingtalkOperatorId 是否已创建、非空、且是当前应用可用的 unionId。'
    );
    hints.push(
      'HTTP 400 出现在 Get DingTalk accessToken 时，优先检查 dingtalkAppKey/dingtalkAppSecret 是否填反、缺失或没有权限。'
    );
  }
  if (storageVariables.size > 0) {
    hints.push(
      '导入后先到 Automa -> Storage -> Variables 确认同名持久变量存在且非空；$$ 前缀必须保留。'
    );
  }
  if (dynamicVariableReadNodes.size > 0) {
    hints.push(
      '发现 automaRefData(variables, 动态表达式)，doctor 无法穷举必填名称。生产生成时应把认证变量写成字面量读取，例如 automaRefData("variables", "$$dd_app_id")。'
    );
  }
  if (secrets.size > 0 && storageVariables.size > 0) {
    hints.push(
      '同一工作流同时引用 Credentials 和 Storage Variables。这不一定错，但认证链必须显式绑定一种来源，不得在 token 失败后静默切换。'
    );
  }
  if (notificationBlocks.length > 0) {
    hints.push(
      '不要在交付给业务用户的工作流中使用 notification block；当前环境可能报 notifications.create is invalid method。'
    );
  }
  if (json.settings?.notification === true) {
    hints.push(
      '建议把 settings.notification 设为 false，避免工作流完成通知依赖浏览器 notifications 权限。'
    );
  }
  if (uploads.length > 0) {
    hints.push(
      '使用 upload-file 时，浏览器扩展需要开启文件网址访问权限；本地文件路径必须是绝对路径或运行时变量解析后的绝对路径。'
    );
  }
  if (attachmentDownloads.some((item) => item.risky)) {
    hints.push(
      "AI 表格附件 URL 不等于本地文件路径；不要在网站页面 JS 里直接 fetch 附件 URL，容易被 CORS、鉴权或临时 URL 拦截。优先用 automaFetch('base64', { url }) 转成 Blob/File，或给 upload-file 传 filename|mime|dataUrl。"
    );
    hints.push(
      '如果日志显示 Failed to fetch 且失败节点在上传附件或页面 JS，优先检查附件 URL 是否需要登录态、是否已过期、是否被目标网站页面的 CORS 限制拦截。'
    );
  }
  if (attachmentDownloads.some((item) => !item.base64ContextValid)) {
    hints.push(
      "发现非 website 上下文的 automaFetch('base64')；当前已验证的 Automa 运行时不支持该用法，请移到 website JavaScript 节点。"
    );
  }

  return {
    workflowName: json.name,
    secrets: [...secrets].sort(),
    storageVariables: [...storageVariables].sort(),
    dynamicVariableReadNodes: [...dynamicVariableReadNodes].sort(),
    notificationBlocks,
    workflowNotificationEnabled: json.settings?.notification === true,
    uploads,
    attachmentDownloads,
    hints,
  };
}

function hasDynamicAutomaVariableRead(code: string): boolean {
  const re = /automaRefData\(\s*['"]variables['"]\s*,\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const argument = (match[1] ?? '').trim();
    const literal =
      /^'(?:\\.|[^'\\])*'$/.test(argument) ||
      /^"(?:\\.|[^"\\])*"$/.test(argument) ||
      /^`(?:\\.|[^`\\$]|\$(?!\{))*`$/.test(argument);
    if (!literal) return true;
  }
  return false;
}
