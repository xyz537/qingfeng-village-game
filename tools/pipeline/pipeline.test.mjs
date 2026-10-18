// Behavior tests for the Codex + DSH single-run pipeline (Issue #3).
// These tests exercise the real state machine and the real modules with
// injected, in-memory adapters. They never talk to GitHub, a model, or the
// network. The one real-child test uses node itself and is skipped when the
// Windows sandbox forbids piped child processes.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadLocalConfig } from './config.mjs';
import { validateTaskSpec, validateReviewReport, schemaDigest, taskManifestSchema, reviewReportSchema } from './schemas.mjs';
import { isAllowedVerificationCommand, verificationPolicy, ALLOWED_COMMAND_POLICY } from './allowlist.mjs';
import { runTask } from './runner.mjs';
import { createLogStore } from './logs.mjs';
import { lockPathFor, canonicalPath, redactObject } from './redact.mjs';
import * as workspaces from './workspaces.mjs';
import { createCli, runCli, createDefaultAdapters, entryCheck, isAsarEntry } from './cli.mjs';
import { createGithubAdapter, assertArgvAllowed, createGhCaller, ensurePullRequest, normalizePull } from './github.mjs';
import { runProcess, spawnProcess } from './runcmd.mjs';
import { createDshAdapter, buildDshArgs, buildDshEnv, assertDshPermissionMode, extractFinalStatus, extractSessionId, parseJsonl } from './dsh.mjs';
import { evaluateReviewPolicy, createReviewAdapter, assertReviewArgsSafe } from './review.mjs';
import * as gitmod from './git.mjs';

const SHA_A = 'e7704ed2815bad195cb3bfb9725e364bd04145fe';
const SHA_B = 'a'.repeat(40);
const SHA_C = 'b'.repeat(40);
const SHA_D = 'c'.repeat(40);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: 'xyz537/qingfeng-village-game',
    issueNumber: 3,
    title: 'NPC 日程 pipeline pilot',
    approvedBy: 'xyz537',
    baseRef: 'setup/codex-dsh-pipeline',
    baseSha: SHA_A,
    branch: 'agent/issue-3-npc-schedule',
    allowedPaths: ['tools/pipeline/', 'docs/agents/'],
    acceptance: ['CLI 提供 doctor/run/status/export-logs', '双机竞争只有一个 worker 领取成功'],
    verificationCommands: [
      { command: 'node', args: ['--check', 'game.js'] },
      { command: 'node', args: ['--check', 'test.cjs'] },
      { command: 'node', args: ['test.cjs'] },
    ],
    maxFixRetries: 2,
    ...overrides,
  };
}

function makeIssue(manifest = makeManifest(), overrides = {}) {
  return {
    number: manifest.issueNumber,
    title: manifest.title,
    state: 'open',
    user: { login: 'xyz537' },
    labels: [{ name: 'ready-for-agent' }],
    body: `Pipeline task manifest below.\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`,
    ...overrides,
  };
}

function makeConfig(rootDir, overrides = {}) {
  return {
    schemaVersion: 1,
    workerId: 'worker-a',
    approvedUsers: ['xyz537'],
    repository: 'xyz537/qingfeng-village-game',
    baseRef: 'setup/codex-dsh-pipeline',
    workspaceRoot: path.join(rootDir, 'workspaces'),
    logsDir: path.join(rootDir, 'logs'),
    concurrentTasks: 1,
    timeouts: {
      dshMs: 5000,
      reviewMs: 5000,
      testMs: 5000,
      commandMs: 5000,
      gitMs: 5000,
    },
    maxFixRetries: 2,
    github: {
      credentialCommand: { command: 'credential-helper', args: ['read', 'github'] },
      refPrefix: 'refs/heads/automation/claim',
      logRef: 'refs/heads/automation/logs',
    },
    dsh: {
      profile: 'qingfeng-dsh',
      executable: path.join(rootDir, 'electron.exe'),
      cliEntry: path.join(rootDir, 'dsh-cli.js'),
      modelKeyEnvName: 'DEEPSEEK_API_KEY',
      credentialCommand: { command: 'credential-helper', args: ['read', 'dsh'] },
    },
    review: {
      profile: 'qingfeng-review',
      executable: path.join(rootDir, 'electron.exe'),
      cliEntry: path.join(rootDir, 'codex-cli.js'),
      outputSchemaPath: path.join(rootDir, 'schemas', 'review.schema.json'),
      commands: [
        { command: 'node', args: ['--check', 'game.js'] },
        { command: 'node', args: ['--check', 'test.cjs'] },
        { command: 'node', args: ['test.cjs'] },
      ],
    },
    ...overrides,
  };
}

