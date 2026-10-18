// Command line entry point: doctor, run --issue N, status --issue N,
// export-logs --issue N.
//
// Adapters are injected, so the whole state machine can be driven
// deterministically in tests while the CLI itself performs no network or model
// call of its own.
import fs from 'node:fs';
import path from 'node:path';

import { loadLocalConfig } from './config.mjs';
import { runTask, loadState } from './runner.mjs';
import { createLogStore } from './logs.mjs';
import { createGithubAdapter } from './github.mjs';
import { createWorkspaceManager, createReviewWorkspaceManager } from './workspaces.mjs';
import { createDshAdapter } from './dsh.mjs';
import { createReviewAdapter } from './review.mjs';
import { createPublishAdapter, assertAutomationRef } from './publish.mjs';
import { createTestRunner } from './runner.mjs';
import { runProcess } from './runcmd.mjs';
import { templatePath } from './prompts.mjs';

export const COMMANDS = Object.freeze(['doctor', 'run', 'status', 'export-logs']);

const USAGE = [
  'usage: node tools/pipeline/cli.mjs <command> [--issue N] [--config PATH]',
  '',
  'commands:',
  '  doctor                    check local configuration and executables',
  '  run --issue N             run the task state machine for issue N',
  '  status --issue N          print the persisted local state for issue N',
  '  export-logs --issue N     write a redacted local log export for issue N',
  '',
  'options:',
  '  --issue N                 GitHub issue number (positive integer)',
  '  --config PATH             local controller config (default .pipeline/config.json)',
  '  --export-dir PATH         export target for export-logs',
  '  --help                    print this message',
].join('\n');

function usageError(message) {
  const err = new Error(message);
  err.code = 'USAGE';
  return err;
}

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? null;
  const options = { issue: null, config: null, exportDir: null, help: false, unknown: [] };
  for (let i = 0; i < args.length; i += 1) {
    const entry = args[i];
    if (entry === '--issue' || entry === '-n') {
      const value = args[i + 1];
      if (value === undefined) throw usageError('--issue requires a value');
      if (!/^[0-9]+$/.test(value)) throw usageError('--issue must be a positive integer');
      options.issue = Number.parseInt(value, 10);
      i += 1;
      continue;
    }
    if (entry.startsWith('--issue=')) {
      const value = entry.slice('--issue='.length);
      if (!/^[0-9]+$/.test(value)) throw usageError('--issue must be a positive integer');
      options.issue = Number.parseInt(value, 10);
      continue;
    }
    if (entry === '--config' || entry === '-c') {
      const value = args[i + 1];
      if (value === undefined) throw usageError('--config requires a path');
      options.config = value;
      i += 1;
      continue;
    }
    if (entry.startsWith('--config=')) {
      options.config = entry.slice('--config='.length);
      continue;
    }
    if (entry === '--export-dir') {
      const value = args[i + 1];
      if (value === undefined) throw usageError('--export-dir requires a path');
      options.exportDir = value;
      i += 1;
      continue;
    }
    if (entry === '--help' || entry === '-h') {
      options.help = true;
      continue;
    }
    options.unknown.push(entry);
  }
  if (options.issue !== null && (!Number.isInteger(options.issue) || options.issue < 1)) {
    throw usageError('--issue must be a positive integer');
  }
  return { command, options };
}

/** Build the real adapters. Only the CLI does this; tests inject their own. */
export function createDefaultAdapters({ config, env = process.env, run, spawn } = {}) {
  const github = createGithubAdapter({ config, env, run });
  const workspaces = createWorkspaceManager({ config });
  // The reviewer gets its own detached read-only clone, never the writer's tree.
  const reviewWorkspaces = createReviewWorkspaceManager({ config });
  const dsh = createDshAdapter({ config, env, run, spawn });
  const tests = createTestRunner({ config, env, run });
  const review = createReviewAdapter({ config, workspaceManager: reviewWorkspaces, run, env });
  const publish = createPublishAdapter({ config, github, env, run });
  return { github, workspaces, reviewWorkspaces, dsh, tests, review, publish };
}

function shallowMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

function check(name, ok, status, detail) {
  return { name, ok, status, detail };
}

function fileCheck(name, target) {
  const exists = fs.existsSync(target);
  return exists
    ? check(name, true, 'ok', target)
    : check(name, false, 'failed', `missing: ${target}`);
}

/**
 * An entry inside an Electron ASAR archive (`.../app.asar/...`) is virtual:
 * ordinary Node `fs.existsSync` can never traverse it, so file existence alone
 * proves nothing about it in either direction. The entry is decided by the
 * exact `<executable> --expose-internals <entry> --version` probe instead:
 *   probe ok          -> the executable resolved the entry: report ok
 *   probe failed      -> the entry is genuinely unusable: report failed
 *   no probe/timedout -> honestly unverified/blocked, never "ok"
 */
