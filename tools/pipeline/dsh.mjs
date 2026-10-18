// DSH invocation adapter: one implementation session per attempt.
// The model API key is read from a trusted external credential command, kept in
// memory only, injected under an exact env name, and never logged.
//
// Launcher contract verified against the installed DeepSeek Harness 0.2.1-rc.2:
//   "<Electron exe>" --expose-internals "<cli.js>" --profile <name> --json [-]
// The executable runs as Node (ELECTRON_RUN_AS_NODE=1) and the sandbox mode is
// set explicitly (never inherited, never danger-full-access).
import { spawn as nodeSpawn } from 'node:child_process';
import { spawnProcess, killTree, runProcess } from './runcmd.mjs';
import { readCredential } from './github.mjs';
import { redactText } from './redact.mjs';

const KEEP_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL',
  'NODE_OPTIONS',
];

const DROPPED_ENV = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_ENTERPRISE_TOKEN',
  'GITHUB_PAT', 'GITHUB_APP_TOKEN', 'GH_TOKEN_FILE', 'GIT_ASKPASS', 'SSH_AUTH_SOCK',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY',
  'OPENCODE_GO_API_KEY',
];

/** Sandbox modes the controller is ever allowed to request for the DSH child. */
export const DSH_PERMISSION_MODES = Object.freeze(['workspace-write', 'read-only']);
export const DSH_DEFAULT_PERMISSION_MODE = 'workspace-write';

/** Refuse a requested sandbox mode the pipeline must never use. */
export function assertDshPermissionMode(mode) {
  const value = mode ?? DSH_DEFAULT_PERMISSION_MODE;
  if (value === 'danger-full-access') {
    throw new Error('danger-full-access is never allowed for the DSH child');
  }
  if (!DSH_PERMISSION_MODES.includes(value)) {
    throw new Error(`dsh permission mode must be one of ${DSH_PERMISSION_MODES.join(', ')}`);
  }
  return value;
}

/**
 * Build the environment for a child process.
 * role 'dsh'    -> sanitized env plus the model key (never GitHub credentials)
 * role 'review' -> sanitized env only: the review uses its existing local auth
 * role 'test'   -> sanitized env only, no model key
 */
export function buildChildEnv({ role, baseEnv = process.env, modelKeyEnvName, modelKey, extra = {} } = {}) {
  if (role !== 'test' && role !== 'review' && role !== 'dsh') throw new Error(`unknown child env role: ${role}`);
  const env = {};
  for (const key of Object.keys(baseEnv)) {
    if (KEEP_ENV.includes(key)) env[key] = baseEnv[key];
  }
  if (env.PATH === undefined && baseEnv.Path !== undefined) env.PATH = baseEnv.Path;
  // The model key is injected for the implementation child only. Review and
  // test children never receive it, and no child ever receives GitHub tokens.
  if (role === 'dsh' && modelKeyEnvName && modelKey) {
    env[modelKeyEnvName] = modelKey;
  }
  for (const key of DROPPED_ENV) {
    if (key !== modelKeyEnvName || role !== 'dsh') delete env[key];
  }
  return { ...env, ...extra };
}

export function buildDshEnv({ baseEnv = process.env, modelKeyEnvName, modelKey, permissionMode, extra = {} } = {}) {
  if (!modelKeyEnvName) throw new Error('a model key env name is required');
  if (!modelKey) throw new Error('a model key is required to run DSH');
  const mode = assertDshPermissionMode(permissionMode);
  return buildChildEnv({
    role: 'dsh',
    baseEnv,
    modelKeyEnvName,
    modelKey,
    extra: {
      // Explicitly run the Electron binary as Node; never inherit this flag.
      ELECTRON_RUN_AS_NODE: '1',
      // Explicitly pin the sandbox; never inherit and never escalate.
      DSH_PERMISSION_MODE: mode,
      ...extra,
    },
  });
}

export function buildTestEnv({ baseEnv = process.env, extra = {} } = {}) {
  return buildChildEnv({ role: 'test', baseEnv, extra });
}

