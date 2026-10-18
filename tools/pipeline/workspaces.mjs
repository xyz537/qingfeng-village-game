// Task workspaces: one exclusive lock per canonical path, an independent clone
// per task (not a shared-gitdir worktree), so a Windows workspace-write sandbox
// can never block Git metadata writes for another task.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath, lockPathFor, pathKey } from './redact.mjs';
import { git } from './git.mjs';

const TASK_BRANCH = /^agent\/issue-([0-9]+)-[a-z0-9][a-z0-9-]*$/;
const FORBIDDEN_BRANCH = new Set(['main', 'master', 'trunk', 'head', 'develop', 'release']);

class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

class LockError extends WorkspaceError {
  constructor(message) {
    super(message);
    this.name = 'LockError';
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The workspace must be a dedicated root, never the controller checkout. */
export function assertWorkspaceRoot(workspaceRoot, { checkoutRoot = process.cwd() } = {}) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    throw new WorkspaceError('workspace root must be an absolute local path');
  }
  const root = pathKey(workspaceRoot);
  const checkout = pathKey(checkoutRoot);
  const relative = path.relative(root, checkout);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new WorkspaceError(`workspace root ${workspaceRoot} must not contain the controller checkout`);
  }
  return path.resolve(workspaceRoot);
}

/** Only agent/issue-<N>-<slug> branches may be used for task work. */
export function assertTaskBranch(branch, issueNumber) {
  if (typeof branch !== 'string') throw new WorkspaceError('branch must be a string');
  const normalized = branch.replace(/^refs\/heads\//, '');
  if (FORBIDDEN_BRANCH.has(normalized.toLowerCase())) {
    throw new WorkspaceError(`branch ${branch} is a shared branch and is never used for task work`);
  }
  if (normalized.startsWith('automation/') || normalized.startsWith('refs/')) {
    throw new WorkspaceError(`branch ${branch} is an automation ref`);
  }
  const match = TASK_BRANCH.exec(normalized);
  if (!match) throw new WorkspaceError(`branch ${branch} must match agent/issue-<N>-<slug>`);
  if (Number.parseInt(match[1], 10) !== issueNumber) {
    throw new WorkspaceError(`branch ${branch} does not belong to issue ${issueNumber}`);
  }
  return normalized;
}

/** Refuse to touch a workspace with uncommitted work. */
export function assertClean({ dir, dirty }) {
  if (dirty) throw new WorkspaceError(`workspace ${dir} is dirty; refusing to reuse it`);
  return true;
}

export function taskWorkspaceDir(workspaceRoot, { repository, issueNumber }) {
  const safeRepo = String(repository).replace(/[\\/]/g, '__');
  return path.join(workspaceRoot, safeRepo, `issue-${issueNumber}`);
}

export function taskRepoDir(workspaceRoot, { repository, issueNumber }) {
  return path.join(taskWorkspaceDir(workspaceRoot, { repository, issueNumber }), 'repo');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    // EPERM means the process exists but is owned by another user: alive.
    return true;
  }
}

