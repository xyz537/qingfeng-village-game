// Built-in default process runner. Dependency injection point for every
// external process the pipeline starts. shell is always false.
//
// Every child gets an explicit UTF-8 stdin: the caller's string when one is
// provided, and an immediate EOF otherwise. A child that reads to end of stdin
// must never hang because the controller forgot to close the pipe.
import { spawn as nodeSpawn } from 'node:child_process';
import { redactText } from './redact.mjs';

/** Start a process with an argv array and machine-safe defaults. */
export function spawnProcess({
  command,
  args = [],
  cwd,
  env,
  stdin = undefined,
  timeoutMs = 60000,
  spawn = nodeSpawn,
  windowsHide = true,
  detached = process.platform !== 'win32',
  onSpawn,
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide,
    detached,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (typeof onSpawn === 'function') onSpawn(child);

  // Deliver stdin immediately and close the pipe. The promise never rejects:
  // a broken pipe is a child outcome, not a controller crash.
  const stdinDone = writeStdin(child, stdin).catch(() => false);

  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timeout after ${timeoutMs}ms: ${command}`);
      err.code = 'TIMEOUT';
      err.timedOut = true;
      try {
        child.stdin?.destroy();
      } catch {
        /* best effort */
      }
      try {
        killTree(child.pid);
      } catch {
        /* best effort */
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* best effort */
      }
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  const finished = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      // The pipes are closed; stdin delivery has settled or is settle-proof.
      stdinDone.then((delivered) => {
        resolve({ status: code ?? (signal ? 1 : 0), stdout, stderr, signal, stdinDelivered: delivered });
      });
    });
  });

  return {
    child,
    done: Promise.race([finished, timeout]).finally(() => { if (timer) clearTimeout(timer); }),
  };
}

/** Run to completion, never throwing on a non-zero exit. */
export async function runProcess(options = {}) {
  const { done } = spawnProcess(options);
  const startedAt = new Date().toISOString();
  try {
    const result = await done;
    return { ...result, startedAt, endedAt: new Date().toISOString(), timedOut: false };
  } catch (err) {
    return {
      status: 1,
      stdout: '',
      stderr: redactText(String(err.message ?? err), {}),
      signal: null,
      stdinDelivered: false,
      startedAt,
      endedAt: new Date().toISOString(),
      timedOut: Boolean(err.timedOut),
      error: err,
    };
  }
}

/** Kill a whole process tree. The controller only ever kills what it started. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    // taskkill is a built-in OS tool; no user input is interpolated.
    try {
      nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* best effort */
    }
  }
}

/**
 * Feed a UTF-8 string to a child's stdin and close it. When `text` is
 * undefined the pipe is still closed immediately, so a child that reads until
 * end of input sees EOF instead of hanging.
 */
export function writeStdin(child, text) {
  return new Promise((resolve) => {
    if (!child?.stdin || child.stdin.destroyed) {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdin.on('error', (err) => {
      // EPIPE just means the child stopped reading; it is not a controller bug.
      settle(err && err.code !== 'EPIPE' ? false : false);
    });
    try {
      child.stdin.end(Buffer.from(text === undefined || text === null ? '' : String(text), 'utf8'), () => settle(true));
    } catch {
      settle(false);
    }
  });
}