const ASAR_ENTRY = /\.asar[\\/]/i;

export function isAsarEntry(target) {
  return typeof target === 'string' && ASAR_ENTRY.test(target);
}

function asarEntryCheck(name, target, probe) {
  if (!probe) return check(name, false, 'unverified', `cannot verify ASAR entry without an executable probe: ${target}`);
  if (probe.ok) return check(name, true, 'ok', `inside ASAR, resolved by the executable probe: ${target}`);
  if (probe.status === 'blocked') return check(name, false, 'blocked', `ASAR entry probe timed out: ${target}`);
  if (probe.status === 'unverified') return check(name, false, 'unverified', `ASAR entry not probed: ${target}`);
  return check(name, false, 'failed', `ASAR entry was not resolvable by the executable probe: ${target}`);
}

/** Verify a launcher entry file, correctly handling a virtual ASAR entry. */
function entryCheck(name, target, probe) {
  if (fs.existsSync(target)) return check(name, true, 'ok', target);
  if (isAsarEntry(target)) return asarEntryCheck(name, target, probe);
  return check(name, false, 'failed', `missing: ${target}`);
}

async function executableCheck({ name, target, args = [], run, env, extraEnv = {} }) {
  const exists = fs.existsSync(target);
  if (!exists) return check(name, false, 'failed', `missing: ${target}`);
  if (typeof run !== 'function') {
    // File existence alone is not proof that the tool works.
    return check(name, false, 'unverified', `exists but not probed: ${target}`);
  }
  try {
    const result = await run({
      command: target,
      args,
      env: { ...env, ...extraEnv },
      timeoutMs: 30000,
    });
    const line = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    if (result.status === 0) return check(name, true, 'ok', line.slice(0, 200) || target);
    if (result.timedOut) return check(name, false, 'blocked', `timed out: ${target}`);
    return check(name, false, 'failed', `exit ${result.status}: ${line.slice(0, 200)}`);
  } catch (err) {
    return check(name, false, 'failed', err.message);
  }
}

async function commandDoctor({ configPath, adapters, stdout, stderr, run, env }) {
  const checks = [];
  const runner = typeof run === 'function' ? run : runProcess;
  let config = null;
  try {
    config = loadLocalConfig(configPath);
    checks.push(check('config', true, 'ok', path.resolve(configPath)));
  } catch (err) {
    checks.push(check('config', false, 'failed', err.message));
  }
  if (config) {
    for (const [name, target] of [
      ['workspace-root', config.workspaceRoot],
      ['logs-dir', config.logsDir],
    ]) {
      try {
        fs.mkdirSync(target, { recursive: true });
        checks.push(check(name, true, 'ok', target));
      } catch (err) {
        checks.push(check(name, false, 'failed', err.message));
      }
    }
    for (const template of ['implement', 'review']) {
      const target = templatePath(template);
      checks.push(fileCheck(`template-${template}`, target));
    }
    const dshEnv = { ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: config.dsh.permissionMode };
    const dshProbe = await executableCheck({
      name: 'dsh-executable',
      target: config.dsh.executable,
      args: ['--expose-internals', config.dsh.cliEntry, '--version'],
      run: runner,
      env,
      extraEnv: dshEnv,
    });
    checks.push(dshProbe);
    // The exact `--expose-internals <entry> --version` probe above already
    // proved whether the executable resolved the entry; for a virtual ASAR
    // entry that probe is the authority, not fs.existsSync.
    checks.push(entryCheck('dsh-cli-entry', config.dsh.cliEntry, dshProbe));
    const reviewProbe = await executableCheck({
      name: 'review-executable',
      target: config.review.executable,
      args: [...(config.review.cliEntry ? [config.review.cliEntry] : []), '--version'],
      run: runner,
      env,
    });
    checks.push(reviewProbe);
    if (config.review.cliEntry) checks.push(entryCheck('review-cli-entry', config.review.cliEntry, reviewProbe));
    checks.push(fileCheck('review-output-schema', config.review.outputSchemaPath));

    let github = adapters?.github ?? null;
    if (!github && typeof runner === 'function') {
      try {
        github = createGithubAdapter({ config, run: runner, env });
      } catch (err) {
        checks.push(check('github', false, 'failed', err.message));
      }
    }
    if (github && typeof github.probe === 'function') {
      try {
        const probe = await github.probe();
        checks.push(check('github', true, 'ok', probe?.login ?? 'authenticated'));
      } catch (err) {
        checks.push(check('github', false, 'failed', err.message));
      }
    } else if (!checks.some((entry) => entry.name === 'github')) {
      checks.push(check('github', false, 'unverified', 'no GitHub adapter available to authenticate against'));
    }
  }
  const ok = checks.every((entry) => entry.ok);
  stdout(JSON.stringify({ schemaVersion: 1, command: 'doctor', ok, checks }));
  if (!ok && stderr) stderr('doctor found failing or unverified checks');
  return ok ? 0 : 1;
}

