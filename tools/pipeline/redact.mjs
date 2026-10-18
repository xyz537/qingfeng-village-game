// Redaction helpers. Every log write and every export goes through here.
// The pipeline must never persist credentials, auth headers or machine paths.
import os from 'node:os';
import path from 'node:path';

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|authorization|auth[_-]?header|bearer|cookie)/i;

const VALUE_PATTERNS = [
  // Authorization headers of any flavour.
  [/\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer|token|basic)?\s*[^\s,;"']+/gi, 'Authorization: <redacted>'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  // GitHub tokens (classic + fine grained + app tokens).
  [/\b(gh[pousr])_[A-Za-z0-9_]{6,}\b/g, '<redacted-github-token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '<redacted-github-token>'],
  // Provider API keys.
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted-api-key>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, '<redacted-api-key>'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '<redacted-api-key>'],
  // key=value / key: value pairs whose key looks secret.
  [/((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|credential)\s*["']?\s*[:=]\s*["']?)([^\s,;"'}\]]+)/gi, '$1<redacted>'],
];

/**
 * Redact secrets and machine-local absolute paths from an arbitrary string.
 * `secrets` are exact values that must never survive, regardless of shape.
 */
export function redactText(input, { secrets = [], machineRoots = [], home = os.homedir() } = {}) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let text = input;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      text = text.split(secret).join('<redacted>');
    }
  }
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  const roots = [];
  if (home) roots.push(home);
  for (const root of machineRoots) {
    if (typeof root === 'string' && root.length > 0) roots.push(root);
  }
  // Longest first so a nested path collapses to the most specific placeholder.
  roots.sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const placeholder = root === home ? '<home>' : '<machine-path>';
    for (const variant of [root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')]) {
      text = text.split(variant).join(placeholder);
    }
  }
  // Any remaining drive-letter absolute path on Windows.
  text = text.replace(/\b[A-Za-z]:\\(?:[^\\\s:"'<>|?*]+\\?)+/g, (match) => (match.includes('<') ? match : '<machine-path>'));
  // Any remaining /home/<user> or /Users/<user> path on POSIX.
  text = text.replace(/\/(?:home|Users)\/[^/\s]+(?:\/[^\s]*)?/g, '<machine-path>');
  return text;
}

/** Deep-redact a JSON-ish structure by key name and by value shape. */
export function redactObject(value, options = {}) {
  const secrets = options.secrets ?? [];
  const seen = new WeakSet();
  const walk = (node, depth) => {
    if (depth > 12) return '<depth-limit>';
    if (typeof node === 'string') return redactText(node, options);
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    if (seen.has(node)) return '<cycle>';
    seen.add(node);
    const out = {};
    for (const [key, entry] of Object.entries(node)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = '<redacted>';
        continue;
      }
      out[key] = walk(entry, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** True when the raw value still looks like it carries a credential. */
export function looksSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  for (const [pattern] of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

/** Canonical key for a filesystem path: realpath when it exists, else lexical. */
export async function canonicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return await (await import('node:fs/promises')).realpath(resolved);
  } catch {
    return resolved;
  }
}

/** Case-insensitive on Windows, exact elsewhere. */
export function pathKey(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Deterministic lock file location for a canonical workspace directory. */
export function lockPathFor(dir) {
  const key = pathKey(dir);
  let hash = 0n;
  for (const ch of key) hash = (hash * 131n + BigInt(ch.codePointAt(0))) % 340282366920938463463374607431768211297n;
  return path.join(os.tmpdir(), 'qingfeng-pipeline-locks', `${hash.toString(16)}.lock`);
}

export { SECRET_KEY_PATTERN };
