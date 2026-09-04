import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowBuilder } from '../src/builder/builder.js';
import type { AutomaWorkflowJson } from '../src/types.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, 'bin', 'automa-flow.mjs');

describe('CLI 录制片段命令', () => {
  it('generate xhs-publish 支持字段映射和录制选择器覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-generate-xhs-'));
    const configFile = join(dir, 'xhs.config.json');
    const outFile = join(dir, 'xhs.automa.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        baseId: 'BASE123',
        sheetId: 'SHEET456',
        statusField: '发布状态',
        pendingValue: '待搭建',
        publishedValue: '已搭建',
        fieldMap: {
          帖子标题: 'postTitle',
          帖子正文: 'postBody',
          图片路径: 'localImage',
        },
        titleVar: 'postTitle',
        bodyVar: 'postBody',
        mediaVar: 'localImage',
        titleSelector: '[data-testid="xhs-title"]',
        bodySelector: '[data-testid="xhs-body"]',
      }),
      'utf8'
    );

    execFileSync('node', [
      bin,
      'generate',
      'xhs-publish',
      '--config',
      configFile,
      '-o',
      outFile,
    ], {
      cwd: root,
      encoding: 'utf8',
    });

    const generated = readFileSync(outFile, 'utf8');
    expect(generated).toContain('notable/bases/BASE123/sheets/SHEET456/records/list');
    expect(generated).toContain('operatorId={{secrets@dingtalkOperatorId}}');
    expect(generated).toContain('发布状态');
    expect(generated).toContain('待搭建');
    expect(generated).toContain('已搭建');
    expect(generated).toContain('帖子标题');
    expect(generated).toContain('帖子正文');
    expect(generated).toContain('图片路径');
    expect(generated).toContain('{{variables@localImage}}');
    expect(generated).toContain('postTitle');
    expect(generated).toContain('postBody');
    expect(generated).toContain('xhs-title');
    expect(generated).toContain('xhs-body');
  });

  it('generate 支持用 --set 做少量顶层配置覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-generate-set-'));
    const outFile = join(dir, 'xhs.automa.json');

    execFileSync('node', [
      bin,
      'generate',
      'xhs-publish',
      '--set',
      'baseId=BASE_SET',
      '--set',
      'sheetId=SHEET_SET',
      '-o',
      outFile,
    ], {
      cwd: root,
      encoding: 'utf8',
    });

    const generated = readFileSync(outFile, 'utf8');
    expect(generated).toContain('notable/bases/BASE_SET/sheets/SHEET_SET/records/list');
  });

  it('doctor 输出 Credentials、通知能力和文件上传检查清单', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-doctor-'));
    const outFile = join(dir, 'xhs.automa.json');

    execFileSync('node', [
      bin,
      'generate',
      'xhs-publish',
      '--set',
      'baseId=BASE_DOCTOR',
      '--set',
      'sheetId=SHEET_DOCTOR',
      '-o',
      outFile,
    ], {
      cwd: root,
      encoding: 'utf8',
    });

    const output = execFileSync('node', [bin, 'doctor', outFile], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(output).toContain('Credentials 必填');
    expect(output).toContain('dingtalkAppKey');
    expect(output).toContain('dingtalkAppSecret');
    expect(output).toContain('dingtalkOperatorId');
    expect(output).toContain('paramError-operatorId');
    expect(output).toContain('未发现 notification block');
    expect(output).toContain('settings.notification=false');
    expect(output).toContain('文件上传');
    expect(output).toContain('{{variables@mediaPath}}');
  });

  it('doctor 输出 AI 表格附件下载风险提示', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-doctor-attachment-'));
    const outFile = join(dir, 'attachment.automa.json');
    const builder = new WorkflowBuilder({ name: 'attachment-risk' });
    const trigger = builder.addBlock('trigger');
    const js = builder.addBlock('javascript-code', {
      data: {
        context: 'website',
        code: "const res = await fetch(attachment.url, { credentials: 'include' });\nconst blob = await res.blob();\nautomaNextBlock();",
      },
    });
    builder.connect(trigger, js);
    writeFileSync(outFile, JSON.stringify(builder.emit()), 'utf8');

    const validateOutput = execFileSync('node', [bin, 'validate', outFile], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(validateOutput).toContain('G11');

    const doctorOutput = execFileSync('node', [bin, 'doctor', outFile], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(doctorOutput).toContain('附件下载');
    expect(doctorOutput).toContain('直接 fetch 附件 URL');
    expect(doctorOutput).toContain("automaFetch('base64'");
    expect(doctorOutput).toContain('Failed to fetch');
  });

  it('doctor 输出 Automa Storage Variables 依赖，不再误报无凭据依赖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-doctor-storage-'));
    const outFile = join(dir, 'storage.automa.json');
    const builder = new WorkflowBuilder({ name: 'storage-auth' });
    const trigger = builder.addBlock('trigger');
    const js = builder.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: `const appId = automaRefData('variables', '$$dd_app_id');
const secret = automaRefData('variables', '$$dd_app_secret');
automaNextBlock({ appId, secret });`,
      },
    });
    builder.connect(trigger, js);
    writeFileSync(outFile, JSON.stringify(builder.emit()), 'utf8');

    const output = execFileSync('node', [bin, 'doctor', outFile], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(output).toContain('Storage Variables 必填');
    expect(output).toContain('$$dd_app_id');
    expect(output).toContain('$$dd_app_secret');
    expect(output).toContain('Storage -> Variables');
  });

  it('doctor 不把动态 Storage Variables 误报为无依赖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-doctor-dynamic-storage-'));
    const outFile = join(dir, 'storage-dynamic.automa.json');
    const builder = new WorkflowBuilder({ name: 'storage-auth-dynamic' });
    const trigger = builder.addBlock('trigger');
    const js = builder.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: `const read = (name) => automaRefData('variables', '$$' + name);
automaNextBlock(read('dd_app_id'));`,
      },
    });
    builder.connect(trigger, js);
    writeFileSync(outFile, JSON.stringify(builder.emit()), 'utf8');

    const output = execFileSync('node', [bin, 'doctor', outFile], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(output).toContain('Storage Variables 动态引用');
    expect(output).not.toContain('Storage Variables：未发现');
  });

  it('validate --production 拦截动态变量和混用认证来源', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-production-validate-'));
    const outFile = join(dir, 'mixed-auth.automa.json');
    const builder = new WorkflowBuilder({ name: 'mixed-auth' });
    const trigger = builder.addBlock('trigger');
    const js = builder.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: `const appId = automaRefData('variables', '$$dd_app_id');
const suffix = 'app_secret';
const secret = automaRefData('variables', '$$dd_' + suffix);
automaNextBlock({ appId, secret });`,
      },
    });
    const hook = builder.addBlock('webhook', {
      data: { url: 'https://x.test/?key={{secrets@dingtalkAppKey}}', timeout: 30000 },
    });
    builder.chain([trigger, js, hook]);
    writeFileSync(outFile, JSON.stringify(builder.emit()), 'utf8');

    const normalOutput = execFileSync('node', [bin, 'validate', outFile], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(normalOutput).toContain('G18');

    const production = spawnSync('node', [bin, 'validate', outFile, '--production'], {
      cwd: root,
      encoding: 'utf8',
    });
    const productionOutput = `${production.stdout}${production.stderr}`;
    expect(production.status).toBe(1);
    expect(productionOutput).toContain('[G18]');
    expect(productionOutput).toContain('[P01]');
  });

  it('validate --production 不误拦截与钉钉认证无关的多服务变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-production-multi-service-'));
    const outFile = join(dir, 'multi-service.automa.json');
    const builder = new WorkflowBuilder({ name: 'multi-service' });
    const trigger = builder.addBlock('trigger');
    const js = builder.addBlock('javascript-code', {
      data: {
        context: 'background',
        code: "const setting = automaRefData('variables', '$$feature_switch'); automaNextBlock(setting);",
      },
    });
    const hook = builder.addBlock('webhook', {
      data: { url: 'https://payments.test/?key={{secrets@paymentToken}}', timeout: 30000 },
    });
    builder.chain([trigger, js, hook]);
    writeFileSync(outFile, JSON.stringify(builder.emit()), 'utf8');

    const production = spawnSync('node', [bin, 'validate', outFile, '--production'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(production.status).toBe(0);
    expect(`${production.stdout}${production.stderr}`).not.toContain('[P01]');
  });

  it('doctor 脱敏报告 globalData 内嵌凭据，production 阻止继续交付', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-inline-sensitive-'));
    const outFile = join(dir, 'inline-sensitive.automa.json');
    const secretValue = 'must-never-appear-in-doctor-output';
    const builder = new WorkflowBuilder({
      name: 'inline-sensitive',
      globalData: { dd_app_id: 'app-id', dd_app_secret: secretValue, ordinary: 'ok' },
    });
    builder.addBlock('trigger');
    writeFileSync(outFile, JSON.stringify(builder.emit()), 'utf8');

    const doctorOutput = execFileSync('node', [bin, 'doctor', outFile], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(doctorOutput).toContain('globalData 内嵌敏感值');
    expect(doctorOutput).toContain('dd_app_secret');
    expect(doctorOutput).not.toContain(secretValue);

    const production = spawnSync('node', [bin, 'validate', outFile, '--production'], {
      cwd: root,
      encoding: 'utf8',
    });
    const productionOutput = `${production.stdout}${production.stderr}`;
    expect(production.status).toBe(1);
    expect(productionOutput).toContain('[G19]');
    expect(productionOutput).not.toContain(secretValue);
  });

  it('import --json 输出录制选择器摘要', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-import-'));
    const file = join(dir, 'recorded.automa.json');
    writeFileSync(file, JSON.stringify(recordedFragment()), 'utf8');

    const output = execFileSync('node', [bin, 'import', file, '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    const analysis = JSON.parse(output) as { selectorBlocks: Array<{ selector: string }> };

    expect(analysis.selectorBlocks.map((b) => b.selector)).toEqual([
      '#publish',
      'input.title',
    ]);
  });

  it('import 用于抽取选择器时不因片段 lint error 中断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-import-invalid-'));
    const file = join(dir, 'selector-only.automa.json');
    writeFileSync(file, JSON.stringify(selectorOnlyFragment()), 'utf8');

    const output = execFileSync('node', [bin, 'import', file, '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    const analysis = JSON.parse(output) as {
      selectorBlocks: Array<{ selector: string }>;
      issues: Array<{ rule: string }>;
    };

    expect(analysis.selectorBlocks.map((b) => b.selector)).toEqual(['#only-selector']);
    expect(analysis.issues.some((i) => i.rule === 'G01')).toBe(true);
  });

  it('import --drop-noise --parametrize 写出清噪和变量化后的录制片段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-import-transform-'));
    const file = join(dir, 'recorded.automa.json');
    const outFile = join(dir, 'recorded.transformed.automa.json');
    const builder = new WorkflowBuilder({ name: 'recorded' });
    const trigger = builder.addBlock('trigger', { id: 't' });
    const scroll = builder.addBlock('element-scroll', { id: 'scroll', data: { selector: '' } });
    const fill = builder.addBlock('forms', {
      id: 'fill-title',
      data: { selector: 'input.title', value: '录制标题' },
    });
    const upload = builder.addBlock('upload-file', {
      id: 'upload',
      data: { selector: 'input[type="file"]', filePaths: ['/tmp/lake.jpeg'] },
    });
    builder.chain([trigger, scroll, fill, upload]);
    writeFileSync(file, JSON.stringify(builder.emit()), 'utf8');

    const output = execFileSync('node', [
      bin,
      'import',
      file,
      '--drop-noise',
      '--parametrize',
      '{"forms":{"fill-title":"postTitle"},"upload":{"upload":"mediaPath"}}',
      '-o',
      outFile,
    ], {
      cwd: root,
      encoding: 'utf8',
    });
    const transformed = JSON.parse(readFileSync(outFile, 'utf8')) as AutomaWorkflowJson;

    expect(output).toContain('录制噪音');
    expect(output).toContain('硬编码值');
    expect(output).toContain('已启用 drop-noise');
    expect(transformed.drawflow.nodes.some((item) => item.id === 'scroll')).toBe(false);
    expect(transformed.drawflow.nodes.find((item) => item.id === 'fill-title')?.data.value).toBe(
      '{{variables@postTitle}}'
    );
    expect(transformed.drawflow.nodes.find((item) => item.id === 'upload')?.data.filePaths).toEqual([
      '{{variables@mediaPath}}',
    ]);
    expect(transformed.drawflow.edges.some((edge) => edge.source === 't' && edge.target === 'fill-title')).toBe(true);
  });

  it('merge --after 写出插入录制片段后的工作流', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automa-flow-merge-'));
    const skeletonFile = join(dir, 'skeleton.automa.json');
    const fragmentFile = join(dir, 'recorded.automa.json');
    const outFile = join(dir, 'merged.automa.json');
    writeFileSync(skeletonFile, JSON.stringify(skeleton()), 'utf8');
    writeFileSync(fragmentFile, JSON.stringify(recordedFragment()), 'utf8');

    execFileSync('node', [
      bin,
      'merge',
      skeletonFile,
      fragmentFile,
      '--after',
      'open',
      '-o',
      outFile,
    ], {
      cwd: root,
      encoding: 'utf8',
    });
    const merged = JSON.parse(readFileSync(outFile, 'utf8')) as AutomaWorkflowJson;

    expect(merged.drawflow.nodes.some((n) => n.data.selector === '#publish')).toBe(true);
    expect(merged.drawflow.edges.find((e) => e.source === 'open')?.target).toMatch(/^rec_/);
  });
});

