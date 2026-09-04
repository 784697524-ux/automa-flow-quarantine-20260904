/**
 * @ali/aitable-workflow-automa-flow
 *
 * Automa 工作流离线生成器：块注册表（事实源提取自 automa 源码）+
 * WorkflowBuilder + 图结构 lint + 场景模板。产物为可直接导入 Automa
 * 扩展的 .automa.json。
 */
export * from './types.js';
export * from './id.js';
export * from './registry.js';
export * from './templating.js';
export {
  WorkflowBuilder,
  type WorkflowBuilderOptions,
  type AddBlockOptions,
  type ConnectOptions,
  type ConditionOptions,
} from './builder/builder.js';
export { lintWorkflow } from './lint/lint.js';
export {
  inspectRuntimePrerequisites,
  type RuntimeDoctorReport,
} from './doctor.js';
export {
  buildXhsPublish,
  type XhsPublishTemplateOptions,
} from './templates/xhs-publish.js';
export {
  buildDouyinPublish,
  type DouyinPublishTemplateOptions,
} from './templates/douyin-publish.js';
