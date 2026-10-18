// Git helpers. Every invocation uses an argv array with shell disabled.
import { runProcess } from './runcmd.mjs';

class GitError extends Error {
  constructor(message, { args = [], status = 1, stderr = '' } = {}) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.status = status;
    this.stderr = stderr;
  }
}

/**
 * Run a git command. `spawn` and `timeoutMs` are injectable so tests can drive
 * this deterministically. A non-zero exit is always an error: the pipeline must
 * never treat a failed git call as success.
 */
export async function git(args, { cwd, timeoutMs = 60000, env, spawn, allowFailure = false, command = 'git' } = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new GitError('git args must be a string array', { args });
  }
  if (spawn) {
    const result = await spawn(command, args, { cwd, timeout: timeoutMs, shell: false, windowsHide: true, env });
    return normalize(result, { args, allowFailure });
  }
  const result = await runProcess({ command, args, cwd, env, timeoutMs });
  return normalize(result, { args, allowFailure });
}

function normalize(result, { args, allowFailure }) {
  const out = {
    status: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (out.status !== 0 && !allowFailure) {
    throw new GitError(`git ${args.join(' ')} failed with exit ${out.status}: ${out.stderr.trim() || out.stdout.trim()}`, {
      args,
      status: out.status,
      stderr: out.stderr,
    });
  }
  return out;
}

export async function headSha(repoDir, options = {}) {
  const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: repoDir, ...options });
  return stdout.trim();
}

export async function currentBranch(repoDir, options = {}) {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, ...options });
  return stdout.trim();
}

export async function isClean(repoDir, options = {}) {
  const { stdout } = await git(['status', '--porcelain'], { cwd: repoDir, ...options });
  return stdout.trim().length === 0;
}

export async function statusPorcelain(repoDir, options = {}) {
  const { stdout } = await git(['status', '--porcelain'], { cwd: repoDir, ...options });
  return stdout.trim();
}

export async function commitsBetween(repoDir, baseSha, head, options = {}) {
  const { stdout } = await git(['rev-list', '--count', `${baseSha}..${head}`], { cwd: repoDir, ...options });
  return Number.parseInt(stdout.trim(), 10) || 0;
}

export async function isAncestor(repoDir, ancestor, descendant, options = {}) {
  const { status } = await git(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoDir,
    allowFailure: true,
    ...options,
  });
  return status === 0;
}

export async function changedFiles(repoDir, baseSha, head, options = {}) {
  const { stdout } = await git(['diff', '--name-only', `${baseSha}..${head}`], { cwd: repoDir, ...options });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function diffText(repoDir, baseSha, head, options = {}) {
  const { stdout } = await git(['diff', '--no-color', `${baseSha}..${head}`], { cwd: repoDir, ...options });
  return stdout;
}

export async function addAll(repoDir, options = {}) {
  return git(['add', '--all'], { cwd: repoDir, ...options });
}

export async function commitAll(repoDir, message, options = {}) {
  await addAll(repoDir, options);
  const { stdout: staged } = await git(['diff', '--cached', '--name-only'], { cwd: repoDir, ...options });
  if (staged.trim().length === 0) return { committed: false, sha: await headSha(repoDir, options) };
  await git(['-c', 'user.name=qingfeng-pipeline', '-c', 'user.email=pipeline@qingfeng.invalid', 'commit', '--no-verify', '-m', message], {
    cwd: repoDir,
    ...options,
  });
  return { committed: true, sha: await headSha(repoDir, options) };
}

export { GitError };