/** Extract a session id from DSH JSONL, accepting the documented key shapes. */
export function extractSessionId(lines) {
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const candidate = line.session_id ?? line.sessionId ?? line.session?.id ?? line.thread_id ?? line.threadId;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Terminal status of a DSH session, per the real 0.2.1-rc.2 `--json` protocol.
 *
 * A successful headless run emits, in order:
 *   {"type":"session","sessionId":...}
 *   {"type":"status","phase":"turn_start",...}
 *   {"type":"text","text":...}            (assistant output)
 *   {"type":"status","phase":"turn_end","reason":{"kind":"completed"}}
 *   {"type":"final","text":...}
 * and exits 0. The durable terminal is the last `turn_end` reason; a
 * `tool_result` is not a terminal, and a missing `final`/`turn_end`, an error,
 * an abort or an unanswered question is never a completed run. Because the
 * headless runner also prints `final` before exiting 1 on an error turn, exit 0
 * is required as well.
 */
export function extractFinalStatus(lines, { exitCode } = {}) {
  let turnEndReason = null;
  let sawFinal = false;
  let sawErrorEvent = false;
  let errorMessage = null;
  let sawQuestion = false;
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const type = line.type;
    if (type === 'error') {
      sawErrorEvent = true;
      if (typeof line.message === 'string') errorMessage = line.message;
      continue;
    }
    if (type === 'final') {
      sawFinal = true;
      continue;
    }
    if (type === 'status' && line.phase === 'turn_end' && line.reason && typeof line.reason === 'object') {
      turnEndReason = line.reason;
      continue;
    }
    if (type === 'question' || type === 'user_question' || type === 'abort' || type === 'aborted') {
      if (type === 'question' || type === 'user_question') sawQuestion = true;
      else sawErrorEvent = true;
      continue;
    }
    if (type === 'tool_result' && line.status === 'error') {
      // A failed tool call is not itself terminal; it only feeds the turn reason.
      continue;
    }
  }
  const rawStatus = typeof turnEndReason?.kind === 'string' ? turnEndReason.kind : null;
  const reasonError = turnEndReason && turnEndReason.error && typeof turnEndReason.error === 'object'
    ? turnEndReason.error
    : null;
  const completed = rawStatus === 'completed'
    && sawFinal
    && !sawErrorEvent
    && !sawQuestion
    && (exitCode === undefined || exitCode === 0);
  return {
    finalStatus: completed ? 'completed' : 'incomplete',
    rawStatus,
    completed,
    sawFinal,
    error: reasonError ?? (errorMessage ? { message: errorMessage } : null),
  };
}

export function parseJsonl(text) {
  const lines = [];
  const rejected = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      rejected.push(line);
    }
  }
  return { lines, rejected };
}

/** Build the exact launcher argv for one DSH invocation. */
export function buildDshArgs({ cliEntry, profile, args = [], sessionId = null } = {}) {
  if (typeof cliEntry !== 'string' || cliEntry.length === 0) throw new Error('dsh cliEntry is required');
  if (typeof profile !== 'string' || profile.length === 0) throw new Error('dsh profile is required');
  return [
    '--expose-internals',
    cliEntry,
    '--profile', profile,
    ...args,
    '--json',
    ...(sessionId ? ['--session-id', sessionId] : []),
    '-',
  ];
}

/**
 * Create the DSH adapter. `spawn` is injectable for tests; production uses the
 * real child_process.spawn via spawnProcess, so the default wiring actually
 * starts a process instead of throwing.
 */
export function createDshAdapter({
  config,
  run = runProcess,
  spawn = nodeSpawn,
  env = process.env,
  credentialCommand,
  fetchCredential = readCredential,
  promptRunner = null,
} = {}) {
  if (!config?.dsh) throw new Error('dsh adapter requires config.dsh');
  const dsh = config.dsh;
  const timeoutMs = config.timeouts?.dshMs ?? 30 * 60 * 1000;
  const permissionMode = assertDshPermissionMode(dsh.permissionMode);

  async function modelKey() {
    return fetchCredential({
      credentialCommand: credentialCommand ?? dsh.credentialCommand,
      timeoutMs: Math.min(timeoutMs, 10000),
      env,
      run,
    });
  }

  return {
    config,
    /** Drive one attempt. Returns the full transcript and outcome, never throws on a non-zero exit. */
    async drive({ prompt, cwd, attempt, sessionId = null, modelKey: injectedKey = null } = {}) {
      const key = injectedKey ?? await modelKey();
      const childEnv = buildDshEnv({
        baseEnv: env,
        modelKeyEnvName: dsh.modelKeyEnvName,
        modelKey: key,
        permissionMode,
      });
      const args = buildDshArgs({ cliEntry: dsh.cliEntry, profile: dsh.profile, args: dsh.args ?? [], sessionId });
      if (typeof promptRunner === 'function') {
        return promptRunner({ prompt, cwd, attempt, args, env: childEnv, timeoutMs });
      }
      const startedAt = new Date().toISOString();
      // The prompt is handed to the spawn contract exactly once: spawnProcess
      // owns stdin (writes the string, then closes the pipe). Ending the pipe a
      // second time would make the real CLI see an empty task and exit with
      // "a task is required".
      const { done } = spawnProcess({
        command: dsh.executable,
        args,
        cwd,
        env: childEnv,
        stdin: prompt,
        timeoutMs,
        spawn,
      });
      const result = await done;
      const parsed = parseJsonl(result.stdout);
      const status = extractFinalStatus(parsed.lines, { exitCode: result.status });
      return {
        exitCode: result.status,
        signal: result.signal ?? null,
        stdinDelivered: result.stdinDelivered ?? null,
        timedOut: false,
        startedAt,
        endedAt: new Date().toISOString(),
        sessionId: extractSessionId(parsed.lines),
        finalStatus: status.finalStatus,
        rawStatus: status.rawStatus,
        jsonl: parsed.lines,
        rejectedJsonl: parsed.rejected,
        stdoutText: redactText(result.stdout, { secrets: [key] }),
        stderr: redactText(result.stderr, { secrets: [key] }),
        envKeys: Object.keys(childEnv).sort(),
        args,
      };
    },
    buildEnv({ modelKeyValue }) {
      return buildDshEnv({ baseEnv: env, modelKeyEnvName: dsh.modelKeyEnvName, modelKey: modelKeyValue, permissionMode });
    },
    async readModelKey() {
      return modelKey();
    },
    killTree,
  };
}

export { KEEP_ENV, DROPPED_ENV, runProcess, spawnProcess };