async function readLock(lockFile) {
  try {
    const text = await fsp.readFile(lockFile, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Acquire the OS-exclusive lock for a canonical task path. Creation of the lock
 * file is atomic (wx); a lock held by another live process always fails closed.
 * A stale lock is only recovered when the caller explicitly asks for it.
 */
export async function acquireLock(dir, { workerId = 'unknown', runId = 'unknown', issueNumber = null, recoverDead = false } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new LockError('lock dir is required');
  const canonical = await canonicalPath(dir);
  const lockFile = lockPathFor(canonical);
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  const record = {
    schemaVersion: 1,
    pid: process.pid,
    workerId,
    runId,
    issueNumber,
    dir: canonical,
    startedAt: new Date().toISOString(),
  };
  const release = async () => {
    try {
      const current = await readLock(lockFile);
      if (current?.runId === runId && current?.pid === process.pid) await fsp.unlink(lockFile);
    } catch {
      /* best effort */
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
      } finally {
        await handle.close();
      }
      return { dir: canonical, lockFile, runId, release, recovered: attempt > 0 };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = await readLock(lockFile);
      if (!holder) {
        throw new LockError(`workspace ${canonical} is locked by an unreadable lock file ${lockFile}`);
      }
      if (holder.runId === runId && holder.workerId === workerId) {
        return { dir: canonical, lockFile, runId, release, reused: true };
      }
      if (recoverDead && !processAlive(holder.pid)) {
        await fsp.unlink(lockFile).catch(() => {});
        continue;
      }
      const holderState = processAlive(holder.pid) ? 'live' : 'not running';
      throw new LockError(
        `workspace ${canonical} is locked by worker ${holder.workerId} (run ${holder.runId}, pid ${holder.pid}, ${holderState}); ` +
        'a lost claim fails closed until an operator confirms the previous process stopped',
      );
    }
  }
  throw new LockError(`workspace ${canonical} could not be locked`);
}

/**
 * Acquire an independent workspace for a task: its own directory, its own
 * branch, its own clone. Never a shared gitdir worktree.
 */
export function createWorkspaceManager({ config, run = null, gitOptions = {}, spawnGit = null } = {}) {
  if (!config?.workspaceRoot) throw new WorkspaceError('workspace manager requires a workspace root');
  const gitRun = (args, options) => git(args, { timeoutMs: config.timeouts?.gitMs ?? 120000, spawn: spawnGit, ...gitOptions, ...options });

  const manager = {
    config,
    async assertReady() {
      assertWorkspaceRoot(config.workspaceRoot);
      await fsp.mkdir(config.workspaceRoot, { recursive: true });
      return true;
    },
    dirFor(request) {
      return taskWorkspaceDir(config.workspaceRoot, request);
    },
    async acquire({ task, workerId = config.workerId, runId = 'run' } = {}) {
      const branch = assertTaskBranch(task.branch, task.issueNumber);
      if (task.repository !== config.repository) {
        throw new WorkspaceError(`task repository ${task.repository} does not match the configured repository`);
      }
      await manager.assertReady();
      const dir = taskWorkspaceDir(config.workspaceRoot, task);
      const repoDir = taskRepoDir(config.workspaceRoot, task);
      const lock = await acquireLock(dir, { workerId, runId, issueNumber: task.issueNumber });
      try {
        await fsp.mkdir(dir, { recursive: true });
        const repoExists = fs.existsSync(path.join(repoDir, '.git'));
        if (!repoExists) {
          const source = await manager.ensureSource();
          await gitRun(['clone', '--no-hardlinks', '--single-branch', '--branch', config.baseRef, source, repoDir], { cwd: config.workspaceRoot });
        }
        const clean = await gitRun(['status', '--porcelain'], { cwd: repoDir });
        if (clean.stdout.trim().length > 0) {
          throw new WorkspaceError(`workspace ${repoDir} is dirty; refusing to reuse it`);
        }
        const hasBranch = await gitRun(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoDir, allowFailure: true });
        if (hasBranch.status === 0) {
          await gitRun(['checkout', branch], { cwd: repoDir });
        } else {
          await gitRun(['checkout', '-B', branch, task.baseSha], { cwd: repoDir });
        }
        const head = (await gitRun(['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
        if (head !== task.baseSha && !(await manager.isAncestor({ repoDir, ancestor: task.baseSha, descendant: head }))) {
          throw new WorkspaceError(`workspace ${repoDir} does not contain the approved base ${task.baseSha}`);
        }
        return { dir, repoDir, branch, head, lock, mode: 'clone' };
      } catch (err) {
        await lock.release();
        throw err;
      }
    },
    /**
     * A local mirror of the configured remote, used as the clone source so the
     * controller checkout's own Git metadata is never required (and never shared).
     */
    async ensureSource() {
      const mirror = path.join(config.workspaceRoot, '.sources', String(config.repository).replace(/[\\/]/g, '__'));
      if (config.sourceDir) return config.sourceDir;
      if (fs.existsSync(path.join(mirror, 'HEAD'))) {
        // Refresh best effort; a network problem must not destroy a usable cache.
        await gitRun(['--git-dir', mirror, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: config.workspaceRoot, allowFailure: true });
        return mirror;
      }
      await fsp.mkdir(path.dirname(mirror), { recursive: true });
      await gitRun(['clone', '--mirror', config.repositoryUrl, mirror], { cwd: config.workspaceRoot });
      return mirror;
    },
    async inspect({ repoDir, branch }) {
      const current = (await gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim();
      const head = (await gitRun(['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
      const porcelain = (await gitRun(['status', '--porcelain'], { cwd: repoDir })).stdout.trim();
      return {
        branch: current,
        expectedBranch: branch,
        headSha: head,
        dirty: porcelain.length > 0,
        status: porcelain,
      };
    },
    async isAncestor({ repoDir, ancestor, descendant }) {
      const result = await gitRun(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoDir, allowFailure: true });
      return result.status === 0;
    },
    async commitAll({ repoDir, message }) {
      await gitRun(['add', '--all'], { cwd: repoDir });
      const staged = (await gitRun(['diff', '--cached', '--name-only'], { cwd: repoDir })).stdout.trim();
      if (staged.length === 0) {
        return { committed: false, sha: (await gitRun(['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim() };
      }
      await gitRun(
        ['-c', 'user.name=qingfeng-pipeline', '-c', 'user.email=pipeline@qingfeng.invalid', 'commit', '--no-verify', '-m', message],
        { cwd: repoDir },
      );
      return { committed: true, sha: (await gitRun(['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim() };
    },
    async changedFiles({ repoDir, baseSha, headSha }) {
      const out = (await gitRun(['diff', '--name-only', `${baseSha}..${headSha}`], { cwd: repoDir })).stdout;
      return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    },
    async uniqueCommits({ repoDir, baseSha, headSha }) {
      const out = (await gitRun(['rev-list', '--count', `${baseSha}..${headSha}`], { cwd: repoDir })).stdout.trim();
      return Number.parseInt(out, 10) || 0;
    },
    async release(lock) {
      if (lock?.release) await lock.release();
    },
  };
  return manager;
}

export function reviewWorkspaceDir(workspaceRoot, { repository, issueNumber }) {
  const safeRepo = String(repository).replace(/[\\/]/g, '__');
  return path.join(workspaceRoot, 'review', safeRepo, `issue-${issueNumber}`);
}

/**
 * Independent read-only review workspace. It is a separate physical directory
 * from the DSH development clone and is checked out detached at the exact
 * reviewed commit. When the approved commit is not yet pushed (the normal case
 * before publication) it is cloned/fetched from the local development clone.
 */
export function createReviewWorkspaceManager({ config, spawnGit = null, gitOptions = {} } = {}) {
  if (!config?.workspaceRoot) throw new WorkspaceError('review workspace manager requires a workspace root');
  const gitRun = (args, options) => git(args, { timeoutMs: config.timeouts?.gitMs ?? 120000, spawn: spawnGit, ...gitOptions, ...options });

  return {
    config,
    dirFor(request) {
      return reviewWorkspaceDir(config.workspaceRoot, request);
    },
    async acquire({ task, headSha, baseSha = null, sourceDir = null, runId = 'review' } = {}) {
      if (!task || !task.issueNumber) throw new WorkspaceError('review workspace requires the task');
      if (!headSha) throw new WorkspaceError('review workspace requires the exact head sha');
      if (task.repository !== config.repository) {
        throw new WorkspaceError(`task repository ${task.repository} does not match the configured repository`);
      }
      await fsp.mkdir(config.workspaceRoot, { recursive: true });
      const dir = reviewWorkspaceDir(config.workspaceRoot, task);
      const repoDir = path.join(dir, 'repo');
      const lock = await acquireLock(dir, { workerId: 'review', runId, issueNumber: task.issueNumber });
      try {
        await fsp.mkdir(dir, { recursive: true });
        if (!fs.existsSync(path.join(repoDir, '.git'))) {
          if (!sourceDir) throw new WorkspaceError('review workspace needs the development clone as its local source');
          await gitRun(['clone', '--no-hardlinks', sourceDir, repoDir], { cwd: config.workspaceRoot });
        }
        const present = await gitRun(['cat-file', '-e', `${headSha}^{commit}`], { cwd: repoDir, allowFailure: true });
        if (present.status !== 0) {
          if (!sourceDir) throw new WorkspaceError(`review workspace does not contain commit ${headSha}`);
          await gitRun(['fetch', '--no-tags', '--force', sourceDir, headSha], { cwd: repoDir });
        }
        await gitRun(['checkout', '--detach', '--force', headSha], { cwd: repoDir });
        const head = (await gitRun(['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
        if (head !== headSha) {
          throw new WorkspaceError(`review workspace head ${head} does not match the reviewed head ${headSha}`);
        }
        const unique = (repoDirForCount) => async () => {
          if (!baseSha) return 1;
          const out = (await gitRun(['rev-list', '--count', `${baseSha}..${headSha}`], { cwd: repoDirForCount })).stdout.trim();
          return Number.parseInt(out, 10) || 0;
        };
        return {
          dir,
          repoDir,
          branch: null,
          head,
          lock,
          mode: 'review-detached-clone',
          readOnly: true,
          async headSha() {
            return head;
          },
          uniqueCommits: unique(repoDir),
        };
      } catch (err) {
        await lock.release();
        throw err;
      }
    },
    async release(lock) {
      if (lock?.release) await lock.release();
    },
  };
}

/** True when `child` is inside `parent` (canonical, case-insensitive on Windows). */
export function isInside(parent, child) {
  const relative = path.relative(pathKey(parent), pathKey(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export { WorkspaceError, LockError, isPlainObject };