function writeConfig(rootDir, config) {
  const file = path.join(rootDir, '.pipeline', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

// --- in-memory GitHub world -------------------------------------------------

class FakeHub {
  constructor() {
    this.refs = new Map(); // ref -> { sha }
    this.commits = new Map(); // sha -> payload
    this.pulls = [];
    this.statuses = new Map(); // branch -> payload
    this.issues = new Map();
    this.failNextRefCreate = null; // 'timeout' | 'conflict' | null
    this.mergeCalls = 0;
    this.unknownCalls = [];
  }

  seedIssue(issue) {
    this.issues.set(issue.number, issue);
  }

  async createRef({ ref, sha, actor }) {
    if (this.failNextRefCreate === 'timeout') {
      this.failNextRefCreate = null;
      const err = new Error('request timed out');
      err.code = 'TIMEOUT';
      throw err;
    }
    if (this.failNextRefCreate === 'conflict') {
      this.failNextRefCreate = null;
      const err = new Error('Reference already exists');
      err.code = 'CONFLICT';
      throw err;
    }
    if (this.refs.has(ref)) {
      const err = new Error('Reference already exists');
      err.code = 'CONFLICT';
      throw err;
    }
    this.refs.set(ref, { sha, actor });
    return { ref, sha };
  }

  async getRef(ref) {
    const found = this.refs.get(ref);
    if (!found) {
      const err = new Error('Not Found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return { ...found, ref };
  }

  async createCommit({ tree, message, parents, actor }) {
    const sha = `commit-${this.commits.size + 1}-${String(tree).slice(0, 8)}`;
    const payload = { tree, message, parents, actor };
    this.commits.set(sha, payload);
    return { sha, ...payload };
  }

  async getCommit(sha) {
    if (sha === SHA_A || sha === SHA_B || sha === SHA_C || sha === SHA_D) return { sha };
    const found = this.commits.get(sha);
    if (!found) {
      const err = new Error('Not Found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return { sha, ...found };
  }

  async listPulls({ head, base }) {
    return this.pulls.filter((p) => p.head === head && p.base === base);
  }

  async createPull({ head, base, title, body, draft }) {
    const pull = { number: this.pulls.length + 1, head, base, title, body, draft, state: 'open' };
    this.pulls.push(pull);
    return pull;
  }

  async writeStatus({ branch, payload }) {
    this.statuses.set(branch, { ...payload, branch });
    return { ok: true };
  }

  async readStatus({ branch }) {
    const found = this.statuses.get(branch);
    if (!found) {
      const err = new Error('Not Found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return { ...found };
  }

  async merge() {
    this.mergeCalls += 1;
    throw new Error('merge must never be called by the pipeline');
  }
}

function makeGithub(hub) {
  return {
    async getIssue(number) {
      const issue = hub.issues.get(number);
      if (!issue) {
        const err = new Error('Not Found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return issue;
    },
    async commitExists({ sha }) {
      if (sha === SHA_A || sha === SHA_B || sha === SHA_C || hub.commits.has(sha)) return true;
      return false;
    },
    async readStatus(branch) {
      try {
        return await hub.readStatus({ branch });
      } catch (err) {
        if (err.code === 'NOT_FOUND') return null;
        throw err;
      }
    },
    async writeStatus(branch, payload) {
      return hub.writeStatus({ branch, payload });
    },
    async acquireClaim({ spec, workerId, runId, digest }) {
      const ref = `refs/heads/automation/claim/issue-${spec.issueNumber}`;
      const claimPayload = {
        schemaVersion: 1,
        workerId,
        runId,
        specDigest: digest,
        baseSha: spec.baseSha,
        issueNumber: spec.issueNumber,
      };
      const body = JSON.stringify(claimPayload);
      const commit = await hub.createCommit({
        tree: body,
        message: `automation claim issue-${spec.issueNumber}`,
        parents: [spec.baseSha],
      });
      try {
        await hub.createRef({ ref, sha: commit.sha, actor: workerId });
      } catch (err) {
        if (err.code === 'CONFLICT' || err.code === 'TIMEOUT') {
          let existing = null;
          try {
            existing = await hub.getRef(ref);
          } catch {
            existing = null;
          }
          if (!existing) {
            return { claimed: false, reason: 'unrecoverable', ref, error: err.message };
          }
          let owner = null;
          try {
            owner = JSON.parse(hub.commits.get(existing.sha)?.tree ?? 'null');
          } catch {
            owner = null;
          }
          return { claimed: owner?.workerId === workerId, reason: 'exists', ref, existing, owner };
        }
        throw err;
      }
      return { claimed: true, ref, commit };
    },
    async ownerOfClaim(issueNumber) {
      const ref = `refs/heads/automation/claim/issue-${issueNumber}`;
      const existing = hub.refs.get(ref);
      if (!existing) return null;
      try {
        return JSON.parse(hub.commits.get(existing.sha)?.tree ?? 'null');
      } catch {
        return null;
      }
    },
  };
}

// --- in-memory DSH (model) --------------------------------------------------

function makeDsh(script) {
  const calls = [];
  return {
    calls,
    async drive(task) {
      calls.push({ task, attempt: task.attempt, workspace: task.workspace });
      const step = typeof script === 'function' ? script(task) : script;
      if (!step) throw new Error('no dsh script step');
      const result = {
        exitCode: step.exitCode ?? 0,
        finalStatus: step.finalStatus ?? 'completed',
        sessionId: step.sessionId ?? `sess-${calls.length}`,
        jsonl: step.jsonl ?? ['{"type":"result","status":"completed"}'],
        stderr: step.stderr ?? '',
        timedOut: Boolean(step.timedOut),
        durationMs: 1,
      };
      if (step.changes) step.changes(task.workspace);
      return result;
    },
    async createWorkspace() {
      return { dir: 'memory' };
    },
    async dispose() {},
  };
}

// --- in-memory review -------------------------------------------------------

function makeReview(script) {
  const calls = [];
  return {
    calls,
    async review(request) {
      calls.push(request);
      const step = typeof script === 'function' ? script(request) : script;
      const report = {
        headSha: step?.headSha ?? request.headSha,
        verdict: step?.verdict ?? 'pass',
        acceptanceResults: step?.acceptanceResults ?? request.acceptance.map((text) => ({ text, passed: true, evidence: 'ok' })),
        findings: step?.findings ?? [],
        testEvidence: step?.testEvidence ?? [{
          command: 'node test.cjs',
          exitCode: 0,
          headSha: request.headSha,
          specDigest: request.specDigest,
          output: 'ok',
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
        }],
      };
      return { report, transcript: step?.transcript ?? null, evidence: step?.evidence ?? null };
    },
    async dispose() {},
  };
}

// --- in-memory independent review workspace --------------------------------

function makeReviewWorkspaces(rootDir, opts = {}) {
  const calls = [];
  const state = {
    dir: path.join(rootDir, 'workspaces', 'review', 'xyz537__qingfeng-village-game', `issue-${opts.issueNumber ?? 3}`),
    released: false,
  };
  return {
    calls,
    state,
    async acquire(request) {
      calls.push(request);
      if (opts.fail) throw new Error('review workspace unavailable');
      state.dir = path.join(state.dir, request.runId ?? 'run');
      return {
        dir: state.dir,
        repoDir: path.join(state.dir, 'repo'),
        head: request.headSha,
        readOnly: true,
        lock: { release: async () => { state.released = true; } },
        async headSha() { return request.headSha; },
        async uniqueCommits() { return 1; },
      };
    },
    async release(lock) {
      if (lock?.release) await lock.release();
    },
  };
}

// --- in-memory test runner --------------------------------------------------

function makeTests(script) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      const step = typeof script === 'function' ? script(request) : script;
      const failures = step?.failures ?? [];
      return {
        passed: failures.length === 0,
        headSha: request.headSha,
        env: request.env,
        results: request.commands.map((c, i) => {
          const key = `${c.command} ${c.args.join(' ')}`.trim();
          const failed = failures.includes(key);
          return {
            command: key,
            exitCode: failed ? 1 : 0,
            stdout: failed ? '' : 'selftest stdout ok',
            stderr: failed ? 'boom' : '',
            output: failed ? 'boom' : 'ok',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:01.000Z',
          };
        }),
      };
    },
  };
}

// --- in-memory publication --------------------------------------------------

function makePublish(script) {
  const calls = [];
  return {
    calls,
    async pushBranch(request) {
      calls.push({ op: 'pushBranch', ...request });
      const step = typeof script === 'function' ? script(request) : script;
      if (step?.reject) {
        const err = new Error(step.reject);
        err.code = 'REFUSED';
        throw err;
      }
      return { branch: request.branch, sha: request.headSha, created: step?.created ?? true };
    },
    async ensurePullRequest(request) {
      calls.push({ op: 'ensurePullRequest', ...request });
      const step = typeof script === 'function' ? script(request) : script;
      return { number: step?.number ?? 11, url: `https://example.invalid/pull/${step?.number ?? 11}`, created: step?.created ?? true, draft: true, state: 'open' };
    },
    async pushLogs(request) {
      calls.push({ op: 'pushLogs', ...request });
      return { ref: request.ref, updated: true };
    },
  };
}

// --- in-memory workspace + commit -------------------------------------------

function makeWorkspace(rootDir, opts = {}) {
  const state = {
    dir: path.join(rootDir, 'workspaces', 'xyz537__qingfeng-village-game', `issue-${opts.issueNumber ?? 3}`),
    branch: opts.branch ?? 'agent/issue-3-npc-schedule',
    headSha: opts.headSha ?? SHA_A,
    pushed: false,
    dirty: false,
    filesChanged: opts.filesChanged ?? null,
  };
  const calls = [];
  const fake = {
    calls,
    state,
    lock: null,
    async acquire(request) {
      calls.push(request);
      return { dir: state.dir, mode: 'clone' };
    },
    async inspect() {
      return { branch: state.branch, headSha: state.headSha, dirty: state.dirty, uniqueCommits: state.headSha === SHA_A ? 0 : 1 };
    },
    async isAncestor({ ancestor, descendant }) {
      return ancestor === SHA_A || ancestor === descendant;
    },
    async changedFiles() {
      if (state.filesChanged) return state.filesChanged;
      return state.headSha === SHA_A ? [] : ['tools/pipeline/x.mjs'];
    },
    async writePrompt(_file, _content) {
      return path.join(state.dir, '.pipeline-prompt.md');
    },
    async commitAll(message) {
      if (state.dirty || state.headSha === SHA_A) state.headSha = SHA_B;
      state.dirty = false;
      return { sha: state.headSha, committed: true, message };
    },
    async release() {
      state.released = true;
      if (fake.lock) await fake.lock.release();
    },
  };
  return fake;
}

function makeHarness(rootDir, { hub, dshScript, reviewScript, testScript, publishScript, workspaceOpts, configOverrides, reviewWorkspaceOpts } = {}) {
  const config = makeConfig(rootDir, configOverrides);
  const hub2 = hub ?? new FakeHub();
  hub2.seedIssue(makeIssue());
  const workspace = makeWorkspace(rootDir, workspaceOpts);
  const dsh = makeDsh(dshScript ?? {});
  // The runner reads the model key from the DSH adapter; make it explicit so
  // the credential-isolation behavior is actually exercised.
  dsh.readModelKey = async () => 'model-secret';
  const review = makeReview(reviewScript ?? {});
  const reviewWorkspaces = makeReviewWorkspaces(rootDir, reviewWorkspaceOpts);
  const tests = makeTests(testScript ?? {});
  const publish = makePublish(publishScript ?? {});
  workspace.acquire = async (request) => {
    workspace.calls.push(request);
    if (process.env.DSH_PIPELINE_DEBUG === '1') console.error('[debug] harness acquire', workspace.state.dir, request.runId, request.workerId);
    if (workspaceOpts?.uniqueRoot) {
      workspace.state.dir = path.join(rootDir, 'workspaces', request.workerId, `issue-${request.task.issueNumber}`);
    }
    // Use the real exclusive lock so lock-conflict behavior is actually exercised.
    workspace.lock = await workspaces.acquireLock(workspace.state.dir, {
      workerId: request.workerId,
      runId: request.runId,
      issueNumber: request.task.issueNumber,
      recoverDead: Boolean(workspaceOpts?.recoverDead),
    });
    return { dir: workspace.state.dir, lock: workspace.lock, mode: 'clone' };
  };
  const deps = {
    config,
    github: makeGithub(hub2),
    workspaces: workspace,
    reviewWorkspaces,
    dsh,
    review,
    tests,
    publish,
    now: () => '2026-01-01T00:00:00.000Z',
  };
  return { config, hub: hub2, workspace, reviewWorkspaces, dsh, review, tests, publish, deps };
}

async function mkroot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-pipeline-test-'));
}

// ---------------------------------------------------------------------------
// Manifest and review schema
// ---------------------------------------------------------------------------

describe('task manifest schema', () => {
  test('accepts a well-formed manifest and produces a stable digest', () => {
    const result = validateTaskSpec(makeManifest());
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.spec.issueNumber, 3);
    assert.equal(result.spec.maxFixRetries, 2);
    const d1 = schemaDigest(result.spec);
    const d2 = schemaDigest(validateTaskSpec(makeManifest()).spec);
    assert.equal(d1, d2);
    assert.match(d1, /^[0-9a-f]{64}$/);
  });

  test('digest changes when approved requirements change', () => {
    const a = schemaDigest(validateTaskSpec(makeManifest()).spec);
    const b = schemaDigest(validateTaskSpec(makeManifest({ acceptance: ['changed'] })).spec);
    assert.notEqual(a, b);
  });

  test('rejects wrong schemaVersion, retry budget, branch shape and unsafe paths', () => {
    const cases = [
      [{ schemaVersion: 2 }, /schemaVersion/],
      [{ maxFixRetries: 3 }, /maxFixRetries/],
      [{ branch: 'main' }, /branch/],
      [{ branch: 'agent/issue-4-x' }, /branch/],
      [{ branch: 'agent/issue-3-Bad_Slug' }, /branch/],
      [{ allowedPaths: ['../outside/'] }, /allowedPaths/],
      [{ allowedPaths: ['C:/tmp/x'] }, /allowedPaths/],
      [{ allowedPaths: ['game.js'] }, /allowedPaths/],
      [{ repository: 'evil/repo' }, /repository/],
      [{ issueNumber: '3' }, /issueNumber/],
      [{ approvedBy: '' }, /approvedBy/],
      [{ baseRef: 'refs/heads/main' }, /baseRef/],
      [{ verificationCommands: [] }, /verificationCommands/],
      [{ verificationCommands: [null] }, /verificationCommands/],
      [{ verificationCommands: [{}] }, /verificationCommands/],
      [{ verificationCommands: [{ command: 'node' }] }, /verificationCommands/],
      [{ verificationCommands: [{ command: 'node', args: 'test.cjs' }] }, /verificationCommands/],
      [{ verificationCommands: [{ command: 'node', args: ['a\nb'] }] }, /verificationCommands/],
      [{ verificationCommands: [{ command: 'node', args: [], extra: true }] }, /verificationCommands/],
      [{ extraField: true }, /extraField/],
    ];
    for (const [override, re] of cases) {
      const result = validateTaskSpec(makeManifest(override));
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(override)}`);
      assert.ok(result.errors.some((e) => re.test(e.message ?? String(e))), `wanted ${re} in ${JSON.stringify(result.errors)}`);
    }
  });

  test('baseSha must be a full commit sha', () => {
    assert.equal(validateTaskSpec(makeManifest({ baseSha: 'abc123' })).ok, false);
  });

  test('schema documents are published alongside the code', () => {
    assert.equal(taskManifestSchema.title.length > 0, true);
    assert.equal(reviewReportSchema.title.length > 0, true);
    assert.equal(taskManifestSchema.properties.schemaVersion.const, 1);
    assert.equal(reviewReportSchema.properties.verdict.enum.length, 3);
  });
});

describe('review report schema', () => {
  const base = {
    headSha: SHA_B,
    verdict: 'pass',
    acceptanceResults: [{ text: 'a', passed: true, evidence: 'ok' }],
    findings: [],
    testEvidence: [{ command: 'node test.cjs', exitCode: 0, headSha: SHA_B, output: 'ok', startedAt: 'x', endedAt: 'y' }],
  };

  test('accepts a strict pass report', () => {
    assert.equal(validateReviewReport(base).ok, true);
  });

  test('rejects malformed reports', () => {
    const bad = [
      [{ ...base, verdict: 'maybe' }, /verdict/],
      [{ ...base, headSha: 'zz' }, /headSha/],
      [{ ...base, acceptanceResults: [] }, /acceptanceResults/],
      [{ ...base, findings: [{ severity: 'nope', message: 'x' }] }, /severity/],
      [{ ...base, testEvidence: [] }, /testEvidence/],
      [{ ...base, extra: 1 }, /extra/],
    ];
    for (const [report, re] of bad) {
      const result = validateReviewReport(report);
      assert.equal(result.ok, false, JSON.stringify(report));
      assert.ok(result.errors.some((e) => re.test(e.message ?? String(e))));
    }
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('local config', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('loads a valid config with maxFixRetries pinned to 2', async () => {
    const file = writeConfig(root, makeConfig(root));
    const config = loadLocalConfig(file);
    assert.equal(config.maxFixRetries, 2);
    assert.equal(config.workerId, 'worker-a');
    assert.deepEqual(config.approvedUsers, ['xyz537']);
    assert.equal(config.concurrentTasks, 1);
    assert.equal(config.dsh.profile, 'qingfeng-dsh');
    assert.equal(config.dsh.modelKeyEnvName, 'DEEPSEEK_API_KEY');
    assert.ok(config.workspaceRoot.includes('workspaces'));
  });

  test('rejects unsafe worker ids, profiles, relative paths and retry budgets', async () => {
    const cases = [
      [{ workerId: 'worker a' }, /workerId/],
      [{ workerId: '' }, /workerId/],
      [{ dsh: { ...makeConfig(root).dsh, profile: 'bad;profile' } }, /profile/],
      [{ dsh: { ...makeConfig(root).dsh, profile: '' } }, /profile/],
      [{ workspaceRoot: 'relative/workspaces' }, /workspaceRoot/],
      [{ logsDir: 'relative/logs' }, /logsDir/],
      [{ maxFixRetries: 1 }, /maxFixRetries/],
      [{ concurrentTasks: 2 }, /concurrentTasks/],
      [{ approvedUsers: [] }, /approvedUsers/],
      [{ timeouts: { ...makeConfig(root).timeouts, dshMs: 0 } }, /dshMs/],
      [{ repository: 'nope' }, /repository/],
      [{ baseRef: 'main' }, /baseRef/],
      [{ github: { ...makeConfig(root).github, refPrefix: 'refs/heads/main' } }, /refPrefix/],
      [{ dsh: { ...makeConfig(root).dsh, modelKeyEnvName: 'lower-case' } }, /modelKeyEnvName/],
      [{ dsh: { ...makeConfig(root).dsh, credentialCommand: { command: 'helper', args: ['a b'] } } }, /args/],
      [{ secret: 'token' }, /secret|unknown/i],
    ];
    for (const [override, re] of cases) {
      const file = writeConfig(root, makeConfig(root, override));
      assert.throws(() => loadLocalConfig(file), (err) => {
        assert.ok(re.test(err.message), `wanted ${re} in "${err.message}"`);
        return true;
      }, `expected throw for ${JSON.stringify(override)}`);
    }
  });

  test('rejects secret-looking keys in config', async () => {
    const cfg = makeConfig(root);
    cfg.github.token = 'ghp_secret';
    const file = writeConfig(root, cfg);
    assert.throws(() => loadLocalConfig(file), /secret|forbidden|token/i);
  });

  test('missing config file fails closed with the expected path', async () => {
    assert.throws(() => loadLocalConfig(path.join(root, 'nope.json')), /config/i);
  });
});

// ---------------------------------------------------------------------------
// Claim: two machines, only one wins
// ---------------------------------------------------------------------------

describe('remote claim', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('two machines race and only one performs the work', async () => {
    const hub = new FakeHub();
    // Deterministic race: worker A blocks inside the atomic ref creation while
    // worker B attempts the same claim and must lose.
    let releaseFirstClaim;
    let firstClaimSeen;
    const firstClaim = new Promise((resolve) => { firstClaimSeen = resolve; });
    const gate = new Promise((resolve) => { releaseFirstClaim = resolve; });
    const realCreateRef = hub.createRef.bind(hub);
    let refCreations = 0;
    hub.createRef = async (request) => {
      if (request.ref.includes('/automation/claim/')) {
        refCreations += 1;
        if (refCreations === 1) {
          // Worker A's atomic creation lands first, then A pauses; worker B
          // must find the existing ref and lose the race.
          const created = await realCreateRef(request);
          firstClaimSeen();
          await gate;
          return created;
        }
      }
      return realCreateRef(request);
    };

    const a = makeHarness(root, { hub, workspaceOpts: { uniqueRoot: true }, configOverrides: { workerId: 'worker-a' } });
    const b = makeHarness(root, { hub, publishScript: { reject: 'must not publish' }, workspaceOpts: { uniqueRoot: true }, configOverrides: { workerId: 'worker-b' } });
    a.deps.github = makeGithub(hub);
    b.deps.github = makeGithub(hub);

    const runA = runTask(3, a.deps);
    await firstClaim;
    const runB = runTask(3, b.deps);
    const resultB = await runB;
    assert.equal(resultB.status, 'claimed-by-other', JSON.stringify(resultB));

    releaseFirstClaim();
    const resultA = await runA;
    assert.equal(resultA.status, 'awaiting-merge', JSON.stringify(resultA));

    assert.equal(a.dsh.calls.length, 1);
    assert.equal(b.dsh.calls.length, 0);
    assert.equal(a.publish.calls.filter((call) => call.op === 'ensurePullRequest').length, 1, 'only the winner publishes');
    assert.equal(b.publish.calls.length, 0);
    assert.equal(hub.mergeCalls, 0);
  });

  test('a timeout on ref creation recovers by querying the existing ref', async () => {
    const hub = new FakeHub();
    // pre-existing claim owned by the same worker id (previous run)
    const h = makeHarness(root, { hub });
    hub.seedIssue(makeIssue());
    const owner = { workerId: 'worker-a', runId: 'run-0', specDigest: schemaDigest(validateTaskSpec(makeManifest()).spec), baseSha: SHA_A, issueNumber: 3 };
    const commit = await hub.createCommit({ tree: JSON.stringify(owner), message: 'claim', parents: [SHA_A] });
    hub.refs.set('refs/heads/automation/claim/issue-3', { sha: commit.sha, actor: 'worker-a' });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge', JSON.stringify(result));
    assert.equal(h.dsh.calls.length, 1);
  });

  test('a lost claim owned by another worker never resumes', async () => {
    const hub = new FakeHub();
    const h = makeHarness(root, { hub });
    const owner = { workerId: 'worker-z', runId: 'run-z', specDigest: 'x'.repeat(64), baseSha: SHA_A, issueNumber: 3 };
    const commit = await hub.createCommit({ tree: JSON.stringify(owner), message: 'claim', parents: [SHA_A] });
    hub.refs.set('refs/heads/automation/claim/issue-3', { sha: commit.sha, actor: 'worker-z' });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'claimed-by-other');
    assert.equal(h.dsh.calls.length, 0);
  });

  test('a claim whose author cannot be verified fails closed', async () => {
    const hub = new FakeHub();
    const h = makeHarness(root, { hub });
    const commit = await hub.createCommit({ tree: 'not json', message: 'claim', parents: [SHA_A] });
    hub.refs.set('refs/heads/automation/claim/issue-3', { sha: commit.sha, actor: 'worker-z' });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'claim-unverified');
    assert.equal(h.dsh.calls.length, 0);
  });

  test('an unreachable claim ref fails closed instead of stealing the task', async () => {
    const hub = new FakeHub();
    hub.failNextRefCreate = 'conflict';
    const h = makeHarness(root, { hub });
    hub.createRef = async () => { const e = new Error('conflict'); e.code = 'CONFLICT'; throw e; };
    hub.getRef = async () => { const e = new Error('rate limited'); e.code = 'HTTP_500'; throw e; };
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'claim-unrecoverable');
  });
});

// ---------------------------------------------------------------------------
// Local exclusive lock
// ---------------------------------------------------------------------------

describe('local exclusive lock', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('the same real path cannot be locked twice', async () => {
    const dir = path.join(root, 'ws');
    await fsp.mkdir(dir, { recursive: true });
    const one = await workspaces.acquireLock(dir, { workerId: 'worker-a', runId: 'r1', issueNumber: 3 });
    await assert.rejects(() => workspaces.acquireLock(dir, { workerId: 'worker-b', runId: 'r2', issueNumber: 3 }), /lock/i);
    await one.release();
    const two = await workspaces.acquireLock(dir, { workerId: 'worker-b', runId: 'r2', issueNumber: 3 });
    assert.equal(two.dir, await fsp.realpath(dir));
    await two.release();
  });

  test('a lock held by a live process fails closed even when old', async () => {
    const dir = path.join(root, 'ws-old');
    await fsp.mkdir(dir, { recursive: true });
    const lockFile = lockPathFor(dir);
    await fsp.mkdir(path.dirname(lockFile), { recursive: true });
    await fsp.writeFile(lockFile, JSON.stringify({ pid: process.pid, workerId: 'worker-a', runId: 'r1', startedAt: '2000-01-01T00:00:00.000Z' }));
    await assert.rejects(() => workspaces.acquireLock(dir, { workerId: 'worker-b', runId: 'r2' }), /lock/i);
  });

  test('a lock from a dead process can be recovered explicitly', async () => {
    const dir = path.join(root, 'ws-dead');
    await fsp.mkdir(dir, { recursive: true });
    const lockFile = lockPathFor(dir);
    await fsp.mkdir(path.dirname(lockFile), { recursive: true });
    await fsp.writeFile(lockFile, JSON.stringify({ pid: 999999999, workerId: 'worker-a', runId: 'r1', startedAt: '2000-01-01T00:00:00.000Z' }));
    await assert.rejects(() => workspaces.acquireLock(dir, { workerId: 'worker-b', runId: 'r2' }), /lock/i);
    const recovered = await workspaces.acquireLock(dir, { workerId: 'worker-b', runId: 'r2', recoverDead: true });
    assert.equal(recovered.recovered, true);
    await recovered.release();
  });

  test('locks are keyed on the canonical path', async () => {
    const dir = path.join(root, 'ws-real');
    await fsp.mkdir(dir, { recursive: true });
    // Different lexical forms of the same directory must key to one lock.
    assert.equal(lockPathFor(dir), lockPathFor(path.join(root, 'sub', '..', 'ws-real')));
    assert.equal(lockPathFor(dir), lockPathFor(path.join(dir, '.')));
    // canonicalPath resolves the directory the same way acquireLock does.
    assert.equal(await canonicalPath(dir), await canonicalPath(path.join(root, 'sub', '..', 'ws-real')));
  });

  test('a second task cannot take a workspace directory already locked', async () => {
    const hub = new FakeHub();
    const h = makeHarness(root, { hub });
    fs.mkdirSync(h.workspace.state.dir, { recursive: true });
    const held = await workspaces.acquireLock(h.workspace.state.dir, { workerId: 'worker-a', runId: 'other' });
    if (process.env.DSH_PIPELINE_DEBUG === '1') console.error('[debug] test lock', held.lockFile, fs.existsSync(held.lockFile), h.workspace.state.dir, '| lockPathFor', lockPathFor(h.workspace.state.dir));
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'workspace-locked');
    assert.equal(h.dsh.calls.length, 0);
    await held.release();
  });
});

// ---------------------------------------------------------------------------
// Publication safety
// ---------------------------------------------------------------------------

describe('publication safety', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('refuses main, force, wildcards and deletes', () => {
    const bad = [
      ['push', 'origin', 'main'],
      ['push', 'origin', 'refs/heads/master'],
      ['push', '--force', 'origin', 'HEAD:refs/heads/agent/issue-3-x'],
      ['push', '-f', 'origin', 'HEAD:refs/heads/agent/issue-3-x'],
      ['push', 'origin', '--delete', 'agent/issue-3-x'],
      ['push', 'origin', '--mirror'],
      ['push', 'origin', 'refs/heads/*:refs/heads/*'],
      ['push', 'origin', 'HEAD:refs/heads/agent/issue-3-x', '--force-with-lease'],
      ['push', 'origin', 'HEAD:refs/heads/agent/issue-3-x', 'HEAD:refs/heads/other'],
    ];
    for (const argv of bad) {
      assert.throws(() => assertArgvAllowed(argv, { allowedBranch: 'agent/issue-3-x' }), /refus|forbidden|not allowed|denied/i, `expected refusal for ${argv.join(' ')}`);
    }
    const good = ['push', 'origin', 'HEAD:refs/heads/agent/issue-3-x'];
    assert.doesNotThrow(() => assertArgvAllowed(good, { allowedBranch: 'agent/issue-3-x' }));
  });

  test('refuses any merge API surface', () => {
    const bad = [
      ['api', '--method', 'PUT', 'repos/o/r/pulls/1/merge'],
      ['api', 'repos/o/r/merges'],
      ['pr', 'merge', '1'],
      ['api', '--method', 'DELETE', 'repos/o/r/git/refs/heads/main'],
      ['api', '--method', 'PATCH', 'repos/o/r/git/refs/heads/main'],
      ['api', '--method', 'POST', 'repos/o/r/git/refs', '-f', 'ref=refs/heads/main'],
      ['api', '--method', 'POST', 'repos/o/r/git/refs', '-f', 'ref=refs/heads/agent/issue-3-x', '-f', 'force=true'],
    ];
    for (const argv of bad) {
      assert.throws(() => assertArgvAllowed(argv, { allowedBranch: 'agent/issue-3-x' }), /refus|forbidden|not allowed|denied/i, `expected refusal for ${argv.join(' ')}`);
    }
  });

  test('the pipeline never exposes a merge call to the runner', async () => {
    const hub = new FakeHub();
    const h = makeHarness(root, { hub, publishScript: { reject: 'force push refused' } });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'publish-failed');
    assert.equal(hub.mergeCalls, 0);
    assert.equal(hub.pulls.length, 0);
  });

  test('publishing the exact task branch is allowed', async () => {
    const h = makeHarness(root);
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    const push = h.publish.calls.find((c) => c.op === 'pushBranch');
    assert.equal(push.branch, 'agent/issue-3-npc-schedule');
    assert.equal(push.baseRef, 'setup/codex-dsh-pipeline');
    assert.equal(push.headSha, h.workspace.state.headSha);
  });
});

// ---------------------------------------------------------------------------
// Idempotent PR creation
// ---------------------------------------------------------------------------

describe('pull requests', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('calling ensurePullRequest twice creates one pull request', async () => {
    const calls = [];
    const pulls = [];
    const adapter = {
      async listPulls({ head, base }) { calls.push('list'); return pulls.filter((p) => p.head === head && p.base === base); },
      async createPull({ head, base, title, body, draft }) {
        calls.push('create');
        const pull = { number: pulls.length + 1, head, base, title, body, draft, state: 'open' };
        pulls.push(pull);
        return pull;
      },
    };
    const { ensurePullRequest } = await import('./github.mjs');
    const first = await ensurePullRequest({ adapter, head: 'agent/issue-3-x', base: 'setup/codex-dsh-pipeline', title: 't', body: 'b' });
    const second = await ensurePullRequest({ adapter, head: 'agent/issue-3-x', base: 'setup/codex-dsh-pipeline', title: 't', body: 'b' });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(pulls.length, 1);
    assert.equal(calls.filter((c) => c === 'create').length, 1);
  });

  test('runner calls ensurePullRequest once per run and keeps the issue open', async () => {
    const h = makeHarness(root);
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    assert.equal(h.publish.calls.filter((c) => c.op === 'ensurePullRequest').length, 1);
    assert.equal(h.hub.issues.get(3).state, 'open');
    assert.equal(result.pull.number, 11);
  });
});

// ---------------------------------------------------------------------------
// Fix retry loop and resume
// ---------------------------------------------------------------------------

describe('fix retry loop', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('a failing self test triggers fixes, at most two', async () => {
    const h = makeHarness(root, {
      testScript: () => ({ failures: ['node test.cjs'] }),
      reviewScript: () => ({ verdict: 'needs-fix', findings: [{ severity: 'important', message: '规则未覆盖' }], acceptanceResults: [{ text: 'x', passed: false, evidence: 'failed' }] }),
    });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'retries-exhausted');
    assert.equal(h.dsh.calls.length, 3, 'attempt0 plus two fixes');
    assert.equal(result.fixRetries, 2);
  });

  test('the second fix attempt succeeds', async () => {
    let n = 0;
    const h = makeHarness(root, {
      testScript: () => { n += 1; return n === 1 ? { failures: ['node test.cjs'] } : {}; },
      dshScript: (task) => { if (task.attempt === 0) return {}; return {}; },
      workspaceOpts: {},
    });
    // workspace head must advance for later attempts, otherwise the run stays on failure.
    const hh = h;
    hh.workspace.state.headSha = SHA_A;
    const origDrive = hh.dsh.drive;
    hh.dsh.drive = async (task) => {
      const res = await origDrive(task);
      hh.workspace.state.headSha = task.attempt === 0 ? SHA_B : SHA_C;
      return res;
    };
    const result = await runTask(3, hh.deps);
    assert.equal(result.status, 'awaiting-merge');
    assert.equal(hh.dsh.calls.length, 2);
    assert.equal(result.fixRetries, 1);
  });

  test('a review needs-fix consumes exactly one retry', async () => {
    let reviews = 0;
    const h = makeHarness(root, {
      reviewScript: () => {
        reviews += 1;
        return reviews === 1
          ? { verdict: 'needs-fix', findings: [{ severity: 'important', message: 'nope' }], acceptanceResults: [{ text: 'a', passed: false, evidence: 'no' }] }
          : { verdict: 'pass' };
      },
    });
    const drive = h.dsh.drive;
    h.dsh.drive = async (task) => {
      const res = await drive(task);
      h.workspace.state.headSha = task.attempt === 0 ? SHA_B : SHA_C;
      return res;
    };
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    assert.equal(result.fixRetries, 1);
    assert.equal(h.review.calls.length, 2);
  });

  test('a restart preserves the persisted retry counter and cannot exceed three attempts', async () => {
    const h = makeHarness(root, {
      testScript: () => ({ failures: ['node test.cjs'] }),
      reviewScript: () => ({ verdict: 'needs-fix', findings: [{ severity: 'critical', message: 'bad' }], acceptanceResults: [{ text: 'a', passed: false, evidence: 'no' }] }),
    });
    const drive = h.dsh.drive;
    h.dsh.drive = async (task) => {
      const res = await drive(task);
      h.workspace.state.headSha = SHA_C;
      return res;
    };
    const first = await runTask(3, h.deps);
    assert.equal(first.status, 'blocked');
    const callsAfterFirst = h.dsh.calls.length;
    assert.equal(callsAfterFirst, 3);

    // Simulate a restart: the same persisted state must block without new DSH work.
    const second = await runTask(3, h.deps);
    assert.equal(second.status, 'blocked');
    assert.equal(second.reason, 'retries-exhausted');
    assert.equal(h.dsh.calls.length, callsAfterFirst, 'restart must not reset attempts');
    assert.equal(second.fixRetries, 2);
  });

  test('a resume after one fix consumes only the remaining attempts', async () => {
    const hub = new FakeHub();
    const h = makeHarness(root, { hub, testScript: () => ({ failures: ['node test.cjs'] }) });
    // Pre-seed persisted state from an earlier process that already used one fix.
    const stateFile = path.join(h.config.workspaceRoot, 'state', 'issue-3.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const spec = validateTaskSpec(makeManifest()).spec;
    fs.writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 1,
      issueNumber: 3,
      workerId: 'worker-a',
      runId: 'run-old',
      specDigest: schemaDigest(spec),
      status: 'fixing',
      attempt: 1,
      fixRetries: 1,
      branch: 'agent/issue-3-npc-schedule',
      baseSha: SHA_A,
      headSha: SHA_B,
      phase: 'implement',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'retries-exhausted');
    // attempt0 already happened before the restart; only attempt1 and attempt2
    // remain and the persisted counter is never reset.
    assert.equal(h.dsh.calls.length, 2, 'only the remaining attempts run');
    assert.equal(result.fixRetries, 2);
  });
});

// ---------------------------------------------------------------------------
// DSH contract
// ---------------------------------------------------------------------------

describe('dsh result contract', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('exit 0 without a completed final status is a failure', async () => {
    const h = makeHarness(root, { dshScript: { exitCode: 0, finalStatus: 'error' } });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'dsh-incomplete');
  });

  test('a non-zero exit is a failure even when the final status says completed', async () => {
    const h = makeHarness(root, { dshScript: { exitCode: 2, finalStatus: 'completed' } });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'dsh-exit');
  });

  test('a timeout kills the attempt and blocks', async () => {
    const h = makeHarness(root, { dshScript: { exitCode: 1, finalStatus: 'timeout', timedOut: true } });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'dsh-timeout');
    assert.equal(h.dsh.calls.length, 1, 'a timeout is an infrastructure failure, not a fixable attempt');
  });

  test('an empty diff is never a success', async () => {
    const h = makeHarness(root, {});
    h.workspace.state.headSha = SHA_A;
    h.workspace.inspect = async () => ({ branch: 'agent/issue-3-npc-schedule', headSha: SHA_A, dirty: false, uniqueCommits: 0 });
    // No commit was produced and no file changed.
    h.workspace.commitAll = async () => ({ sha: SHA_A, committed: false });
    h.workspace.changedFiles = async () => [];
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'empty-change');
  });

  test('changes outside allowedPaths are refused', async () => {
    const h = makeHarness(root, {});
    h.workspace.changedFiles = async () => ['game.js'];
    h.workspace.inspect = async () => ({ branch: 'agent/issue-3-npc-schedule', headSha: SHA_B, dirty: false, uniqueCommits: 1, filesChanged: ['game.js'] });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'outside-allowed-paths');
    assert.deepEqual(result.outside, ['game.js']);
  });

  test('the implement prompt is a rendered template, never Issue text on a shell', async () => {
    const h = makeHarness(root, {});
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    const prompt = h.dsh.calls[0].task.prompt;
    assert.match(prompt, /agent\/issue-3-npc-schedule/);
    assert.match(prompt, /game\.js|allowedPaths|allowed paths/i);
    assert.ok(!/\{\{\w+\}\}/.test(prompt), 'no unrendered placeholders');
  });

  test('the fix prompt carries the concrete failure feedback', async () => {
    let n = 0;
    const h = makeHarness(root, { testScript: () => { n += 1; return n === 1 ? { failures: ['node test.cjs'] } : {}; } });
    const drive = h.dsh.drive;
    h.dsh.drive = async (task) => { const r = await drive(task); h.workspace.state.headSha = task.attempt === 0 ? SHA_B : SHA_C; return r; };
    await runTask(3, h.deps);
    const fixPrompt = h.dsh.calls[1].task.prompt;
    assert.match(fixPrompt, /node test\.cjs/);
    assert.match(fixPrompt, /1\/2|attempt1|第 ?1/i);
  });
});

// ---------------------------------------------------------------------------
// Credential isolation
// ---------------------------------------------------------------------------

describe('credential isolation', () => {
  let root;
  const origEnv = { ...process.env };
  beforeEach(async () => {
    root = await mkroot();
    process.env = { ...origEnv, GITHUB_TOKEN: 'ghp_must_not_leak', GH_TOKEN: 'ghp_must_not_leak', DEEPSEEK_API_KEY: 'model-secret', PATH: origEnv.PATH, SystemRoot: origEnv.SystemRoot, USERPROFILE: origEnv.USERPROFILE, HOME: origEnv.HOME, TMP: origEnv.TMP, TEMP: origEnv.TEMP };
  });
  afterEach(async () => {
    process.env = origEnv;
    await fsp.rm(root, { recursive: true, force: true });
  });

  test('GitHub credentials never reach the DSH child', async () => {
    const envs = [];
    const h = makeHarness(root, {});
    h.dsh.drive = async (task) => {
      envs.push({ role: 'dsh', env: task.env });
      h.workspace.state.headSha = SHA_B;
      return { exitCode: 0, finalStatus: 'completed', sessionId: 's', jsonl: [], stderr: '', timedOut: false };
    };
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    const dshEnv = envs[0].env;
    assert.ok(!('GITHUB_TOKEN' in dshEnv), 'GITHUB_TOKEN must be stripped');
    assert.ok(!('GH_TOKEN' in dshEnv), 'GH_TOKEN must be stripped');
  });

  test('the model key never reaches self tests or the review', async () => {
    const h = makeHarness(root, {});
    await runTask(3, h.deps);
    const testEnv = h.tests.calls[0].env;
    assert.ok(!('DEEPSEEK_API_KEY' in testEnv), 'model key must not reach self tests');
    const review = h.review.calls[0];
    assert.ok(!('DEEPSEEK_API_KEY' in review.env), 'model key must not reach review');
    assert.ok(!('GITHUB_TOKEN' in review.env));
  });

  test('the DSH adapter builds an env with the named model key from the credential command only', async () => {
    const mod = await import('./dsh.mjs');
    const env = mod.buildDshEnv({
      baseEnv: { PATH: 'x', GITHUB_TOKEN: 'leak', GH_TOKEN: 'leak', SystemRoot: 'C:\\Windows', DEEPSEEK_API_KEY: 'old' },
      modelKeyEnvName: 'DEEPSEEK_API_KEY',
      modelKey: 'fresh-secret',
    });
    assert.equal(env.DEEPSEEK_API_KEY, 'fresh-secret');
    assert.ok(!('GITHUB_TOKEN' in env));
    assert.ok(!('GH_TOKEN' in env));
    assert.equal(env.PATH, 'x');

    const testEnv = mod.buildChildEnv({ role: 'test', baseEnv: { PATH: 'x', DEEPSEEK_API_KEY: 'model', GITHUB_TOKEN: 'leak', SystemRoot: 'C:\\Windows' } });
    assert.ok(!('DEEPSEEK_API_KEY' in testEnv));
    assert.ok(!('GITHUB_TOKEN' in testEnv));
    assert.equal(testEnv.PATH, 'x');
  });

  test('no credential value appears in the run logs', async () => {
    const h = makeHarness(root, { dshScript: { stderr: 'auth ghp_must_not_leak model-secret leaked' } });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    const store = createLogStore({ dir: h.config.logsDir, machineRoots: [root] });
    const exportPath = await store.exportIssue(3, path.join(root, 'export'));
    const raw = fs.readFileSync(exportPath, 'utf8');
    assert.ok(!raw.includes('ghp_must_not_leak'), 'github token leaked into export');
    assert.ok(!raw.includes('model-secret'), 'model key leaked into export');
    assert.ok(!raw.includes(os.homedir()) || raw.includes('<home>'), 'machine path leaked');
  });
});

// ---------------------------------------------------------------------------
// Review validity
// ---------------------------------------------------------------------------

describe('review validity', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('a stale review of a previous head can never pass', async () => {
    const h = makeHarness(root, { reviewScript: (request) => ({ verdict: 'pass', headSha: SHA_C }) });
    const drive = h.dsh.drive;
    h.dsh.drive = async (task) => { const r = await drive(task); h.workspace.state.headSha = SHA_B; return r; };
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'stale-review');
  });

  test('a review that fails even one acceptance item cannot pass', async () => {
    const h = makeHarness(root, {
      reviewScript: (request) => ({
        verdict: 'pass',
        acceptanceResults: request.acceptance.map((text, i) => ({ text, passed: i === 0, evidence: 'x' })),
      }),
    });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'invalid-review');
  });

  test('an important finding blocks a pass verdict', async () => {
    const h = makeHarness(root, {
      reviewScript: () => ({ verdict: 'pass', findings: [{ severity: 'important', message: '缺少并发覆盖' }] }),
    });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'invalid-review');
  });

  test('a critical finding blocks a pass verdict', async () => {
    const h = makeHarness(root, {
      reviewScript: () => ({ verdict: 'pass', findings: [{ severity: 'critical', message: '凭据泄漏' }] }),
    });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'invalid-review');
  });

  test('the review adapter rejects a verdict with the wrong head sha or digest', async () => {
    const mod = await import('./review.mjs');
    const base = {
      headSha: SHA_B,
      verdict: 'pass',
      acceptanceResults: [{ text: 'a', passed: true, evidence: 'ok' }],
      findings: [],
      testEvidence: [{ command: 'node test.cjs', exitCode: 0, headSha: SHA_B, output: 'ok', startedAt: 'x', endedAt: 'y' }],
    };
    assert.throws(() => mod.assertReviewBinding({ report: base, headSha: SHA_C, specDigest: 'd', expectedDigest: 'd' }), /headSha|stale/i);
    assert.throws(() => mod.assertReviewBinding({ report: base, headSha: SHA_B, specDigest: 'changed', expectedDigest: 'd' }), /digest/i);
    assert.throws(() => mod.assertReviewBinding({ report: { ...base, testEvidence: [{ command: 'node test.cjs', exitCode: 0, headSha: SHA_C, output: 'ok', startedAt: 'x', endedAt: 'y' }] }, headSha: SHA_B, specDigest: 'd', expectedDigest: 'd' }), /testEvidence|headSha/i);
    assert.doesNotThrow(() => mod.assertReviewBinding({ report: base, headSha: SHA_B, specDigest: 'd', expectedDigest: 'd' }));
  });

  test('the review workspace is separate from the development workspace', async () => {
    const h = makeHarness(root, {});
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    assert.equal(h.review.calls.length, 1);
    const reviewRequest = h.review.calls[0];
    assert.equal(h.reviewWorkspaces.calls.length, 1);
    assert.ok(reviewRequest.workspace, 'the reviewer must receive its own workspace');
    assert.notEqual(reviewRequest.workspace.dir, h.workspace.state.dir);
    assert.notEqual(reviewRequest.workspace.repoDir, h.workspace.state.dir);
    assert.equal(reviewRequest.workspace.readOnly, true);
    assert.equal(h.reviewWorkspaces.state.released, true, 'the review workspace lock is released');
    assert.equal(reviewRequest.headSha, h.workspace.state.headSha);
    assert.ok(reviewRequest.mustInvoke.includes('requesting-code-review'));
    assert.ok(reviewRequest.mustInvoke.includes('verification-before-completion'));
    assert.equal(reviewRequest.readOnly, true);
  });

  test('a failed review workspace acquisition blocks before the reviewer runs', async () => {
    const h = makeHarness(root, { reviewWorkspaceOpts: { fail: true } });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'review-workspace-failed');
    assert.equal(h.review.calls.length, 0);
  });

  test('verification evidence must come from a rerun at the reviewed sha', async () => {
    const h = makeHarness(root, {
      reviewScript: (request) => ({
        verdict: 'pass',
        testEvidence: [{ command: 'node test.cjs', exitCode: 0, headSha: SHA_C, output: 'ok', startedAt: 'x', endedAt: 'y' }],
      }),
    });
    h.workspace.state.headSha = SHA_B;
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'invalid-review');
  });
});

// ---------------------------------------------------------------------------
// Spec digest / HEAD change
// ---------------------------------------------------------------------------

describe('spec stability', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('an edited manifest stops the run instead of executing unapproved requirements', async () => {
    const hub = new FakeHub();
    const h = makeHarness(root, { hub });
    const stateFile = path.join(h.config.workspaceRoot, 'state', 'issue-3.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 1,
      issueNumber: 3,
      workerId: 'worker-a',
      runId: 'run-old',
      specDigest: 'f'.repeat(64),
      status: 'implementing',
      attempt: 0,
      fixRetries: 0,
      branch: 'agent/issue-3-npc-schedule',
      baseSha: SHA_A,
      phase: 'implement',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'spec-changed');
    assert.equal(h.dsh.calls.length, 0);
  });

  test('a manifest for another repository, issue number, branch or unreviewed base is refused', async () => {
    const cases = [
      [{ repository: 'other/repo' }, 'spec-mismatch'],
      [{ issueNumber: 4, branch: 'agent/issue-4-x' }, 'spec-mismatch'],
      [{ baseRef: 'setup/other-branch' }, 'spec-mismatch'],
    ];
    for (const [override, reason] of cases) {
      const hub = new FakeHub();
      // The Issue under test is always #3; the manifest is what disagrees.
      hub.seedIssue(makeIssue(makeManifest(override), { number: 3 }));
      const h = makeHarness(root, { hub });
      h.hub.seedIssue(makeIssue(makeManifest(override), { number: 3 }));
      const result = await runTask(3, h.deps);
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      assert.equal(result.reason, reason);
      assert.equal(h.dsh.calls.length, 0);
    }
  });

  test('an unknown base ref is refused before any claim', async () => {
    const hub = new FakeHub();
    const h = makeHarness(root, { hub });
    h.deps.github.commitExists = async () => false;
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'base-missing');
    assert.equal(h.dsh.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Tasks that must not be claimed
// ---------------------------------------------------------------------------

describe('claim preconditions', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('a task without ready-for-agent is skipped', async () => {
    const hub = new FakeHub();
    hub.seedIssue(makeIssue(makeManifest(), { labels: [{ name: 'needs-info' }] }));
    const h = makeHarness(root, { hub });
    h.hub.seedIssue(makeIssue(makeManifest(), { labels: [{ name: 'needs-info' }] }));
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'not-eligible');
    assert.equal(h.dsh.calls.length, 0);
  });

  test('an issue from an unapproved author is not claimed', async () => {
    const hub = new FakeHub();
    hub.seedIssue(makeIssue(makeManifest(), { user: { login: 'stranger' } }));
    const h = makeHarness(root, { hub });
    h.hub.seedIssue(makeIssue(makeManifest(), { user: { login: 'stranger' } }));
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'not-eligible');
    assert.equal(h.dsh.calls.length, 0);
  });

  test('a manifest approved by a non-whitelisted user is not claimed', async () => {
    const hub = new FakeHub();
    hub.seedIssue(makeIssue(makeManifest({ approvedBy: 'stranger' })));
    const h = makeHarness(root, { hub });
    h.hub.seedIssue(makeIssue(makeManifest({ approvedBy: 'stranger' })));
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'not-eligible');
  });

  test('a manifest with an invented issue command block is ignored', async () => {
    const hub = new FakeHub();
    const manifest = makeManifest();
    const issue = makeIssue(manifest);
    issue.body = '# 任务\n\n```sh\nrm -rf /\n```\n\n' + issue.body;
    hub.seedIssue(issue);
    const h = makeHarness(root, { hub });
    h.hub.seedIssue(issue);
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    const prompt = h.dsh.calls[0].task.prompt;
    assert.ok(!prompt.includes('rm -rf /'), 'issue prose must not be interpolated as commands');
    for (const env of [h.tests.calls[0].env, h.review.calls[0].env]) {
      assert.ok(!JSON.stringify(env).includes('rm -rf'), 'no shell from issue text');
    }
  });

  test('a second json block or a malformed manifest is refused', async () => {
    const hub = new FakeHub();
    const issue = makeIssue();
    issue.body += '\n```json\n{"schemaVersion": 1}\n```\n';
    hub.seedIssue(issue);
    const h = makeHarness(root, { hub });
    h.hub.seedIssue(issue);
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'manifest-unusable');
  });

  test('verification commands outside the local allowlist are refused', async () => {
    const hub = new FakeHub();
    const manifest = makeManifest({ verificationCommands: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] });
    hub.seedIssue(makeIssue(manifest));
    const h = makeHarness(root, { hub });
    h.hub.seedIssue(makeIssue(manifest));
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'command-not-allowed');
  });

  test('a task whose base branch is main is refused', async () => {
    const hub = new FakeHub();
    const manifest = makeManifest({ baseRef: 'refs/heads/main' });
    const result = validateTaskSpec(manifest);
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

describe('verification command allowlist', () => {
  test('accepts only the preinstalled command names and argument shapes', () => {
    assert.equal(isAllowedVerificationCommand({ command: 'node', args: ['test.cjs'] }), true);
    assert.equal(isAllowedVerificationCommand({ command: 'node', args: ['--check', 'game.js'] }), true);
    assert.equal(isAllowedVerificationCommand({ command: 'node', args: ['--check', 'test.cjs'] }), true);
    assert.equal(isAllowedVerificationCommand({ command: 'node', args: ['--test', 'tools/pipeline/pipeline.test.mjs'] }), true);
    assert.equal(isAllowedVerificationCommand({ command: 'node.exe', args: ['test.cjs'] }), true);
    for (const bad of [
      { command: 'node', args: ['-e', 'x'] },
      { command: 'node', args: ['--eval', 'x'] },
      { command: 'node', args: ['--check', '../../etc/passwd'] },
      { command: 'node', args: ['--check', 'C:/Windows/win.ini'] },
      { command: 'node', args: ['test.cjs', '&&', 'calc'] },
      { command: 'cmd', args: ['/c', 'dir'] },
      { command: 'powershell', args: ['-c', 'x'] },
      { command: 'git', args: ['push'] },
      { command: 'npm', args: ['install'] },
      { command: 'node test.cjs', args: [] },
      { command: 'node', args: ['--check'] },
      { command: 'node', args: [] },
      { command: 'node', args: ['test.cjs', '--extra'] },
      { command: 'node', args: ['..\\secret.mjs'] },
    ]) {
      assert.equal(isAllowedVerificationCommand(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
    assert.ok(ALLOWED_COMMAND_POLICY.length >= 2);
    assert.equal(verificationPolicy().allowShell, false);
  });
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

describe('logs', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('recording keeps the raw transcript locally', async () => {
    const store = createLogStore({ dir: path.join(root, 'logs'), machineRoots: [root] });
    await store.record(3, { type: 'dsh-stdout', line: 'hello' });
    const files = await store.list(3);
    assert.ok(files.some((f) => f.endsWith('raw.jsonl')));
    const raw = await store.readRaw(3);
    assert.match(raw, /hello/);
  });

  test('export strips secrets, auth headers and machine paths', async () => {
    const store = createLogStore({ dir: path.join(root, 'logs'), machineRoots: [root] });
    await store.record(3, {
      type: 'dsh-stderr',
      text: [
        'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        // A Windows-style absolute path under the real home directory; built
        // from os.homedir() so no personal path is ever recorded in the repo.
        `workspace ${os.homedir()}\\AppData\\Local\\QingfengPipeline\\controller\\tools\\x.mjs`,
        'api key sk-abcdefghijklmnopqrstuvwxyz',
        `home ${os.homedir()}\\secret`,
        root,
      ].join('\n'),
    });
    const out = await store.exportIssue(3, path.join(root, 'export'));
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{8,}/.test(text), text);
    assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(!text.toLowerCase().includes(os.homedir().toLowerCase()), text);
    assert.ok(!text.includes(root));
    assert.match(text, /<redacted|REDACTED/);
  });

  test('the export summary exposes only a digest, status and retry count', async () => {
    const store = createLogStore({ dir: path.join(root, 'logs'), machineRoots: [root] });
    await store.record(3, { type: 'state', status: 'blocked', reason: 'invalid-review', fixRetries: 1, specDigest: 'a'.repeat(64), token: 'ghp_x' });
    const summary = await store.summary(3);
    assert.equal(summary.status, 'blocked');
    assert.equal(summary.fixRetries, 1);
    assert.equal(summary.specDigest, 'a'.repeat(64));
    assert.equal(summary.token, undefined);
    assert.equal(summary.machineRoot, undefined);
  });

  test('redactObject walks nested structures', () => {
    const redacted = redactObject({
      env: { GITHUB_TOKEN: 'ghp_secret_value' },
      nested: [{ header: 'Authorization: token ghp_secret_value' }],
    }, { secrets: ['ghp_secret_value'] });
    const text = JSON.stringify(redacted);
    assert.ok(!text.includes('ghp_secret_value'), text);
  });
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

describe('cli', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('exposes doctor, run, status and export-logs', async () => {
    const cli = createCli({ configPath: path.join(root, '.pipeline', 'config.json') });
    assert.deepEqual([...cli.commands].sort(), ['doctor', 'export-logs', 'run', 'status']);
  });

  test('run --issue N drives the state machine and prints a summary', async () => {
    const h = makeHarness(root, {});
    const file = writeConfig(root, h.config);
    const io = { out: [], err: [] };
    const code = await runCli(['run', '--issue', '3'], {
      configPath: file,
      deps: h.deps,
      stdout: (line) => io.out.push(line),
      stderr: (line) => io.err.push(line),
    });
    assert.equal(code, 0, JSON.stringify(io));
    const summary = JSON.parse(io.out.at(-1));
    assert.equal(summary.status, 'awaiting-merge');
    assert.equal(summary.issueNumber, 3);
  });

  test('status --issue N reports the persisted state without touching the network', async () => {
    const h = makeHarness(root, {});
    const file = writeConfig(root, h.config);
    await runTask(3, h.deps);
    const io = { out: [] };
    const code = await runCli(['status', '--issue', '3'], { configPath: file, deps: { ...h.deps, github: null }, stdout: (l) => io.out.push(l) });
    assert.equal(code, 0);
    const state = JSON.parse(io.out.at(-1));
    assert.equal(state.status, 'awaiting-merge');
    assert.equal(state.attempt, 0);
  });

  test('export-logs --issue N writes a redacted export and never raw credentials', async () => {
    const h = makeHarness(root, {});
    const file = writeConfig(root, h.config);
    await runTask(3, h.deps);
    const io = { out: [] };
    const code = await runCli(['export-logs', '--issue', '3'], { configPath: file, deps: h.deps, stdout: (l) => io.out.push(l) });
    assert.equal(code, 0);
    const summary = JSON.parse(io.out.at(-1));
    assert.ok(summary.exportPath);
    assert.equal(summary.shared, false, 'export is local until a publisher attaches it');
  });

  test('unknown commands and missing --issue fail with usage on stderr', async () => {
    const file = writeConfig(root, makeConfig(root));
    const err = [];
    assert.equal(await runCli(['frobnicate'], { configPath: file, stdout: () => {}, stderr: (l) => err.push(l) }), 2);
    assert.equal(await runCli(['run'], { configPath: file, stdout: () => {}, stderr: (l) => err.push(l) }), 2);
    assert.ok(err.join('\n').match(/usage/i));
  });

  test('doctor reports a missing config and a bad executable without crashing', async () => {
    const io = { out: [], err: [] };
    const code = await runCli(['doctor'], { configPath: path.join(root, 'missing.json'), stdout: (l) => io.out.push(l), stderr: (l) => io.err.push(l) });
    assert.equal(code, 1);
    const report = JSON.parse(io.out.at(-1));
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((c) => c.name === 'config' && c.ok === false));
  });

  test('doctor flags an environment that cannot support a run', async () => {
    const c = makeConfig(root);
    c.dsh.executable = path.join(root, 'missing-electron.exe');
    const file = writeConfig(root, c);
    const io = { out: [] };
    const code = await runCli(['doctor'], { configPath: file, stdout: (l) => io.out.push(l) });
    assert.equal(code, 1);
    const report = JSON.parse(io.out.at(-1));
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((ch) => ch.name === 'dsh-executable' && ch.ok === false));
  });
});

// ---------------------------------------------------------------------------
// Workspace safety
// ---------------------------------------------------------------------------

describe('workspace safety', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('refuses reserved branches and non-agent branch names', () => {
    for (const branch of ['main', 'master', 'refs/heads/main', 'release/x', 'automation/claim/issue-3']) {
      assert.throws(() => workspaces.assertTaskBranch(branch, 3), /branch/i, `expected refusal for ${branch}`);
    }
    assert.equal(workspaces.assertTaskBranch('agent/issue-3-npc-schedule', 3), 'agent/issue-3-npc-schedule');
    assert.throws(() => workspaces.assertTaskBranch('agent/issue-4-x', 3), /branch/i);
  });

  test('refuses a workspace root that contains the controller checkout', async () => {
    const config = makeConfig(root, { workspaceRoot: process.cwd() });
    assert.throws(() => workspaces.assertWorkspaceRoot(config.workspaceRoot, { checkoutRoot: process.cwd() }), /workspace/i);
  });

  test('refuses a dirty workspace', async () => {
    const dir = path.join(root, 'dirty');
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => workspaces.assertClean({ dir, dirty: true }), /clean|dirty/i);
    assert.doesNotThrow(() => workspaces.assertClean({ dir, dirty: false }));
  });

  test('accepts a normal nested root', async () => {
    const config = makeConfig(root);
    fs.mkdirSync(config.workspaceRoot, { recursive: true });
    assert.doesNotThrow(() => workspaces.assertWorkspaceRoot(config.workspaceRoot, { checkoutRoot: process.cwd() }));
  });
});

// ---------------------------------------------------------------------------
// Git helper hardening
// ---------------------------------------------------------------------------

describe('git helper', () => {
  test('always runs with shell disabled and a bounded timeout', async () => {
    const calls = [];
    const result = await gitmod.git(['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      timeoutMs: 1234,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: 'abc\n', stderr: '', error: null };
      },
    });
    assert.equal(result.stdout, 'abc\n');
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide ?? true, true);
    assert.equal(calls[0].options.timeout, 1234);
  });

  test('a git failure surfaces stderr instead of silently passing', async () => {
    await assert.rejects(() => gitmod.git(['push'], {
      cwd: process.cwd(),
      spawn: () => ({ status: 1, stdout: '', stderr: 'rejected', error: null }),
    }), /rejected/);
  });
});

// ---------------------------------------------------------------------------
// Pipeline module surface
// ---------------------------------------------------------------------------

describe('pipeline surface', () => {
  test('the runner refuses to run without every adapter', async () => {
    await assert.rejects(() => runTask(3, { config: makeConfig(os.tmpdir()) }), /adapter|dependency/i);
  });

  test('the runner never closes an issue or merges', async () => {
    const root = await mkroot();
    try {
      const h = makeHarness(root, {});
      await runTask(3, h.deps);
      assert.equal(h.hub.mergeCalls, 0);
      assert.equal(h.hub.issues.get(3).state, 'open');
      const r = await runTask(3, h.deps);
      assert.equal(r.status, 'awaiting-merge');
      assert.equal(h.hub.mergeCalls, 0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Strict output schema: Codex strict Structured Outputs rejects any object
// whose `required` does not list *every* property, at every depth, before the
// model is ever invoked. These are recursive assertions, not spot checks.
// ---------------------------------------------------------------------------

const PIPELINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(PIPELINE_DIR, 'schemas');

function collectObjectSchemas(node, trail, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((entry, i) => collectObjectSchemas(entry, `${trail}[${i}]`, out));
    return out;
  }
  if (node.type === 'object' && node.properties) out.push({ trail, node });
  for (const [key, value] of Object.entries(node)) collectObjectSchemas(value, `${trail}.${key}`, out);
  return out;
}

function assertStrictRecursively(schema, label) {
  const objects = collectObjectSchemas(schema, label);
  assert.ok(objects.length >= 1, `${label}: no object schema found`);
  for (const { trail, node } of objects) {
    assert.equal(node.additionalProperties, false, `${trail}: additionalProperties must be false`);
    const keys = Object.keys(node.properties).sort();
    const required = [...(node.required ?? [])].sort();
    assert.deepEqual(required, keys, `${trail}: required must list every property`);
  }
  return objects.length;
}

describe('strict review output schema', () => {
  test('every object in every published schema requires all of its properties', () => {
    for (const name of ['review.schema.json', 'task.schema.json']) {
      const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
      assertStrictRecursively(schema, name);
    }
    // The in-code published contracts must agree with the JSON documents.
    for (const [name, schema] of [['reviewReportSchema', reviewReportSchema], ['taskManifestSchema', taskManifestSchema]]) {
      assertStrictRecursively(schema, name);
    }
  });

  test('the nested objects carry the exact required sets the API demands', () => {
    const review = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'review.schema.json'), 'utf8'));
    const required = (node) => [...node.required].sort();
    assert.deepEqual(required(review.properties.acceptanceResults.items), ['evidence', 'passed', 'text']);
    assert.deepEqual(required(review.properties.findings.items), ['line', 'message', 'path', 'severity']);
    assert.deepEqual(required(review.properties.testEvidence.items), ['command', 'endedAt', 'exitCode', 'headSha', 'output', 'specDigest', 'startedAt']);
    // A missing nested key is exactly what the live API refused with HTTP 400.
    assert.ok(review.properties.acceptanceResults.items.properties.evidence, 'evidence must stay declared');
    for (const [key, expected] of [['evidence', 'string'], ['path', 'string'], ['line', 'integer'], ['output', 'string'], ['specDigest', 'string']]) {
      const holders = {
        evidence: review.properties.acceptanceResults.items.properties,
        path: review.properties.findings.items.properties,
        line: review.properties.findings.items.properties,
        output: review.properties.testEvidence.items.properties,
        specDigest: review.properties.testEvidence.items.properties,
      };
      assert.equal(holders[key][key].type, expected, `${key} must stay a declared ${expected} sentinel field`);
    }
  });

  test('the runtime validator agrees with the schema sentinels', () => {
    const digest = 'd'.repeat(64);
    const report = {
      headSha: SHA_B,
      verdict: 'pass',
      acceptanceResults: [{ text: 'a', passed: true, evidence: '' }],
      findings: [{ severity: 'nit', message: '风格问题', path: '', line: 0 }],
      testEvidence: [{ command: 'node test.cjs', exitCode: 0, headSha: SHA_B, specDigest: digest, output: '', startedAt: 'x', endedAt: 'y' }],
    };
    const accepted = validateReviewReport(report);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.errors));
    // Controller-built and legacy reports may omit the sentinel keys entirely.
    const withoutSentinels = {
      ...report,
      findings: [{ severity: 'nit', message: '风格问题' }],
      testEvidence: [{ command: 'node test.cjs', exitCode: 0, headSha: SHA_B, startedAt: 'x', endedAt: 'y' }],
    };
    assert.equal(validateReviewReport(withoutSentinels).ok, true);
    // Wrong types are still refused.
    assert.equal(validateReviewReport({ ...report, findings: [{ severity: 'nit', message: 'x', path: '', line: -1 }] }).ok, false);
    assert.equal(validateReviewReport({ ...report, testEvidence: [{ ...report.testEvidence[0], specDigest: 'nope' }] }).ok, false);
    assert.equal(validateReviewReport({ ...report, acceptanceResults: [{ text: 'a', passed: 'yes', evidence: '' }] }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Real Node child DSH adapter. This is the regression for the live failure
// where spawnProcess closed stdin first and createDshAdapter tried to write the
// task afterwards, so the real CLI saw an empty task. The fake CLI is a real
// Node child that reads stdin to end and speaks the installed JSONL shape; no
// promptRunner and no credential command is used.
// ---------------------------------------------------------------------------

const FAKE_DSH_CLI_SOURCE = `'use strict';
// Minimal stand-in for the installed headless DSH CLI: ignore the launcher
// flags, read the whole task from stdin, and emit the JSONL terminal shape.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  if (input.trim().length === 0) {
    process.stdout.write(JSON.stringify({ type: 'error', message: 'a task is required, for example: dsh --profile headless ...' }) + '\\n');
    process.exit(1);
  }
  const sessionIndex = argv.indexOf('--session-id');
  const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : 'fake-session-1';
  const lines = [
    { type: 'session', sessionId },
    { type: 'status', phase: 'turn_start' },
    { type: 'probe', stdin: input, argv },
    { type: 'text', text: input },
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
    { type: 'final', text: input },
  ];
  process.stdout.write(lines.map((line) => JSON.stringify(line)).join('\\n') + '\\n');
  process.exit(0);
});
`;

const CHILD_ENV_KEEP = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC',
  'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'PROGRAMDATA',
];

/** A credential-free base env for the child process under test. */
function testChildEnv(extra = {}) {
  const env = {};
  for (const key of CHILD_ENV_KEEP) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

/**
 * The Windows DSH sandbox forbids piped stdio (spawn EPERM), which is exactly
 * what spawnProcess needs. Probe once so the real-child regression is skipped
 * only for that documented sandbox boundary, never silently.
 */
function canSpawnPipedChild() {
  try {
    const probe = spawnSync(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'], {
      input: 'probe',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * Run the fake CLI as a real Node child with *file-backed* stdio. Pipes are
 * refused by the Windows sandbox, file descriptors are not, so the fake CLI
 * source, its argv handling and the JSONL terminal shape stay genuinely
 * exercised (not skipped) even where the pipe path cannot run.
 */
function runFakeCliWithFiles({ cwd, args, prompt }) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stdinPath = path.join(cwd, `fake-stdin-${stamp}.txt`);
  const stdoutPath = path.join(cwd, `fake-stdout-${stamp}.txt`);
  const stderrPath = path.join(cwd, `fake-stderr-${stamp}.txt`);
  fs.writeFileSync(stdinPath, prompt, 'utf8');
  const inFd = fs.openSync(stdinPath, 'r');
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, args, {
      cwd,
      stdio: [inFd, outFd, errFd],
      windowsHide: true,
      timeout: 30000,
    });
    return {
      status: result.status,
      error: result.error ? result.error.code : null,
      stdout: fs.readFileSync(stdoutPath, 'utf8'),
      stderr: fs.readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

describe('dsh real child adapter', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  function fakeCli() {
    const cli = path.join(root, 'fake-dsh-cli.cjs');
    fs.writeFileSync(cli, FAKE_DSH_CLI_SOURCE, 'utf8');
    return cli;
  }

  test('the resume argv carries the exact session id before the trailing -', () => {
    assert.deepEqual(
      buildDshArgs({ cliEntry: 'cli.js', profile: 'qingfeng-dsh', sessionId: 'sess-resume-7' }),
      ['--expose-internals', 'cli.js', '--profile', 'qingfeng-dsh', '--json', '--session-id', 'sess-resume-7', '-'],
    );
    assert.deepEqual(
      buildDshArgs({ cliEntry: 'cli.js', profile: 'qingfeng-dsh' }).slice(-1),
      ['-'],
    );
  });

  test('the real fake CLI reads the whole prompt and emits the installed JSONL terminal shape', () => {
    const cli = fakeCli();
    const prompt = 'Reply exactly QINGFENG_NATIVE_ADAPTER_OK. Do not use tools.';
    const run = runFakeCliWithFiles({ cwd: root, args: buildDshArgs({ cliEntry: cli, profile: 'qingfeng-dsh' }), prompt });
    assert.equal(run.error, null, `spawn must work with file-backed stdio: ${run.error}`);
    assert.equal(run.status, 0, run.stderr);
    const parsed = parseJsonl(run.stdout);
    assert.deepEqual(parsed.rejected, [], 'the terminal shape must be pure JSONL');
    const probe = parsed.lines.find((line) => line.type === 'probe');
    assert.ok(probe, run.stdout);
    assert.equal(probe.stdin, prompt, 'the child must read the exact nonempty prompt from stdin');
    assert.deepEqual(probe.argv.slice(-2), ['--json', '-']);
    // --expose-internals is a Node loader flag, so it never reaches the CLI.
    assert.deepEqual(probe.argv.slice(0, 2), ['--profile', 'qingfeng-dsh']);
    assert.equal(extractSessionId(parsed.lines), 'fake-session-1');
    const status = extractFinalStatus(parsed.lines, { exitCode: run.status });
    assert.equal(status.finalStatus, 'completed');
    assert.equal(status.rawStatus, 'completed');
    assert.equal(status.sawFinal, true);
  });

  test('the real fake CLI honors a --session-id resume argv', () => {
    const cli = fakeCli();
    const args = buildDshArgs({ cliEntry: cli, profile: 'qingfeng-dsh', sessionId: 'sess-resume-7' });
    const run = runFakeCliWithFiles({ cwd: root, args, prompt: '继续修复上一轮的具体问题。' });
    assert.equal(run.error, null, `spawn must work with file-backed stdio: ${run.error}`);
    assert.equal(run.status, 0, run.stderr);
    const parsed = parseJsonl(run.stdout);
    const probe = parsed.lines.find((line) => line.type === 'probe');
    assert.deepEqual(probe.argv.slice(-4), ['--json', '--session-id', 'sess-resume-7', '-']);
    assert.equal(extractSessionId(parsed.lines), 'sess-resume-7');
    assert.equal(extractFinalStatus(parsed.lines, { exitCode: run.status }).finalStatus, 'completed');
  });

  test('the default production wiring drives a real child and delivers the prompt once', async (t) => {
    if (!canSpawnPipedChild()) return t.skip('the Windows sandbox forbids piped child processes (spawn EPERM)');
    const cli = fakeCli();
    const config = makeConfig(root);
    // Production wiring, real child_process.spawn: only the executable and the
    // entry are substituted for a Node fake.
    config.dsh.executable = process.execPath;
    config.dsh.cliEntry = cli;
    config.dsh.args = [];
    const adapters = createDefaultAdapters({ config, env: testChildEnv() });
    const prompt = 'Reply exactly QINGFENG_NATIVE_ADAPTER_OK. Do not use tools.';
    const result = await adapters.dsh.drive({ prompt, cwd: root, attempt: 0, modelKey: 'test-model-key' });

    assert.equal(result.exitCode, 0, JSON.stringify({ stdout: result.stdoutText, stderr: result.stderr }));
    assert.equal(result.finalStatus, 'completed', JSON.stringify(result.jsonl));
    assert.equal(result.rawStatus, 'completed');
    assert.equal(result.sessionId, 'fake-session-1');
    assert.equal(result.stdinDelivered, true);
    const probe = result.jsonl.find((line) => line.type === 'probe');
    assert.ok(probe, `the fake CLI must report what it read: ${JSON.stringify(result.jsonl)}`);
    assert.equal(probe.stdin, prompt, 'the nonempty prompt must arrive through stdin exactly once');
    assert.deepEqual(probe.argv.slice(-2), ['--json', '-']);
    assert.ok(!probe.argv.includes('--session-id'), 'a fresh attempt must not resume a session');
    // --expose-internals is consumed by the Node/Electron loader, not the CLI.
    assert.deepEqual(probe.argv.slice(0, 2), ['--profile', 'qingfeng-dsh']);
    assert.equal(result.args[0], '--expose-internals', 'the launcher flag stays in the controller argv');
  });

  test('a resume attempt passes --session-id and still delivers the prompt', async (t) => {
    if (!canSpawnPipedChild()) return t.skip('the Windows sandbox forbids piped child processes (spawn EPERM)');
    const cli = fakeCli();
    const config = makeConfig(root);
    config.dsh.executable = process.execPath;
    config.dsh.cliEntry = cli;
    config.dsh.args = [];
    const adapters = createDefaultAdapters({ config, env: testChildEnv() });
    const prompt = '继续修复上一轮的具体问题。';
    const result = await adapters.dsh.drive({ prompt, cwd: root, attempt: 1, sessionId: 'sess-resume-7', modelKey: 'test-model-key' });

    assert.equal(result.exitCode, 0, JSON.stringify({ stdout: result.stdoutText, stderr: result.stderr }));
    assert.equal(result.finalStatus, 'completed');
    assert.equal(result.sessionId, 'sess-resume-7');
    const probe = result.jsonl.find((line) => line.type === 'probe');
    assert.deepEqual(probe.argv.slice(-4), ['--json', '--session-id', 'sess-resume-7', '-']);
    assert.equal(probe.stdin, prompt);
  });

  test('an empty stdin is still a hard failure, never a completed run', async (t) => {
    if (!canSpawnPipedChild()) return t.skip('the Windows sandbox forbids piped child processes (spawn EPERM)');
    const cli = fakeCli();
    const config = makeConfig(root);
    config.dsh.executable = process.execPath;
    config.dsh.cliEntry = cli;
    const adapters = createDefaultAdapters({ config, env: testChildEnv() });
    const result = await adapters.dsh.drive({ prompt: '', cwd: root, attempt: 0, modelKey: 'test-model-key' });
    assert.equal(result.finalStatus, 'incomplete');
    assert.equal(result.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// Doctor launcher verification: an entry inside an Electron ASAR archive is
// virtual, so fs.existsSync cannot see it even though the executable resolved
// it. The exact --expose-internals <entry> --version probe is the authority.
// ---------------------------------------------------------------------------

const asarCliEntry = (dir) => path.join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');

function doctorConfig(dir, cliEntry) {
  const config = makeConfig(dir);
  config.dsh.executable = process.execPath;
  config.dsh.cliEntry = cliEntry;
  config.review.executable = process.execPath;
  config.review.cliEntry = null;
  config.review.outputSchemaPath = path.join(SCHEMA_DIR, 'review.schema.json');
  return config;
}

describe('doctor launcher verification', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('an ASAR entry resolved by the exact executable probe is not reported missing', async () => {
    const entry = asarCliEntry(root);
    const file = writeConfig(root, doctorConfig(root, entry));
    const calls = [];
    const run = async ({ command, args }) => { calls.push({ command, args }); return { status: 0, stdout: '0.2.1-rc.2\n', stderr: '', timedOut: false }; };
    const io = { out: [], err: [] };
    const code = await runCli(['doctor'], {
      configPath: file,
      deps: { run, github: { probe: async () => ({ login: 'tester' }) } },
      stdout: (line) => io.out.push(line),
      stderr: (line) => io.err.push(line),
    });
    const report = JSON.parse(io.out.at(-1));
    assert.equal(fs.existsSync(entry), false, 'the fixture entry must be virtual, like a real ASAR entry');
    assert.equal(isAsarEntry(entry), true, 'an app.asar path must be recognized as virtual');
    const entryCheck = report.checks.find((c) => c.name === 'dsh-cli-entry');
    assert.equal(entryCheck.ok, true, JSON.stringify(entryCheck));
    assert.equal(entryCheck.status, 'ok');
    assert.equal(code, 0, JSON.stringify(report.checks));
    const probe = calls.find((c) => c.args.includes(entry));
    assert.ok(probe, 'the executable must be probed with the exact entry');
    assert.deepEqual(probe.args, ['--expose-internals', entry, '--version']);
    assert.equal(probe.command, process.execPath);
  });

  test('an ASAR entry the executable cannot resolve still fails', async () => {
    const entry = asarCliEntry(root);
    const file = writeConfig(root, doctorConfig(root, entry));
    const run = async () => ({ status: 1, stdout: '', stderr: 'Cannot find module', timedOut: false });
    const io = { out: [] };
    const code = await runCli(['doctor'], {
      configPath: file,
      deps: { run, github: { probe: async () => ({ login: 'tester' }) } },
      stdout: (line) => io.out.push(line),
      stderr: () => {},
    });
    const report = JSON.parse(io.out.at(-1));
    const entryCheck = report.checks.find((c) => c.name === 'dsh-cli-entry');
    assert.equal(entryCheck.ok, false);
    assert.equal(entryCheck.status, 'failed');
    assert.equal(code, 1);
  });

  test('a plain missing entry still fails, and an unprobed ASAR entry is unverified', async () => {
    const missing = path.join(root, 'nope', 'cli.js');
    const missingCheck = entryCheck('dsh-cli-entry', missing, null);
    assert.equal(missingCheck.ok, false);
    assert.equal(missingCheck.status, 'failed');

    const entry = asarCliEntry(root);
    const unprobed = entryCheck('dsh-cli-entry', entry, null);
    assert.equal(unprobed.ok, false, 'a virtual entry without a probe is never "ok"');
    assert.equal(unprobed.status, 'unverified');
    const blocked = entryCheck('dsh-cli-entry', entry, { ok: false, status: 'blocked' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 'blocked');
  });
});

// ---------------------------------------------------------------------------
// Draft PR workflow order: publish the exact verified head as one draft PR
// before the independent review, and reuse that same PR through the fixes.
// ---------------------------------------------------------------------------

describe('draft PR workflow order', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('the single draft PR is published before review and reused across a fix round', async () => {
    let reviews = 0;
    const h = makeHarness(root, {
      reviewScript: () => {
        reviews += 1;
        return reviews === 1
          ? { verdict: 'needs-fix', findings: [{ severity: 'important', message: '第一轮未通过' }], acceptanceResults: [{ text: 'a', passed: false, evidence: 'no' }] }
          : { verdict: 'pass' };
      },
    });
    const drive = h.dsh.drive;
    h.dsh.drive = async (task) => {
      const res = await drive(task);
      h.workspace.state.headSha = task.attempt === 0 ? SHA_B : SHA_C;
      return res;
    };
    const order = [];
    const pushes = [];
    const pulls = [];
    h.publish.pushBranch = async (request) => {
      order.push('pushBranch');
      pushes.push({ branch: request.branch, headSha: request.headSha });
      return { branch: request.branch, sha: request.headSha, created: true };
    };
    h.publish.ensurePullRequest = async (request) => {
      order.push('ensurePullRequest');
      const existing = pulls.find((pull) => pull.branch === request.branch && pull.base === request.baseRef);
      if (existing) return { number: existing.number, url: existing.url, created: false, draft: true, state: 'open' };
      const created = { number: 11, url: 'https://example.invalid/pull/11', branch: request.branch, base: request.baseRef };
      pulls.push(created);
      return { ...created, created: true, draft: true, state: 'open' };
    };
    const reviewOnce = h.review.review.bind(h.review);
    h.review.review = async (request) => { order.push('review'); return reviewOnce(request); };

    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge', JSON.stringify(order));
    const firstReview = order.indexOf('review');
    assert.ok(firstReview > 0, `review must have run: ${order.join(',')}`);
    assert.ok(order.indexOf('pushBranch') < firstReview, `push before review: ${order.join(',')}`);
    assert.ok(order.indexOf('ensurePullRequest') < firstReview, `draft PR before review: ${order.join(',')}`);
    assert.deepEqual(pushes.map((push) => push.headSha), [SHA_B, SHA_C]);
    assert.ok(pushes.every((push) => push.branch === 'agent/issue-3-npc-schedule'));
    assert.equal(pulls.length, 1, 'the fix round reuses the same draft PR instead of creating a duplicate');
    assert.deepEqual(h.review.calls.map((call) => call.headSha), [SHA_B, SHA_C], 'each review is bound to the exact new head');
    assert.equal(result.pull.number, 11);
    assert.equal(h.hub.issues.get(3).state, 'open');
    assert.equal(h.hub.mergeCalls, 0);
  });

  test('a failed review keeps the draft PR open with concrete persisted feedback', async () => {
    const h = makeHarness(root, {
      reviewScript: () => ({
        verdict: 'blocked',
        findings: [{ severity: 'critical', message: '验收证据缺失：没有重跑 node test.cjs' }],
      }),
    });
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'review-blocked');
    const ensure = h.publish.calls.filter((call) => call.op === 'ensurePullRequest');
    assert.equal(ensure.length, 1, 'the draft PR was opened before the review failed');
    assert.equal(ensure[0].draft, true);
    assert.equal(result.pull.number, 11);
    const state = JSON.parse(fs.readFileSync(path.join(h.config.workspaceRoot, 'state', 'issue-3.json'), 'utf8'));
    assert.equal(state.status, 'blocked');
    assert.equal(state.pull.number, 11, 'the draft PR reference is persisted on failure');
    assert.ok(
      state.feedback.lines.some((line) => line.includes('验收证据缺失')),
      `concrete feedback must be persisted: ${JSON.stringify(state.feedback)}`,
    );
  });

  test('the default self-test runner preserves full stdout and stderr', async () => {
    const { createTestRunner } = await import('./runner.mjs');
    const config = makeConfig(root);
    const runner = createTestRunner({
      config,
      env: { PATH: 'x' },
      run: async () => ({ status: 0, stdout: 'full stdout\n', stderr: 'full stderr\n', timedOut: false }),
    });
    const out = await runner.run({
      commands: [{ command: 'node', args: ['test.cjs'] }],
      cwd: root,
      headSha: SHA_B,
      specDigest: 'e'.repeat(64),
    });
    assert.equal(out.passed, true);
    assert.equal(out.results[0].stdout, 'full stdout\n');
    assert.equal(out.results[0].stderr, 'full stderr\n');
    assert.equal(out.results[0].output, 'full stdout\nfull stderr\n');
    assert.equal(out.results[0].headSha, SHA_B);
    assert.equal(out.results[0].specDigest, 'e'.repeat(64));
  });

  test('the run log keeps the full self-test stdout and stderr', async () => {
    const h = makeHarness(root, {});
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'awaiting-merge');
    const store = createLogStore({ dir: h.config.logsDir, machineRoots: [root] });
    const raw = await store.readRaw(3);
    const selftest = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === 'selftest');
    assert.ok(selftest, 'the self-test must be recorded');
    assert.equal(selftest.results[0].stdout, 'selftest stdout ok');
    assert.ok('stderr' in selftest.results[0], 'stderr must be preserved, not dropped');
    assert.equal(selftest.passed, true);
  });

  test('the production adapter bundle is wired with real adapters, not stubs', async () => {
    const config = makeConfig(root);
    fs.mkdirSync(config.workspaceRoot, { recursive: true });
    const adapters = createDefaultAdapters({ config, env: testChildEnv() });
    for (const [name, member] of [
      ['github', 'getIssue'], ['github', 'acquireClaim'], ['github', 'commitExists'],
      ['workspaces', 'acquire'], ['dsh', 'drive'], ['dsh', 'readModelKey'],
      ['tests', 'run'], ['review', 'review'],
      ['publish', 'pushBranch'], ['publish', 'ensurePullRequest'], ['reviewWorkspaces', 'acquire'],
    ]) {
      assert.equal(typeof adapters[name]?.[member], 'function', `${name}.${member} must be wired`);
    }
    for (const method of ['merge', 'closeIssue']) {
      assert.equal(adapters.publish[method] !== undefined, true);
      await assert.rejects(() => adapters.publish[method]({}), /refused|never/i);
    }
  });
});

// ---------------------------------------------------------------------------
// State integrity: corrupt local state and failed remote persistence fail
// closed. A green unit suite must never be able to fake a live loop.
// ---------------------------------------------------------------------------

describe('state integrity', () => {
  let root;
  beforeEach(async () => { root = await mkroot(); });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('a corrupt state file blocks without starting work or resetting counters', async () => {
    const h = makeHarness(root, {});
    const stateFile = path.join(h.config.workspaceRoot, 'state', 'issue-3.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{ this is not json');
    const result = await runTask(3, h.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'state-corrupt');
    assert.equal(h.dsh.calls.length, 0, 'a corrupt state must not start any DSH work');
    assert.equal(h.review.calls.length, 0);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ this is not json', 'corrupt bytes are preserved for the operator');
    const again = await runTask(3, h.deps);
    assert.equal(again.status, 'blocked');
    assert.equal(again.reason, 'state-corrupt', 'a restart stays blocked instead of silently resetting');
  });

  test('a failed remote persistence fails closed instead of claiming progress', async () => {
    const h = makeHarness(root, {});
    h.deps.github.writeStatus = async () => { throw new Error('status ref unavailable'); };
    await assert.rejects(() => runTask(3, h.deps), /status|persist/i);
    assert.equal(h.dsh.calls.length, 0, 'nothing runs when the claim cannot be persisted remotely');
    assert.equal(h.hub.issues.get(3).state, 'open');
  });
});
