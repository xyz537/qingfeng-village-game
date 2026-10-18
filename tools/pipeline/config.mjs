// Local, secret-free controller configuration.
// Configuration carries no credentials: secrets are read at call time from an
// external credential command's stdout and injected only where required.
import fs from 'node:fs';
import path from 'node:path';

const RESERVED_BRANCHES = new Set(['main', 'master', 'trunk', 'head', 'develop', 'release']);

const TOO_SECRET_KEY = /(token|secret|password|passwd|credentialvalue|apikey|api_key|private_key|authorization|bearer|cookie|passphrase)/i;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function fail(message) {
  throw new ConfigError(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, name) {
  if (!isPlainObject(value)) fail(`${name} must be an object`);
  return value;
}

function requireString(value, name, { pattern, min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  if (value.length < min || value.length > max) fail(`${name} must be ${min}..${max} characters`);
  if (pattern && !pattern.test(value)) fail(`${name} has an invalid shape`);
  return value;
}

function requireInt(value, name, { min, max } = {}) {
  if (!Number.isInteger(value)) fail(`${name} must be an integer`);
  if (min !== undefined && value < min) fail(`${name} must be >= ${min}`);
  if (max !== undefined && value > max) fail(`${name} must be <= ${max}`);
  return value;
}

function requireAbsolute(value, name) {
  requireString(value, name, { max: 500 });
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute local path`);
  return path.resolve(value);
}

function requireCommand(value, name) {
  const obj = requireObject(value, name);
  requireString(obj.command, `${name}.command`, { max: 240 });
  if (obj.command.includes('/') || obj.command.includes('\\')) {
    // Absolute executables are allowed, relative ones would be PATH-relative.
    if (!path.isAbsolute(obj.command)) fail(`${name}.command must be an executable name or absolute path`);
  }
  const args = obj.args ?? [];
  if (!Array.isArray(args)) fail(`${name}.args must be an array`);
  for (const arg of args) {
    if (typeof arg !== 'string') fail(`${name}.args entries must be strings`);
    if (/[\r\n]/.test(arg)) fail(`${name}.args entries must be single-line`);
    // A credential command is executed with shell:false; keep its arguments
    // strictly literal so nothing can be reinterpreted as shell syntax.
    if (!/^[A-Za-z0-9._:@/\\-]+$/.test(arg)) {
      fail(`${name}.args entries must be plain literal tokens (no spaces, quotes or shell metacharacters)`);
    }
  }
  return { command: obj.command, args: [...args] };
}

function requireBranchName(value, name) {
  requireString(value, name, { pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/, max: 200 });
  const normalized = value.replace(/^refs\/heads\//, '');
  if (RESERVED_BRANCHES.has(normalized.toLowerCase())) fail(`${name} must not be a shared/reserved branch`);
  if (normalized.startsWith('automation/')) fail(`${name} must not be an automation ref`);
  return value;
}

function assertNoSecretKeys(node, trail = 'config') {
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase();
    if (TOO_SECRET_KEY.test(lower)) {
      fail(`forbidden secret-looking key "${trail}.${key}": configuration must not carry credentials`);
    }
    if (isPlainObject(value)) assertNoSecretKeys(value, `${trail}.${key}`);
  }
}

function requireTimeouts(value, name) {
  const obj = requireObject(value, name);
  const keys = ['dshMs', 'reviewMs', 'testMs', 'commandMs', 'gitMs'];
  const out = {};
  for (const key of keys) {
    if (obj[key] === undefined) fail(`${name}.${key} is required`);
    out[key] = requireInt(obj[key], `${name}.${key}`, { min: 1000, max: 6 * 60 * 60 * 1000 });
  }
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) fail(`${name}.${key} is not a supported timeout`);
  }
  return out;
}

/**
 * Load and strictly validate the local controller configuration.
 * Throws ConfigError with a precise message; never returns a partially valid config.
 */
export function loadLocalConfig(configPath) {
  const file = path.resolve(configPath);
  if (!fs.existsSync(file)) fail(`config file not found: ${file}`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`config file cannot be read: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`config is not valid JSON: ${err.message}`);
  }
  return normalizeConfig(parsed);
}

