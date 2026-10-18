// Task state machine. One task at a time; DSH implements and self-tests, the
// controller commits the verified diff and publishes the exact head as a single
// draft PR, and Codex reviews that published head independently. The same draft
// PR is reused across the (at most two) fix rounds; the Issue is never closed
// and nothing is merged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { runProcess } from './runcmd.mjs';
import { schemaDigest, extractManifest, validateReviewReport } from './schemas.mjs';
import { isAllowedVerificationCommand, verificationCommandProblem, DEFAULT_VERIFICATION_COMMANDS } from './allowlist.mjs';
import { buildChildEnv, buildTestEnv } from './dsh.mjs';
import { evaluateReviewPolicy, assertReviewBinding } from './review.mjs';
import { renderImplementPrompt } from './prompts.mjs';
import { buildPullRequestBody } from './publish.mjs';
import { redactText, pathKey } from './redact.mjs';
import { createLogStore } from './logs.mjs';
import { WorkspaceError } from './workspaces.mjs';

const READY_LABEL = 'ready-for-agent';
const STATE_VERSION = 1;

class AdapterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdapterError';
  }
}

class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
    this.code = 'STATE_CORRUPT';
  }
}

class RemotePersistenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RemotePersistenceError';
    this.code = 'REMOTE_PERSISTENCE';
  }
}

function requireFunction(adapters, name, member) {
  if (!adapters?.[name] || typeof adapters[name][member] !== 'function') {
    throw new AdapterError(`runner requires adapter "${name}.${member}"`);
  }
}

/** Every external capability must be injected explicitly. */
export function assertAdapters(deps = {}) {
  if (!deps.config) throw new AdapterError('runner requires a config');
  for (const [name, member] of [
    ['github', 'getIssue'],
    ['github', 'acquireClaim'],
    ['github', 'commitExists'],
    ['workspaces', 'acquire'],
    ['dsh', 'drive'],
    ['tests', 'run'],
    ['review', 'review'],
    ['publish', 'pushBranch'],
    ['publish', 'ensurePullRequest'],
  ]) {
    requireFunction(deps, name, member);
  }
  return true;
}

