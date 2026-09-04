/**
 * 节点/边 id 生成。
 *
 * Automa 用 nanoid（7 位，`useId` 处 21 位）；引擎与导入链路对 id 格式零校验，
 * 只要求图内唯一。这里用 crypto 实现 nanoid 同字母表的 7 位随机 id，
 * 避免引入 nanoid 依赖，行为与扩展新建节点一致。
 */
import { randomBytes } from 'node:crypto';

const ALPHABET =
  'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

export function genId(size = 7): string {
  const bytes = randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i += 1) {
    id += ALPHABET[(bytes[i] ?? 0) & 63];
  }
  return id;
}