/** Validate an already-parsed configuration object. */
export function normalizeConfig(parsed) {
  const root = requireObject(parsed, 'config');
  const known = new Set([
    'schemaVersion', 'workerId', 'approvedUsers', 'repository', 'repositoryUrl', 'baseRef', 'workspaceRoot',
    'logsDir', 'concurrentTasks', 'timeouts', 'maxFixRetries', 'github', 'dsh', 'review',
  ]);
  for (const key of Object.keys(root)) {
    if (!known.has(key)) fail(`unknown top-level config field "${key}"`);
  }
  assertNoSecretKeys(root);

  if (root.schemaVersion !== 1) fail('schemaVersion must be 1');
  const workerId = requireString(root.workerId, 'workerId', { pattern: /^[a-z0-9][a-z0-9._-]{1,63}$/, max: 64 });
  if (!Array.isArray(root.approvedUsers) || root.approvedUsers.length === 0) fail('approvedUsers must be a non-empty array');
  const approvedUsers = root.approvedUsers.map((entry, i) => requireString(entry, `approvedUsers[${i}]`, { pattern: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/ }));
  const repository = requireString(root.repository, 'repository', { pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ });
  const repositoryUrl = root.repositoryUrl === undefined
    ? `https://github.com/${repository}.git`
    : requireString(root.repositoryUrl, 'repositoryUrl', { pattern: /^(https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+|ssh:\/\/[^\s]+|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+)$/, max: 400 });
  const baseRef = requireBranchName(root.baseRef, 'baseRef');
  requireString(root.baseRef, 'baseRef');
  const workspaceRoot = requireAbsolute(root.workspaceRoot, 'workspaceRoot');
  const logsDir = requireAbsolute(root.logsDir, 'logsDir');
  if (root.concurrentTasks !== 1) fail('concurrentTasks must be 1: one task at a time per machine');
  if (root.maxFixRetries !== 2) fail('maxFixRetries must be exactly 2');
  const maxFixRetries = requireInt(root.maxFixRetries, 'maxFixRetries', { min: 2, max: 2 });
  const timeouts = requireTimeouts(root.timeouts, 'timeouts');

  const githubRaw = requireObject(root.github, 'github');
  const refPrefixRaw = requireString(githubRaw.refPrefix ?? 'refs/heads/automation/claim', 'github.refPrefix');
  const refPrefix = refPrefixRaw.replace(/\/+$/, '');
  if (!refPrefix.startsWith('refs/heads/automation/')) fail('github.refPrefix must live under refs/heads/automation/');
  const logRef = requireString(githubRaw.logRef ?? 'refs/heads/automation/logs', 'github.logRef');
  if (!logRef.startsWith('refs/heads/automation/')) fail('github.logRef must live under refs/heads/automation/');
  const github = {
    credentialCommand: requireCommand(githubRaw.credentialCommand, 'github.credentialCommand'),
    refPrefix,
    logRef,
  };

  const dshRaw = requireObject(root.dsh, 'dsh');
  const dshPermissionMode = dshRaw.permissionMode === undefined
    ? 'workspace-write'
    : requireString(dshRaw.permissionMode, 'dsh.permissionMode', { pattern: /^[a-z-]+$/, max: 40 });
  if (dshPermissionMode === 'danger-full-access') {
    fail('dsh.permissionMode must never be danger-full-access');
  }
  if (!['workspace-write', 'read-only'].includes(dshPermissionMode)) {
    fail('dsh.permissionMode must be workspace-write or read-only');
  }
  const dsh = {
    profile: requireString(dshRaw.profile, 'dsh.profile', { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, max: 80 }),
    executable: requireAbsolute(dshRaw.executable, 'dsh.executable'),
    cliEntry: requireAbsolute(dshRaw.cliEntry, 'dsh.cliEntry'),
    modelKeyEnvName: requireString(dshRaw.modelKeyEnvName, 'dsh.modelKeyEnvName', { pattern: /^[A-Z][A-Z0-9_]*$/ }),
    credentialCommand: requireCommand(dshRaw.credentialCommand, 'dsh.credentialCommand'),
    permissionMode: dshPermissionMode,
    args: Array.isArray(dshRaw.args) ? dshRaw.args.map((a, i) => requireString(a, `dsh.args[${i}]`)) : [],
  };

  const reviewRaw = requireObject(root.review, 'review');
  const commands = Array.isArray(reviewRaw.commands) ? reviewRaw.commands : [];
  if (commands.length === 0) fail('review.commands must be a non-empty array');
  const review = {
    profile: requireString(reviewRaw.profile, 'review.profile', { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, max: 80 }),
    executable: requireAbsolute(reviewRaw.executable, 'review.executable'),
    // A native Codex executable (codex.exe) needs no CLI wrapper entry; the
    // optional entry supports an Electron-hosted launcher when one is used.
    cliEntry: reviewRaw.cliEntry === undefined || reviewRaw.cliEntry === null
      ? null
      : requireAbsolute(reviewRaw.cliEntry, 'review.cliEntry'),
    outputSchemaPath: requireAbsolute(reviewRaw.outputSchemaPath ?? path.join(process.cwd(), 'tools', 'pipeline', 'schemas', 'review.schema.json'), 'review.outputSchemaPath'),
    commands: commands.map((entry, i) => requireCommand(entry, `review.commands[${i}]`)),
    args: Array.isArray(reviewRaw.args) ? reviewRaw.args.map((a, i) => requireString(a, `review.args[${i}]`)) : [],
  };

  return Object.freeze({
    schemaVersion: 1,
    workerId,
    approvedUsers: Object.freeze(approvedUsers),
    repository,
    repositoryUrl,
    baseRef,
    workspaceRoot,
    logsDir,
    concurrentTasks: 1,
    timeouts: Object.freeze(timeouts),
    maxFixRetries,
    github: Object.freeze(github),
    dsh: Object.freeze(dsh),
    review: Object.freeze(review),
  });
}

export { ConfigError, RESERVED_BRANCHES };
