/**
 * automa-flow CLI（P4 + P6）。
 *
 *   automa-flow list-blocks [--json]        列出注册表全部块
 *   automa-flow inspect-block <label>       查看单块的端口与默认 data
 *   automa-flow generate xhs-publish ...    用模板生成 .automa.json
 *   automa-flow import <file>               分析录制/导出的工作流并打印选择器清单
 *   automa-flow merge <base> <fragment>     把录制片段插入骨架工作流
 *   automa-flow validate <file>             对已有 .automa.json 跑 lint
 *   automa-flow doctor <file>               输出业务用户运行前检查清单
 *
 * 设计取向：agent 用自然语言搭建时可直接消费包 API（WorkflowBuilder），
 * CLI 承担「模板生成 + 录制片段处理 + 生成期质检」职责。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { getBlock, getRegistry } from '../registry.js';
import { lintWorkflow } from '../lint/lint.js';
import { buildXhsPublish } from '../templates/xhs-publish.js';
import { buildDouyinPublish } from '../templates/douyin-publish.js';
import type { XhsPublishTemplateOptions } from '../templates/xhs-publish.js';
import type { DouyinPublishTemplateOptions } from '../templates/douyin-publish.js';
import { checkNlCase, parseNlCase } from '../nl-case.js';
import {
  analyzeRecordedWorkflow,
  mergeRecordedFragment,
  transformRecordedWorkflow,
} from '../recording.js';
import type { RecordedParametrizeOptions } from '../recording.js';
import { inspectRuntimePrerequisites } from '../doctor.js';
import type { RuntimeDoctorReport } from '../doctor.js';
import type { AutomaWorkflowJson } from '../types.js';

// 管道下游提前关闭（如 `| head`）时安静退出，避免 EPIPE 崩溃
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const program = new Command();

program
  .name('automa-flow')
  .description('Automa 工作流离线生成器：模板生成 + 生成期 lint')
  .version('0.0.0');

program
  .command('list-blocks')
  .description('列出块注册表（提取自 automa 源码）的全部块')
  .option('--json', '以 JSON 输出')
  .action((opts: { json?: boolean }) => {
    const registry = getRegistry();
    if (opts.json) {
      console.log(JSON.stringify(registry.blocks, null, 2));
      return;
    }
    console.log(`块注册表（automa ${registry.source.automaVersion}，${registry.blockCount} 块）\n`);
    for (const spec of Object.values(registry.blocks)) {
      const ports =
        spec.component === 'BlockConditions'
          ? 'outputs: 条件组端口'
          : `in:${spec.inputs} out:${spec.outputs}${
              spec.component === 'BlockBasicWithFallback' ? ' +fallback' : ''
            }`;
      console.log(`  ${spec.id.padEnd(22)} ${spec.name.padEnd(26)} ${ports}`);
    }
  });

program
  .command('inspect-block <label>')
  .description('查看单个块的端口定义与默认 data')
  .action((label: string) => {
    console.log(JSON.stringify(getBlock(label), null, 2));
  });

program
  .command('generate <template>')
  .description('用模板生成 .automa.json（当前模板：xhs-publish / douyin-publish）')
  .option('--config <jsonOrFile>', '模板配置 JSON，或 JSON 文件路径')
  .option(
    '--set <key=value>',
    '覆盖模板配置的顶层字段，可重复；值会按 JSON 标量解析',
    collectValues,
    []
  )
  .option('-o, --out <file>', '输出文件路径（默认打印到 stdout）')
  .action(
    (template: string, opts: {
      config?: string;
      set: string[];
      out?: string;
    }) => {
      const config = loadTemplateConfig(opts.config, opts.set);
      let json: AutomaWorkflowJson;
      if (template === 'xhs-publish') {
        json = buildXhsPublish(config as unknown as XhsPublishTemplateOptions);
      } else if (template === 'douyin-publish') {
        json = buildDouyinPublish(config as unknown as DouyinPublishTemplateOptions);
      } else {
        console.error(`× 未知模板 "${template}"，当前可用：xhs-publish / douyin-publish`);
        process.exit(1);
        return;
      }
      const issues = lintWorkflow(json);
      reportIssues(issues);
      if (issues.some((i) => i.severity === 'error')) {
        console.error('× 生成物未通过 lint，已中止写出');
        process.exitCode = 1;
        return;
      }
      const text = `${JSON.stringify(json, null, 2)}\n`;
      if (opts.out) {
        writeFileSync(opts.out, text, 'utf8');
        console.log(`✔ 已写出 ${opts.out}`);
        console.log('  提示：如生成物引用 {{secrets@...}}，导入后请在 Automa「Storage → Credentials」创建同名凭据');
        console.log(`  可运行：node bin/automa-flow.mjs doctor ${opts.out}`);
      } else {
        process.stdout.write(text);
      }
    }
  );

program
  .command('import <file>')
  .description('分析 Automa 录制/导出的工作流，输出选择器清单、录制噪音、缺陷和硬编码值')
  .option('--json', '以 JSON 输出分析结果')
  .option('--drop-noise', '写出时删除可识别的录制噪音并重连边')
  .option('--parametrize <jsonOrFile>', '写出时按 nodeId 把 forms/upload 的硬编码值替换为变量引用')
  .option('-o, --out <file>', '写出格式化后的 .automa.json；配合 --drop-noise/--parametrize 时写出转换结果')
  .action((file: string, opts: {
    json?: boolean;
    dropNoise?: boolean;
    parametrize?: string;
    out?: string;
  }) => {
    const workflow = readWorkflow(file);
    const analysis = analyzeRecordedWorkflow(workflow);
    const parametrize = loadParametrizeOptions(opts.parametrize);

    if (opts.out) {
      const outputWorkflow = opts.dropNoise || parametrize
        ? transformRecordedWorkflow(workflow, { dropNoise: opts.dropNoise, parametrize })
        : workflow;
      writeFileSync(opts.out, `${JSON.stringify(outputWorkflow, null, 2)}\n`, 'utf8');
    }

    if (opts.json) {
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      console.log(`工作流：${analysis.name}`);
      console.log(`节点：${analysis.nodes}，边：${analysis.edges}，trigger：${analysis.triggers}`);
      console.log(`选择器块：${analysis.selectorBlocks.length}`);
      for (const block of analysis.selectorBlocks) {
        const desc = block.description ? ` ${block.description}` : '';
        console.log(`  - [${block.id}] ${block.label}${desc}: ${block.selector}`);
        if (block.value !== undefined) console.log(`    value: ${String(block.value)}`);
        if (block.filePaths) console.log(`    filePaths: ${block.filePaths.join(', ')}`);
      }
      printRecordingDiagnostics(analysis);
      reportIssues(analysis.issues);
      const errors = analysis.issues.filter((i) => i.severity === 'error').length;
      const warnings = analysis.issues.length - errors;
      console.log(`\n${errors > 0 ? '×' : '✔'} lint：${errors} error / ${warnings} warning`);
      if (opts.out && (opts.dropNoise || parametrize)) {
        console.log(`转换写出：${opts.out}`);
        if (opts.dropNoise) console.log('  - 已启用 drop-noise');
        if (parametrize) console.log('  - 已启用 parametrize');
      }
    }

  });

program
  .command('merge <skeleton> <fragment>')
  .description('把 Automa 录制片段插入骨架工作流的指定节点之后')
  .requiredOption('--after <blockId>', '插入到这个骨架节点之后')
  .option('--drop-noise', '合并前删除可识别的录制噪音并重连边')
  .option('--parametrize <jsonOrFile>', '合并前按 nodeId 把 forms/upload 的硬编码值替换为变量引用')
  .option('-o, --out <file>', '输出文件路径（默认打印到 stdout）')
  .action(
    (skeletonFile: string, fragmentFile: string, opts: {
      after: string;
      dropNoise?: boolean;
      parametrize?: string;
      out?: string;
    }) => {
      const skeleton = readWorkflow(skeletonFile);
      const fragment = readWorkflow(fragmentFile);
      const merged = mergeRecordedFragment(skeleton, fragment, {
        after: opts.after,
        dropNoise: opts.dropNoise,
        parametrize: loadParametrizeOptions(opts.parametrize),
      });
      const issues = lintWorkflow(merged);
      reportIssues(issues);
      if (issues.some((i) => i.severity === 'error')) {
        console.error('× 合并后的工作流未通过 lint，已中止写出');
        process.exitCode = 1;
        return;
      }

      const text = `${JSON.stringify(merged, null, 2)}\n`;
      if (opts.out) {
        writeFileSync(opts.out, text, 'utf8');
        console.log(`✔ 已写出 ${opts.out}`);
      } else {
        process.stdout.write(text);
      }
    }
  );

program
  .command('check-nl-case <case> <file>')
  .description('用 NL 验收用例（test/nl-cases/*.md）断言一份 .automa.json')
  .action((caseFile: string, jsonFile: string) => {
    const kase = parseNlCase(readFileSync(caseFile, 'utf8'));
    const json = JSON.parse(readFileSync(jsonFile, 'utf8')) as AutomaWorkflowJson;
    const problems = checkNlCase(kase, json);
    if (problems.length > 0) {
      console.error(`× 用例 ${kase.name} 未通过：`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✔ 用例 ${kase.name} 通过`);
  });

program
  .command('validate <file>')
  .description('对已有 .automa.json 跑生成期 lint')
  .option('--production', '生产交付硬门禁：拦截动态变量依赖、内嵌敏感值和混用认证来源')
  .action((file: string, opts: { production?: boolean }) => {
    const json = JSON.parse(readFileSync(file, 'utf8')) as AutomaWorkflowJson;
    const issues = lintWorkflow(json);
    if (opts.production) {
      for (const lintIssue of issues) {
        if (lintIssue.rule === 'G18' || lintIssue.rule === 'G19') lintIssue.severity = 'error';
      }
      const report = inspectRuntimePrerequisites(json);
      const dingTalkAuthName = /(?:dingtalk|\bding|\bdd[_-]|app[_-]?(?:key|id|secret)|operator[_-]?id)/i;
      const credentialAuth = report.secrets.filter((name) => dingTalkAuthName.test(name));
      const storageAuth = report.storageVariables.filter((name) => dingTalkAuthName.test(name));
      if (credentialAuth.length > 0 && storageAuth.length > 0) {
        issues.push({
          rule: 'P01',
          severity: 'error',
          message:
            '生产工作流同时引用 Credentials 和 Storage Variables；认证来源必须固定为一种，防止导入后替换为空值或隐式切换账号',
        });
      }
    }
    reportIssues(issues);
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.length - errors;
    if (errors > 0) {
      console.error(`\n× ${errors} error / ${warnings} warning`);
      process.exitCode = 1;
    } else {
      console.log(
        `\n✔ ${opts.production ? '生产静态门禁' : '静态结构校验'}通过（${warnings} warning）`
      );
      console.log('  注意：这不证明已导入、浏览器执行或外部系统回写成功。');
    }
  });

program
  .command('doctor <file>')
  .description('输出导入/运行前检查清单，帮助业务用户配置 Credentials 和环境权限')
  .option('--json', '以 JSON 输出')
  .action((file: string, opts: { json?: boolean }) => {
    const json = readWorkflow(file);
    const report = inspectRuntimePrerequisites(json);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printDoctorReport(report);
  });

function readWorkflow(file: string): AutomaWorkflowJson {
  return JSON.parse(readFileSync(file, 'utf8')) as AutomaWorkflowJson;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function loadTemplateConfig(input: string | undefined, assignments: string[]): Record<string, unknown> {
  const config = input ? parseConfigInput(input) : {};
  for (const assignment of assignments) {
    applyAssignment(config, assignment);
  }
  return config;
}

function parseConfigInput(input: string): Record<string, unknown> {
  const text = input.trim().startsWith('{') ? input : readFileSync(resolveConfigFile(input), 'utf8');
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('模板配置必须是 JSON object');
    }
    return value as Record<string, unknown>;
  } catch (err) {
    throw new Error(`--config 必须是合法 JSON object：${(err as Error).message}`);
  }
}

function loadParametrizeOptions(input: string | undefined): RecordedParametrizeOptions | undefined {
  if (!input) return undefined;
  const value = parseConfigInput(input);
  const result: RecordedParametrizeOptions = {};
  if (value.forms !== undefined) {
    if (!isStringRecord(value.forms)) throw new Error('--parametrize.forms 必须是 nodeId 到变量名的映射');
    result.forms = value.forms;
  }
  if (value.upload !== undefined) {
    if (!isStringRecord(value.upload)) throw new Error('--parametrize.upload 必须是 nodeId 到变量名的映射');
    result.upload = value.upload;
  }
  if (!result.forms && !result.upload) {
    throw new Error('--parametrize 至少需要 forms 或 upload 映射');
  }
  return result;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string' && item.trim() !== '');
}

function resolveConfigFile(file: string): string {
  if (!existsSync(file)) {
    throw new Error(`找不到模板配置文件：${file}`);
  }
  return file;
}

function applyAssignment(config: Record<string, unknown>, assignment: string): void {
  const eq = assignment.indexOf('=');
  if (eq <= 0) {
    throw new Error(`--set 必须是 key=value 格式：${assignment}`);
  }
  const key = assignment.slice(0, eq).trim();
  if (!key || key.includes('.')) {
    throw new Error(`--set 只支持顶层字段名：${assignment}`);
  }
  config[key] = parseConfigValue(assignment.slice(eq + 1));
}

function parseConfigValue(raw: string): unknown {
  const value = raw.trim();
  if (value === '') return '';
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(value) || /^[\[{"]/.test(value)) {
    return JSON.parse(value);
  }
  return raw;
}

function reportIssues(issues: ReturnType<typeof lintWorkflow>): void {
  for (const i of issues) {
    const tag = i.severity === 'error' ? '✖' : '⚠';
    const where = i.nodeId ? ` [${i.nodeId}]` : '';
    console.log(`${tag} [${i.rule}]${where} ${i.message}`);
  }
}

function printRecordingDiagnostics(analysis: ReturnType<typeof analyzeRecordedWorkflow>): void {
  console.log(`录制噪音：${analysis.noise.length}`);
  for (const item of analysis.noise) {
    console.log(`  - [${item.id}] ${item.label}: ${item.reason}`);
  }

  console.log(`录制缺陷：${analysis.defects.length}`);
  for (const item of analysis.defects) {
    const click = item.clickId ? ` click=${item.clickId}` : '';
    const press = item.pressGroupId ? ` pressGroup=${item.pressGroupId}` : '';
    console.log(`  - [${item.id}] ${item.kind}${click}${press}: ${item.suggestion}`);
    if (item.clickSelector) console.log(`    clickSelector: ${item.clickSelector}`);
  }

  console.log(`硬编码值：${analysis.hardcoded.length}`);
  for (const item of analysis.hardcoded) {
    console.log(`  - [${item.id}] ${item.kind}: ${item.suggestion}`);
    if (item.selector) console.log(`    selector: ${item.selector}`);
    console.log(`    value: ${JSON.stringify(item.value)}`);
  }
}

function printDoctorReport(report: RuntimeDoctorReport): void {
  console.log(`运行前检查：${report.workflowName}`);

  if (report.secrets.length > 0) {
    console.log('\nCredentials 必填：');
    for (const name of report.secrets) {
      console.log(`  - ${name}`);
    }
    console.log('  设置位置：Automa 扩展 -> Storage -> Credentials -> Add credential');
    console.log('  名称必须逐字一致；值不要带多余空格。');
  } else {
    console.log('\nCredentials：未发现 {{secrets@...}} 引用');
  }

  if (report.storageVariables.length > 0) {
    console.log('\nStorage Variables 必填：');
    for (const name of report.storageVariables) {
      console.log(`  - ${name}`);
    }
    console.log('  设置位置：Automa 扩展 -> Storage -> Variables');
    console.log('  名称必须逐字一致，$$ 前缀不能省略；认证值不能为空。');
  } else if (report.dynamicVariableReadNodes.length === 0) {
    console.log('\nStorage Variables：未发现 $$ 持久变量引用');
  }
  if (report.dynamicVariableReadNodes.length > 0) {
    console.log('\nStorage Variables 动态引用（无法静态列全）：');
    for (const id of report.dynamicVariableReadNodes) console.log(`  - ${id}`);
    console.log('  请检查节点中拼接出的每个变量名；新建生产 JSON 应使用字面量读取。');
  }

  if (report.inlineSensitiveGlobalData.length > 0) {
    console.log('\nglobalData 内嵌敏感值（值已隐藏）：');
    for (const name of report.inlineSensitiveGlobalData) console.log(`  - ${name}`);
    console.log('  不要转发此 JSON；请改用目标端 Storage，并轮换已经暴露的凭据。');
  }

  console.log('\n通知能力：');
  if (report.notificationBlocks.length > 0) {
    console.log('  × 发现 notification block，当前交付环境不建议使用：');
    for (const block of report.notificationBlocks) {
      const title = block.title ? ` title=${block.title}` : '';
      console.log(`    - ${block.id}${title}`);
    }
  } else {
    console.log('  ✔ 未发现 notification block');
  }
  console.log(
    `  ${report.workflowNotificationEnabled ? '⚠' : '✔'} settings.notification=${
      report.workflowNotificationEnabled ? 'true，建议改为 false' : 'false'
    }`
  );

  if (report.uploads.length > 0) {
    console.log('\n文件上传：');
    for (const upload of report.uploads) {
      console.log(`  - ${upload.id} selector=${upload.selector ?? '(空)'}`);
      for (const path of upload.filePaths) console.log(`    path: ${path}`);
    }
  }

  if (report.attachmentDownloads.length > 0) {
    console.log('\n附件下载：');
    for (const item of report.attachmentDownloads) {
      const status = !item.base64ContextValid
        ? '× base64 上下文不支持'
        : item.risky
          ? '⚠ 需调整'
          : '✔ website 上下文的 base64 获取';
      console.log(`  - ${item.id} context=${item.context ?? '(未知)'} ${status}`);
      if (item.directFetch) console.log('    发现直接 fetch 附件 URL');
      if (item.usesAutomaFetchBase64) console.log("    发现 automaFetch('base64', ...) 用法");
    }
  }

  if (report.hints.length > 0) {
    console.log('\n常见失败定位：');
    for (const hint of report.hints) console.log(`  - ${hint}`);
  }
}

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`× ${err.message}`);
  process.exit(1);
});