function skeleton(): AutomaWorkflowJson {
  const builder = new WorkflowBuilder({ name: 'skeleton' });
  const trigger = builder.addBlock('trigger', { id: 't' });
  const open = builder.addBlock('new-tab', { id: 'open', data: { url: 'https://x.test' } });
  const writeBack = builder.addBlock('webhook', { id: 'write', data: { url: 'https://api.test' } });
  builder.chain([trigger, open, writeBack]);
  return builder.emit();
}

function recordedFragment(): AutomaWorkflowJson {
  const builder = new WorkflowBuilder({ name: 'recorded' });
  const trigger = builder.addBlock('trigger', { id: 'rt' });
  const click = builder.addBlock('event-click', {
    id: 'click',
    data: { description: '点击发布', selector: '#publish', waitForSelector: true },
  });
  const fill = builder.addBlock('forms', {
    id: 'fill',
    data: { description: '填标题', selector: 'input.title', value: '录制标题' },
  });
  builder.chain([trigger, click, fill]);
  return builder.emit();
}

function selectorOnlyFragment(): AutomaWorkflowJson {
  return {
    extVersion: '1.30.00',
    name: 'selector-only',
    icon: 'riGlobalLine',
    table: [],
    version: '1.30.00',
    drawflow: {
      nodes: [
        {
          id: 'only',
          label: 'event-click',
          type: 'BlockBasic',
          initialized: false,
          position: { x: 0, y: 0 },
          data: { selector: '#only-selector' },
        },
      ],
      edges: [],
      position: [0, 0],
      zoom: 1,
    },
    settings: { publicId: '' },
    globalData: '{"key":"value"}',
    description: '',
    includedWorkflows: {},
  };
}