async function commandRun({ configPath, issue, adapters, stdout, stderr }) {
  if (!issue) throw usageError('run requires --issue N');
  const fileConfig = loadLocalConfig(configPath);
  const config = adapters?.config ? shallowMerge(fileConfig, adapters.config) : fileConfig;
  const deps = { ...adapters, config };
  if (!deps.github || !deps.workspaces || !deps.dsh || !deps.tests || !deps.review || !deps.publish) {
    Object.assign(deps, createDefaultAdapters({ config }));
    deps.config = config;
  }
  const logs = deps.logs ?? createLogStore({ dir: config.logsDir, machineRoots: [config.workspaceRoot, config.logsDir] });
  const result = await runTask(issue, { ...deps, logs });
  stdout(JSON.stringify({
    schemaVersion: 1,
    command: 'run',
    issueNumber: result.issueNumber,
    status: result.status,
    reason: result.reason ?? null,
    attempt: result.attempt ?? 0,
    fixRetries: result.fixRetries ?? 0,
    headSha: result.headSha ?? null,
    pull: result.pull ?? null,
    specDigest: result.specDigest ?? null,
  }));
  const ok = result.status === 'awaiting-merge';
  if (!ok && stderr) stderr(`run finished with ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  return ok ? 0 : 1;
}

async function commandStatus({ configPath, issue, stdout }) {
  if (!issue) throw usageError('status requires --issue N');
  const config = loadLocalConfig(configPath);
  const state = loadState(config, issue);
  stdout(JSON.stringify({ schemaVersion: 1, command: 'status', issueNumber: issue, ...state }));
  return 0;
}

async function commandExportLogs({ configPath, issue, exportDir, stdout }) {
  if (!issue) throw usageError('export-logs requires --issue N');
  const config = loadLocalConfig(configPath);
  const store = createLogStore({ dir: config.logsDir, machineRoots: [config.workspaceRoot, config.logsDir] });
  const target = exportDir ?? store.exportDirFor(issue);
  const exportPath = await store.exportIssue(issue, target);
  const summary = (await store.summary(issue)) ?? {};
  const logsRef = config.github.logRef;
  assertAutomationRef(logsRef);
  stdout(JSON.stringify({
    schemaVersion: 1,
    command: 'export-logs',
    issueNumber: issue,
    exportPath,
    status: summary.status ?? null,
    specDigest: summary.specDigest ?? null,
    headSha: summary.headSha ?? null,
    logsRef,
    shared: false,
    note: 'export contains only redacted data and has not been uploaded; the publisher does that separately',
  }));
  return 0;
}

export function createCli({ configPath = path.join(process.cwd(), '.pipeline', 'config.json'), deps = {} } = {}) {
  return {
    commands: [...COMMANDS],
    configPath,
    deps,
    usage: USAGE,
  };
}

/** Run the CLI. Returns the process exit code; never throws for expected cases. */
export async function runCli(argv, { configPath, deps = {}, stdout = (line) => process.stdout.write(`${line}\n`), stderr = (line) => process.stderr.write(`${line}\n`) } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr(USAGE);
    stderr(`error: ${err.message}`);
    return 2;
  }
  const { command, options } = parsed;
  if (options.help || command === null) {
    stdout(USAGE);
    return command === null && !options.help ? 2 : 0;
  }
  if (!COMMANDS.includes(command)) {
    stderr(USAGE);
    stderr(`error: unknown command "${command}"`);
    return 2;
  }
  if (options.unknown.length > 0) {
    stderr(USAGE);
    stderr(`error: unexpected argument(s): ${options.unknown.join(' ')}`);
    return 2;
  }
  const resolvedConfigPath = options.config ?? configPath ?? path.join(process.cwd(), '.pipeline', 'config.json');
  const context = { configPath: resolvedConfigPath, issue: options.issue, exportDir: options.exportDir, adapters: deps, stdout, stderr, run: deps.run, env: deps.env };
  try {
    switch (command) {
      case 'doctor':
        return await commandDoctor(context);
      case 'run':
        return await commandRun(context);
      case 'status':
        return await commandStatus(context);
      case 'export-logs':
        return await commandExportLogs(context);
      default:
        stderr(USAGE);
        return 2;
    }
  } catch (err) {
    if (err.code === 'USAGE') {
      stderr(USAGE);
      stderr(`error: ${err.message}`);
      return 2;
    }
    stderr(`error: ${err.message}`);
    stdout(JSON.stringify({ schemaVersion: 1, command, ok: false, error: err.message }));
    return 1;
  }
}

export { USAGE, usageError, entryCheck };

// Direct invocation: `node tools/pipeline/cli.mjs <command> ...`
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return normalize(path.resolve(entry)) === normalize(path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
})();

if (invokedDirectly) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
