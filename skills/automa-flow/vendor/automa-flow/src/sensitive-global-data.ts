import type { AutomaWorkflowJson } from './types.js';

const SENSITIVE_NAMES = [
  'secret',
  'password',
  'passwd',
  'token',
  'apikey',
  'privatekey',
  'clientsecret',
];

export function collectSensitiveGlobalDataKeys(json: AutomaWorkflowJson): string[] {
  let globals: unknown = json.globalData;
  if (typeof globals === 'string') {
    try {
      globals = JSON.parse(globals);
    } catch {
      return [];
    }
  }
  if (!globals || typeof globals !== 'object' || Array.isArray(globals)) return [];

  const found = new Set<string>();
  const visit = (value: unknown, path: string[]): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const nextPath = [...path, key];
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const populated =
        (typeof item === 'string' && item.trim() !== '') ||
        (typeof item !== 'string' && item != null && typeof item !== 'object');
      if (populated && SENSITIVE_NAMES.some((name) => normalized.includes(name))) {
        found.add(nextPath.join('.'));
      }
      visit(item, nextPath);
    }
  };
  visit(globals, []);
  return [...found].sort();
}