function nowIso(deps) {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function randomRunId() {
  return `run-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function stateFileFor(config, issueNumber) {
  return path.join(config.workspaceRoot, 'state', `issue-${issueNumber}.json`);
}

function defaultState(issueNumber) {
  return {
    schemaVersion: STATE_VERSION,
    issueNumber,
    workerId: null,
    runId: null,
    specDigest: null,
    status: 'new',
    reason: null,
    attempt: 0,
    fixRetries: 0,
    phase: 'claim',
    branch: null,
    baseSha: null,
    baseRef: null,
    headSha: null,
    sessionId: null,
    feedback: null,
    lastReason: null,
    pull: null,
    updatedAt: null,
  };
}

export function loadState(config, issueNumber) {
  const file = stateFileFor(config, issueNumber);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultState(issueNumber);
    throw new StateError(`task state ${file} cannot be read: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // A corrupt state file must fail closed: restarting must never silently
    // reset the attempt/fix counters to zero.
    throw new StateError(`task state ${file} is corrupt and cannot be trusted: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== STATE_VERSION) {
    throw new StateError(`task state ${file} has an unsupported shape`);
  }
  return { ...defaultState(issueNumber), ...parsed };
}

export async function saveState(config, issueNumber, state) {
  const file = stateFileFor(config, issueNumber);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const payload = { ...state, schemaVersion: STATE_VERSION, issueNumber, updatedAt: state.updatedAt ?? new Date().toISOString() };
  await fsp.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function fulfil(state, status, extra = {}) {
  return { ...state, ...extra, status };
}

/** Shared preconditions: label, author, manifest schema, repository, branch, base. */
export function checkEligibility({ issue, manifestResult, config }) {
  if (!issue || issue.state !== 'open') return { ok: false, reason: 'issue-not-open' };
  const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
  if (!labels.includes(READY_LABEL)) return { ok: false, reason: 'label-missing' };
  const author = issue.user?.login ?? '';
  if (!config.approvedUsers.includes(author)) return { ok: false, reason: 'author-not-approved' };
  // A ready-for-agent task whose manifest is broken is a blocking problem, not a
  // silently skipped task: the manifest is the approved contract.
  if (!manifestResult.ok) return { ok: false, reason: 'manifest-unusable', errors: manifestResult.errors };
  const spec = manifestResult.spec;
  if (!config.approvedUsers.includes(spec.approvedBy)) return { ok: false, reason: 'approver-not-approved' };
  if (spec.issueNumber !== issue.number) return { ok: false, reason: 'spec-mismatch', detail: 'issueNumber' };
  if (spec.repository !== config.repository) return { ok: false, reason: 'spec-mismatch', detail: 'repository' };
  if (spec.baseRef.replace(/^refs\/heads\//, '') !== config.baseRef.replace(/^refs\/heads\//, '')) {
    return { ok: false, reason: 'spec-mismatch', detail: 'baseRef' };
  }
  for (const entry of spec.verificationCommands) {
    const problem = verificationCommandProblem(entry) ?? (isAllowedVerificationCommand(entry) ? null : 'not allowed');
    if (problem) return { ok: false, reason: 'command-not-allowed', detail: problem };
  }
  return { ok: true, spec, labels };
}

/** Re-check the frozen manifest on every round and before publication. */
export function assertSpecUnchanged({ state, digest }) {
  if (state.specDigest && state.specDigest !== digest) {
    throw new WorkspaceError(`approved spec digest changed from ${state.specDigest} to ${digest}; refusing to continue with unapproved requirements`);
  }
  return true;
}

function isInsideAllowed(file, allowedPaths) {
  const normalized = String(file).replace(/\\/g, '/');
  return allowedPaths.some((prefix) => {
    const clean = String(prefix).replace(/^\.\//, '').replace(/\/$/, '');
    if (clean.length === 0) return false;
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
}

export function assertChangesAllowed({ files, allowedPaths, baseSha, headSha }) {
  if (baseSha === headSha) return { ok: false, reason: 'empty-change', outside: [] };
  const outside = (files ?? []).filter((file) => !isInsideAllowed(file, allowedPaths));
  if (outside.length > 0) return { ok: false, reason: 'outside-allowed-paths', outside };
  if ((files ?? []).length === 0) return { ok: false, reason: 'empty-change', outside: [] };
  return { ok: true, outside: [] };
}

/** Default self-test runner: fixed commands, sanitized env, no model key. */
export function createTestRunner({ config, run = runProcess, env = process.env } = {}) {
  return {
    async run({ commands, cwd, headSha, specDigest = null, role = 'test' }) {
      const childEnv = buildTestEnv({ baseEnv: env });
      const results = [];
      for (const entry of commands) {
        const startedAt = new Date().toISOString();
        const result = await run({ command: entry.command, args: entry.args, cwd, env: childEnv, timeoutMs: config.timeouts?.testMs ?? 300000 });
        const stdout = redactText(result.stdout ?? '', {});
        const stderr = redactText(result.stderr ?? '', {});
        results.push({
          command: `${entry.command} ${entry.args.join(' ')}`.trim(),
          exitCode: result.status,
          // Full local evidence: the original stdout/stderr are never discarded.
          stdout,
          stderr,
          output: `${stdout}${stderr}`,
          startedAt,
          endedAt: new Date().toISOString(),
          headSha,
          specDigest,
          timedOut: Boolean(result.timedOut),
        });
      }
      return { passed: results.every((item) => item.exitCode === 0), results, headSha, specDigest, env: childEnv, role };
    },
  };
}

async function runSelfTests({ config, tests, env, issueNumber, commands, repoDir, headSha, specDigest = null, reasonOnFail }) {
  const result = await tests.run({
    issueNumber,
    commands,
    cwd: repoDir,
    headSha,
    specDigest,
    env: buildTestEnv({ baseEnv: env }),
    baseEnv: env,
    role: 'test',
  });
  if (result.passed) return { passed: true, result };
  return { passed: false, reason: reasonOnFail ?? 'selftest-failed', result };
}

function feedbackFromTests({ result, attempt, maxFixRetries }) {
  const failed = (result.results ?? []).filter((item) => item.exitCode !== 0);
  return {
    attempt,
    fixRetriesLeft: Math.max(0, maxFixRetries - attempt),
    lines: failed.map((item) => `[exit ${item.exitCode}] ${item.command}\n${item.output ?? ''}`),
  };
}

function feedbackFromReview({ report, attempt }) {
  return {
    attempt,
    lines: [
      ...(report.findings ?? []).map((finding) => `[${finding.severity}] ${finding.message}`),
      ...(report.acceptanceResults ?? []).filter((entry) => !entry.passed).map((entry) => `[acceptance] ${entry.text}`),
    ],
  };
}

function renderFixSection(feedback, attempt, totalAttempts) {
  if (!feedback || attempt === 0) {
    return '## 修复反馈\n\n本轮是首轮实现，无历史反馈。';
  }
  return [
    `## 修复反馈（第 ${attempt} 轮，共 ${totalAttempts} 轮）`,
    '',
    '上一轮未通过，必须针对下列具体问题修复，不要重写无关代码：',
    '',
    ...(feedback.lines ?? []).map((line) => `- ${line}`),
  ].join('\n');
}

/**
 * Drive one task to a terminal local state.
 * Terminal statuses: awaiting-merge, blocked, not-eligible, claimed-by-other.
 */
export async function runTask(issueNumber, deps = {}) {
  assertAdapters(deps);
  const { config, github, workspaces, dsh, tests, publish, review } = deps;
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new AdapterError('issueNumber must be a positive integer');

  const env = deps.env ?? process.env;
  const logStore = deps.logs ?? createLogStore({ dir: config.logsDir, machineRoots: [config.workspaceRoot, config.logsDir] });
  const runId = deps.runId ?? randomRunId();
  let state;
  try {
    state = loadState(config, issueNumber);
  } catch (err) {
    // Corrupt local state fails closed: the attempt counters are never reset.
    const corrupt = defaultState(issueNumber);
    corrupt.workerId = config.workerId;
    corrupt.runId = runId;
    corrupt.status = 'blocked';
    corrupt.reason = 'state-corrupt';
    corrupt.detail = err.message;
    return { issueNumber, ...corrupt };
  }
  state.workerId = config.workerId;
  state.runId = runId;

  const log = async (event) => {
    try {
      await logStore.record(issueNumber, event);
    } catch {
      /* logging must never break a run */
    }
  };
  const commitState = async (status, extra = {}) => {
    state = { ...state, ...extra, status, updatedAt: nowIso(deps) };
    await saveState(config, issueNumber, state);
    await log({ type: 'state', ...state });
    if (typeof github.writeStatus === 'function') {
      try {
        await github.writeStatus(issueNumber, {
          schemaVersion: 1,
          issueNumber,
          workerId: state.workerId,
          runId,
          status,
          reason: state.reason ?? null,
          attempt: state.attempt,
          fixRetries: state.fixRetries,
          specDigest: state.specDigest,
          baseSha: state.baseSha,
          headSha: state.headSha,
          head: state.headSha,
          branch: state.branch,
          updatedAt: state.updatedAt,
        });
      } catch (err) {
        // Remote persistence is part of the claim contract: a failed write
        // fails closed rather than pretending the run advanced.
        await log({ type: 'remote-status-failed', message: err.message, status });
        throw new RemotePersistenceError(`remote status persistence failed for issue ${issueNumber}: ${err.message}`);
      }
    }
    return state;
  };

  const outcome = (status, extra = {}) => ({ issueNumber, status, ...state, ...extra });
  const finish = async (status, extra = {}) => {
    state = { ...state, ...extra, status, updatedAt: state.updatedAt ?? nowIso(deps) };
    await saveState(config, issueNumber, state);
    return outcome(status, extra);
  };

  // --- 1. read issue and validate the frozen manifest -----------------------
  const issue = await github.getIssue(issueNumber);
  // The manifest is validated structurally here; the configured repository is
  // enforced by checkEligibility so a mismatch is reported as spec-mismatch.
  const manifestResult = extractManifest(issue.body ?? '', { expectedRepository: null });
  const eligibility = checkEligibility({ issue, manifestResult, config });
  if (!eligibility.ok) {
    await log({ type: 'not-eligible', reason: eligibility.reason, errors: eligibility.errors ?? null });
    const skipped = eligibility.reason === 'label-missing' || eligibility.reason === 'author-not-approved'
      || eligibility.reason === 'issue-not-open' || eligibility.reason === 'approver-not-approved';
    if (skipped) return finish('not-eligible', { reason: eligibility.reason });
    await commitState('blocked', { reason: eligibility.reason });
    return outcome('blocked', { reason: eligibility.reason, detail: eligibility.detail ?? null });
  }
  const spec = eligibility.spec;
  const digest = schemaDigest(spec);

  try {
    assertSpecUnchanged({ state, digest });
  } catch (err) {
    state = { ...state, specDigest: state.specDigest ?? digest, reason: 'spec-changed' };
    await commitState('blocked', { reason: 'spec-changed' });
    return outcome('blocked', { reason: 'spec-changed', detail: redactText(err.message, { machineRoots: [config.workspaceRoot] }) });
  }
  const branch = spec.branch;

  // --- 2. base commit must exist on the approved base ref -------------------
  let baseOk = false;
  try {
    baseOk = await github.commitExists({ sha: spec.baseSha, ref: spec.baseRef });
  } catch (err) {
    await commitState('blocked', { reason: 'base-check-failed', detail: err.message });
    return outcome('blocked', { reason: 'base-check-failed' });
  }
  if (!baseOk) {
    state = { ...state, specDigest: state.specDigest ?? digest, baseSha: spec.baseSha, baseRef: spec.baseRef, branch };
    await commitState('blocked', { reason: 'base-missing' });
    return outcome('blocked', { reason: 'base-missing' });
  }

  // --- 3. atomic remote claim ----------------------------------------------
  let claim;
  try {
    claim = await github.acquireClaim({ spec, workerId: config.workerId, runId, digest });
  } catch (err) {
    await log({ type: 'claim-failed', message: err.message });
    await commitState('blocked', { reason: 'claim-failed' });
    return outcome('blocked', { reason: 'claim-failed' });
  }
  if (claim.claimed) {
    state = { ...state, specDigest: digest, baseSha: spec.baseSha, baseRef: spec.baseRef, branch, phase: 'implement' };
    await commitState('claimed', { specDigest: digest, baseSha: spec.baseSha, baseRef: spec.baseRef, branch, phase: 'implement' });
  } else {
    if (claim.reason === 'unrecoverable') {
      await log({ type: 'claim-unrecoverable', error: claim.error ?? null });
      await commitState('blocked', { reason: 'claim-unrecoverable' });
      return outcome('blocked', { reason: 'claim-unrecoverable' });
    }
    let owner = claim.owner ?? null;
    if (!owner && typeof github.ownerOfClaim === 'function') {
      try {
        const looked = await github.ownerOfClaim(issueNumber);
        owner = looked?.owner ?? null;
      } catch (err) {
        await log({ type: 'claim-query-failed', message: err.message });
        await commitState('blocked', { reason: 'claim-unrecoverable' });
        return outcome('blocked', { reason: 'claim-unrecoverable' });
      }
    }
    if (!owner) {
      await commitState('blocked', { reason: 'claim-unverified' });
      return outcome('blocked', { reason: 'claim-unverified' });
    }
    if (owner.workerId !== config.workerId) {
      await commitState('claimed-by-other', { reason: 'claimed-by-other' });
      return outcome('claimed-by-other', { reason: 'claimed-by-other', owner: { workerId: owner.workerId } });
    }
    if (owner.specDigest && owner.specDigest !== digest) {
      await commitState('blocked', { reason: 'claim-spec-mismatch' });
      return outcome('blocked', { reason: 'claim-spec-mismatch' });
    }
    state = { ...state, specDigest: digest, baseSha: spec.baseSha, baseRef: spec.baseRef, branch };
    await commitState('claimed', { specDigest: digest, baseSha: spec.baseSha, baseRef: spec.baseRef, branch, reclaimed: true });
  }

  // --- 4. exclusive local workspace ----------------------------------------
  let workspace;
  try {
    if (process.env.DSH_PIPELINE_DEBUG === '1') {
      console.error('[debug] acquiring workspace', workspaces.dirFor ? workspaces.dirFor({ repository: spec.repository, issueNumber: spec.issueNumber }) : null, 'runId', runId);
    }
    workspace = await workspaces.acquire({ task: spec, workerId: config.workerId, runId });
    if (process.env.DSH_PIPELINE_DEBUG === '1') console.error('[debug] acquired', workspace.dir);
  } catch (err) {
    if (process.env.DSH_PIPELINE_DEBUG === '1') console.error('[debug] acquire failed', err.name, err.message);
    const reason = err instanceof WorkspaceError && err.name === 'LockError' ? 'workspace-locked' : 'workspace-failed';
    await commitState('blocked', { reason, detail: redactText(err.message, { machineRoots: [config.workspaceRoot] }) });
    return outcome('blocked', { reason });
  }
  const repoDir = workspace.repoDir ?? workspace.dir;
  let modelKey = null;
  try {
    if (typeof dsh.readModelKey === 'function') {
      modelKey = await dsh.readModelKey();
      if (typeof logStore.addSecret === 'function') logStore.addSecret(modelKey);
    }
  } catch (err) {
    await commitState('blocked', { reason: 'model-credential-missing', detail: err.message });
    if (typeof workspaces.release === 'function') await workspaces.release(workspace.lock).catch(() => {});
    return outcome('blocked', { reason: 'model-credential-missing' });
  }

  const totalAttempts = 1 + config.maxFixRetries;
  let lastReason = 'retries-exhausted';

  try {
    // --- 5. implementation / fix loop ---------------------------------------
    while (state.attempt < totalAttempts) {
      const attempt = state.attempt;
      const prompt = renderImplementPrompt({
        attempt: String(attempt),
        totalAttempts: String(totalAttempts),
        issueNumber: String(spec.issueNumber),
        title: spec.title,
        repository: spec.repository,
        branch,
        baseRef: spec.baseRef,
        baseSha: spec.baseSha,
        specDigest: digest,
        workspace: repoDir,
        sessionId: state.sessionId ?? '（新会话）',
        allowedPaths: spec.allowedPaths.map((entry) => `- ${entry}`).join('\n'),
        acceptance: spec.acceptance.map((entry, i) => `${i + 1}. ${entry}`).join('\n'),
        verificationCommands: spec.verificationCommands.map((entry) => `- ${entry.command} ${entry.args.join(' ')}`).join('\n'),
        fixSection: renderFixSection(state.feedback, attempt, totalAttempts),
      });
      await log({ type: 'prompt', attempt, prompt });
      state = { ...state, phase: 'implement', feedback: state.feedback ?? null };
      await commitState(state.status === 'claimed' ? 'implementing' : state.status, { attempt });

      const driveResult = await dsh.drive({
        prompt,
        cwd: repoDir,
        attempt,
        sessionId: state.sessionId ?? null,
        env: dsh.buildEnv ? dsh.buildEnv({ modelKeyValue: modelKey }) : buildChildEnv({ role: 'dsh', baseEnv: env, modelKeyEnvName: config.dsh.modelKeyEnvName, modelKey }),
        modelKey,
      });
      await log({
        type: 'dsh-result',
        attempt,
        exitCode: driveResult.exitCode,
        finalStatus: driveResult.finalStatus,
        sessionId: driveResult.sessionId ?? null,
        stdinDelivered: driveResult.stdinDelivered ?? null,
        stderr: driveResult.stderr ?? '',
        jsonl: driveResult.jsonl ?? [],
      });
      state = { ...state, sessionId: driveResult.sessionId ?? state.sessionId };

      if (driveResult.timedOut || driveResult.finalStatus === 'timeout') {
        lastReason = 'dsh-timeout';
        await commitState('blocked', { reason: lastReason, attempt });
        return outcome('blocked', { reason: lastReason });
      }
      if (driveResult.exitCode !== 0) {
        lastReason = 'dsh-exit';
        state = { ...state, feedback: { attempt, lines: [`[exit ${driveResult.exitCode}] DSH 未正常结束`, driveResult.stderr ?? ''] } };
        await commitState('blocked', { reason: lastReason, attempt });
        return outcome('blocked', { reason: lastReason });
      }
      if (driveResult.finalStatus !== 'completed') {
        lastReason = 'dsh-incomplete';
        await commitState('blocked', { reason: lastReason, attempt });
        return outcome('blocked', { reason: lastReason });
      }

      // Ground the attempt: verify the workspace is on the approved base.
      const inspect = await workspaces.inspect({ repoDir, branch });
      if (inspect.branch !== branch && inspect.branch !== `refs/heads/${branch}`) {
        lastReason = 'branch-drift';
        await commitState('blocked', { reason: lastReason });
        return outcome('blocked', { reason: lastReason });
      }
      const baseStillAncestor = typeof workspaces.isAncestor === 'function'
        ? await workspaces.isAncestor({ repoDir, ancestor: spec.baseSha, descendant: inspect.headSha })
        : true;
      if (!baseStillAncestor) {
        lastReason = 'history-rewritten';
        await commitState('blocked', { reason: lastReason });
        return outcome('blocked', { reason: lastReason });
      }

      const commit = await workspaces.commitAll({ repoDir, message: `feat(issue-${spec.issueNumber}): DSH attempt ${attempt}` });
      const headSha = commit.sha;
      const files = typeof workspaces.changedFiles === 'function'
        ? await workspaces.changedFiles({ repoDir, baseSha: spec.baseSha, headSha })
        : (inspect.filesChanged ?? null);
      const scope = files
        ? assertChangesAllowed({ files, allowedPaths: spec.allowedPaths, baseSha: spec.baseSha, headSha })
        : { ok: true, outside: [] };
      if (!scope.ok) {
        lastReason = scope.reason;
        await commitState('blocked', { reason: lastReason, headSha, attempt });
        return outcome('blocked', { reason: lastReason, outside: scope.outside });
      }

      state = { ...state, attempt, headSha, phase: 'selftest' };
      await commitState('implementing', { attempt, headSha, phase: 'selftest' });

      const selfTest = await runSelfTests({
        config,
        tests,
        env,
        issueNumber: spec.issueNumber,
        commands: spec.verificationCommands,
        repoDir,
        headSha,
        specDigest: digest,
        reasonOnFail: 'selftest-failed',
      });
      await log({ type: 'selftest', attempt, headSha, passed: selfTest.passed, results: selfTest.result.results });
      if (!selfTest.passed) {
        const nextAttempt = attempt + 1;
        if (nextAttempt < totalAttempts) {
          lastReason = 'selftest-failed';
          state = { ...state, attempt: nextAttempt, fixRetries: nextAttempt, feedback: feedbackFromTests({ result: selfTest.result, attempt, maxFixRetries: config.maxFixRetries }), phase: 'implement' };
          await commitState('fixing', { attempt: nextAttempt, fixRetries: nextAttempt, headSha, phase: 'implement' });
          continue;
        }
        // The fix budget is exhausted: report the budget, with the concrete
        // failed self test preserved in the detail.
        lastReason = 'retries-exhausted';
        state = { ...state, attempt: nextAttempt, fixRetries: config.maxFixRetries };
        await commitState('blocked', { reason: lastReason, attempt: nextAttempt, fixRetries: config.maxFixRetries, headSha, detail: 'selftest-failed' });
        return outcome('blocked', { reason: lastReason, detail: 'selftest-failed' });
      }

      if (!review || typeof review.review !== 'function') {
        lastReason = 'review-adapter-missing';
        await commitState('blocked', { reason: lastReason, headSha, phase: 'review' });
        return outcome('blocked', { reason: lastReason });
      }

      // --- 6. publish the exact verified head as one draft PR, before review --
      // The approved workflow opens (or reuses) the single draft PR right after
      // the self test and the scope check, so the independent reviewer works
      // against a real published head. Re-read the frozen contract and the
      // current HEAD immediately before that publication: an edited manifest or
      // a moved HEAD must stop this delivery.
      const liveIssue = await github.getIssue(issueNumber);
      const liveManifest = extractManifest(liveIssue.body ?? '', { expectedRepository: null });
      const liveDigest = liveManifest.ok ? schemaDigest(liveManifest.spec) : null;
      if (!liveManifest.ok || liveDigest !== digest) {
        lastReason = 'spec-changed';
        await commitState('blocked', { reason: lastReason, attempt, headSha, detail: 'task contract changed before publication' });
        return outcome('blocked', { reason: lastReason });
      }
      const liveInspect = await workspaces.inspect({ repoDir, branch });
      if (liveInspect.headSha !== headSha) {
        lastReason = 'head-changed';
        await commitState('blocked', { reason: lastReason, attempt, headSha, detail: `workspace head is now ${liveInspect.headSha}` });
        return outcome('blocked', { reason: lastReason });
      }

      state = { ...state, phase: 'publish' };
      await commitState('publishing', { attempt, headSha, phase: 'publish' });
      let pull;
      try {
        const pushResult = await publish.pushBranch({
          repoDir,
          branch,
          expectedBranch: branch,
          baseRef: spec.baseRef,
          headSha,
        });
        await log({ type: 'publish-push', branch, headSha, remote: pushResult?.remote ?? null });
        const logsRef = typeof publish.pushLogs === 'function' ? config.github.logRef : null;
        // ensurePullRequest is idempotent per (head, base): the fix rounds
        // re-push the same task branch and reuse this exact draft PR, and an
        // ambiguous create timeout is resolved by querying, never by creating a
        // duplicate or force-pushing.
        pull = await publish.ensurePullRequest({
          branch,
          headSha,
          baseRef: spec.baseRef,
          title: `[agent] #${spec.issueNumber} ${spec.title}`,
          body: buildPullRequestBody({
            spec: { ...spec, specDigest: digest },
            review: null,
            headSha,
            runId,
            workerId: config.workerId,
            logsRef,
          }),
          draft: true,
        });
        await log({ type: 'publish-pr', number: pull?.number ?? null, created: pull?.created ?? null, draft: true });
      } catch (err) {
        lastReason = 'publish-failed';
        await commitState('blocked', { reason: lastReason, headSha, detail: redactText(String(err.message ?? err), { machineRoots: [config.workspaceRoot] }) });
        return outcome('blocked', { reason: lastReason, detail: err.message });
      }

      // --- 7. independent review, bound to the published head -----------------
      const pullRef = { number: pull?.number ?? null };
      state = { ...state, phase: 'review' };
      await commitState('reviewing', { attempt, headSha, phase: 'review', pull: pullRef });

      // The reviewer never shares the writer's working tree: acquire a distinct
      // read-only clone detached at the exact reviewed head.
      let reviewWorkspace = null;
      try {
        if (deps.reviewWorkspaces && typeof deps.reviewWorkspaces.acquire === 'function') {
          reviewWorkspace = await deps.reviewWorkspaces.acquire({
            task: spec,
            headSha,
            baseSha: spec.baseSha,
            sourceDir: repoDir,
            runId: `${runId}-review-${attempt}`,
          });
        }
      } catch (err) {
        lastReason = 'review-workspace-failed';
        await commitState('blocked', { reason: lastReason, attempt, headSha, pull: pullRef, detail: redactText(String(err.message ?? err), { machineRoots: [config.workspaceRoot] }) });
        return outcome('blocked', { reason: lastReason, detail: err.message, pull: pullRef });
      }

      let reviewResult;
      try {
        reviewResult = await review.review({
          issueNumber: spec.issueNumber,
          title: spec.title,
          branch,
          baseRef: spec.baseRef,
          baseSha: spec.baseSha,
          headSha,
          specDigest: digest,
          acceptance: spec.acceptance,
          allowedPaths: spec.allowedPaths,
          workspace: reviewWorkspace,
          sourceDir: repoDir,
          readOnly: true,
          mustInvoke: ['requesting-code-review', 'verification-before-completion'],
          commands: config.review.commands,
          env: buildChildEnv({ role: 'review', baseEnv: env }),
        });
      } finally {
        if (reviewWorkspace && deps.reviewWorkspaces && typeof deps.reviewWorkspaces.release === 'function') {
          await deps.reviewWorkspaces.release(reviewWorkspace.lock).catch(() => {});
        }
      }
      const report = reviewResult?.report && typeof reviewResult.report === 'object' ? reviewResult.report : reviewResult;
      // Controller-run evidence always wins over anything the model returned.
      if (Array.isArray(reviewResult?.evidence) && reviewResult.evidence.length > 0) {
        report.testEvidence = reviewResult.evidence.map((item) => ({
          command: item.command,
          exitCode: item.exitCode,
          headSha: item.headSha,
          specDigest: item.specDigest ?? digest,
          output: item.output,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
        }));
      }
      await log({ type: 'review', attempt, headSha, report, transcript: reviewResult?.transcript ?? null });
      await commitState(state.status, { attempt, headSha, phase: 'review', review: { verdict: report?.verdict ?? null, headSha: report?.headSha ?? null } });

      // A report bound to another revision is stale no matter what it says.
      const bindingErrors = [];
      if (report?.headSha !== headSha) {
        bindingErrors.push({
          severity: 'critical',
          message: `stale review: report is bound to ${report?.headSha ?? 'nothing'} but the verified head is ${headSha}`,
        });
      }
      const schemaCheck = validateReviewReport(report);
      const schemaProblems = schemaCheck.ok ? [] : schemaCheck.errors.map((entry) => entry.message);
      const policy = evaluateReviewPolicy(report, { acceptance: spec.acceptance, headSha, specDigest: digest });
      const problems = [...schemaProblems, ...policy.problems];

      // A failed review keeps the draft PR open and persists concrete feedback
      // for the next fix round and the operator; the run is still blocked.
      if (bindingErrors.length > 0) {
        lastReason = 'stale-review';
        const feedback = feedbackFromReview({ report: { findings: bindingErrors }, attempt });
        await commitState('blocked', { reason: lastReason, attempt, headSha, pull: pullRef, feedback, detail: bindingErrors[0].message });
        return outcome('blocked', { reason: lastReason, detail: bindingErrors[0].message, pull: pullRef });
      }
      if (!schemaCheck.ok) {
        lastReason = 'invalid-review';
        const feedback = feedbackFromReview({ report, attempt });
        await commitState('blocked', { reason: lastReason, attempt, headSha, pull: pullRef, feedback, detail: problems });
        return outcome('blocked', { reason: lastReason, problems, pull: pullRef });
      }
      // The controller's independent rerun results are authoritative: a failed
      // command or an uncovered acceptance item can never be hidden behind a
      // model "pass" verdict, and a model report cannot drop evidence.
      if (!policy.ok) {
        lastReason = report?.verdict === 'blocked' ? 'review-blocked' : 'invalid-review';
        const nextAttempt = attempt + 1;
        if (report?.verdict === 'needs-fix' && nextAttempt < totalAttempts) {
          state = { ...state, attempt: nextAttempt, fixRetries: nextAttempt, feedback: feedbackFromReview({ report, attempt }), phase: 'implement' };
          await commitState('fixing', { attempt: nextAttempt, fixRetries: nextAttempt, headSha, pull: pullRef, phase: 'implement' });
          continue;
        }
        const feedback = feedbackFromReview({ report, attempt });
        await commitState('blocked', { reason: lastReason, attempt, headSha, pull: pullRef, feedback, detail: policy.problems });
        return outcome('blocked', { reason: lastReason, problems: policy.problems, pull: pullRef });
      }
      try {
        assertReviewBinding({ report, headSha, specDigest: report?.specDigest ?? digest, expectedDigest: digest });
      } catch (err) {
        lastReason = 'stale-review';
        await commitState('blocked', { reason: lastReason, attempt, headSha, pull: pullRef, detail: err.message });
        return outcome('blocked', { reason: lastReason, detail: err.message, pull: pullRef });
      }

      // The draft PR is already open at this exact head; a passing review keeps
      // it open (no merge, no close) and records the verdict in the local state
      // and the sanitized log export.
      if (typeof publish.pushLogs === 'function') {
        try {
          const exportPath = await logStore.exportIssue(issueNumber, logStore.exportDirFor(issueNumber));
          await publish.pushLogs({ ref: config.github.logRef, exportPath, issueNumber });
          await log({ type: 'logs-published', ref: config.github.logRef });
        } catch (err) {
          await log({ type: 'logs-publish-failed', message: err.message });
        }
      }

      state = { ...state, phase: 'awaiting-merge', fixRetries: attempt, headSha };
      await commitState('awaiting-merge', { attempt, fixRetries: attempt, headSha, phase: 'awaiting-merge', pull: pullRef });
      return outcome('awaiting-merge', { pull, review: { verdict: report.verdict, headSha } });
    }

    await commitState('blocked', { reason: 'retries-exhausted' });
    return outcome('blocked', { reason: 'retries-exhausted', lastReason });
  } catch (err) {
    if (process.env.DSH_PIPELINE_DEBUG === '1') console.error('[debug] runTask failed:', err?.stack ?? err);
    const name = err?.name ?? 'Error';
    const reason = err?.code === 'REMOTE_PERSISTENCE'
      ? 'remote-persistence-failed'
      : (name === 'WorkspaceError' ? 'workspace-failed' : 'pipeline-error');
    try {
      await commitState('blocked', { reason, detail: redactText(String(err.message ?? err), { machineRoots: [config.workspaceRoot] }) });
    } catch {
      /* the state save already failed; the blocked outcome below is still returned */
    }
    return outcome('blocked', { reason, detail: err.message });
  } finally {
    if (typeof workspaces.release === 'function') await workspaces.release(workspace?.lock).catch(() => {});
    if (state.status !== 'awaiting-merge' && typeof dsh.dispose === 'function') {
      try {
        await dsh.dispose();
      } catch {
        /* best effort */
      }
    }
  }
}

export { READY_LABEL, STATE_VERSION, isInsideAllowed, DEFAULT_VERIFICATION_COMMANDS };
