// Independent review adapter. The review runs in its own read-only directory,
// re-runs the fixed verification commands at the exact head sha, and produces a
// strict verdict. exit 0 is never treated as a pass on its own.
//
// The reviewer is the installed native Codex executable:
//   codex exec --profile <p> --json --cd <repo> --sandbox read-only
//              -c approval_policy="never" --output-schema <s> -o <msg> -
// It uses the existing local ChatGPT auth; the pipeline never fetches or
// injects a GitHub or model API key for the review, and the review child env
// carries neither.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './runcmd.mjs';
import { buildChildEnv } from './dsh.mjs';
import { redactText } from './redact.mjs';
import { validateReviewReport } from './schemas.mjs';
import { renderTemplate } from './prompts.mjs';

const BLOCKING_SEVERITIES = new Set(['critical', 'important']);
const FORBIDDEN_REVIEW_ARG = /dangerously-bypass|bypass-approvals|--full-auto|--ask-for-approval|danger-full-access|workspace-write/;

/** The two Superpowers skills the review session is required to invoke. */
export const REQUIRED_REVIEW_SKILLS = Object.freeze(['requesting-code-review', 'verification-before-completion']);

/** Refuse reviewer argv that would relax the read-only sandbox or approvals. */
export function assertReviewArgsSafe(args = []) {
  for (const arg of args) {
    if (typeof arg !== 'string') throw new Error('review.args entries must be strings');
    if (FORBIDDEN_REVIEW_ARG.test(arg)) {
      throw new Error(`review.args must not weaken the read-only review sandbox: ${arg}`);
    }
  }
  if (args.includes('--sandbox') || args.includes('-s')) {
    throw new Error('review.args must not override the enforced read-only sandbox');
  }
  return true;
}

/**
 * Bind a verdict to the reviewed revision. A stale verdict, a verdict that
 * carried over from an earlier head, or evidence collected at another sha is
 * refused even when the verdict says "pass".
 */
export function assertReviewBinding({ report, headSha, specDigest, expectedDigest }) {
  if (!report || typeof report !== 'object') throw new Error('review report is missing');
  if (report.headSha !== headSha) {
    throw new Error(`stale review: report is bound to ${report.headSha} but the verified head is ${headSha}`);
  }
  if (specDigest !== expectedDigest) {
    throw new Error(`review was produced for spec digest ${specDigest}, expected ${expectedDigest}`);
  }
  for (const evidence of report.testEvidence ?? []) {
    if (evidence.headSha !== headSha) {
      throw new Error(`stale testEvidence: ${evidence.command} was run at ${evidence.headSha}, not ${headSha}`);
    }
    // "" is the explicit "not bound" sentinel; a *mismatching* digest is stale.
    if (evidence.specDigest !== undefined && evidence.specDigest !== '' && evidence.specDigest !== expectedDigest) {
      throw new Error(`stale testEvidence: ${evidence.command} is bound to spec digest ${evidence.specDigest}`);
    }
  }
  return true;
}

/**
 * Semantic policy applied on top of the schema. Every requested acceptance item
 * must appear exactly once (no unknown substitutions), no Critical/Important
 * finding may remain, and the independent test evidence must be bound to the
 * exact head and spec digest with a zero exit.
 */
export function evaluateReviewPolicy(report, { acceptance = [], headSha = null, specDigest = null } = {}) {
  const problems = [];
  if (!report || typeof report !== 'object') return { ok: false, problems: ['review report is missing'] };
  if (report.verdict !== 'pass') problems.push(`verdict is ${report.verdict}`);
  const results = Array.isArray(report.acceptanceResults) ? report.acceptanceResults : [];
  const requested = [...acceptance];
  const counts = new Map();
  for (const entry of results) {
    const text = entry?.text;
    if (!requested.includes(text)) {
      problems.push(`unknown acceptance item: ${text ?? '<missing text>'}`);
      continue;
    }
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  for (const text of requested) {
    const count = counts.get(text) ?? 0;
    if (count === 0) problems.push(`acceptance item not evaluated: ${text}`);
    else if (count > 1) problems.push(`acceptance item evaluated ${count} times: ${text}`);
  }
  for (const entry of results) {
    if (entry.passed !== true) problems.push(`acceptance not met: ${entry.text}`);
  }
  for (const finding of report.findings ?? []) {
    if (BLOCKING_SEVERITIES.has(finding.severity)) problems.push(`${finding.severity}: ${finding.message}`);
  }
  const evidence = Array.isArray(report.testEvidence) ? report.testEvidence : [];
  if (evidence.length === 0) {
    problems.push('no independent test evidence');
  } else {
    for (const entry of evidence) {
      if (entry.exitCode !== 0) problems.push(`independent test failed (${entry.exitCode}): ${entry.command}`);
      if (headSha && entry.headSha !== headSha) {
        problems.push(`test evidence for ${entry.command} is bound to ${entry.headSha ?? 'nothing'}, not ${headSha}`);
      }
      if (specDigest && entry.specDigest !== specDigest) {
        problems.push(`test evidence for ${entry.command} is not bound to spec digest ${specDigest}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

function readOutputSchema(schemaPath) {
  try {
    return fs.readFileSync(schemaPath, 'utf8');
  } catch {
    return null;
  }
}

function parseCodexJsonl(text) {
  const messages = [];
  const rejected = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      rejected.push(line);
      continue;
    }
    const text_ = parsed?.item?.text ?? parsed?.msg?.message ?? parsed?.message ?? parsed?.text;
    if (typeof text_ === 'string' && text_.trim().length > 0) messages.push(text_);
  }
  return { messages, rejected };
}

/** Extract the single JSON verdict object from the review session output. */
export function extractVerdict(text) {
  const source = String(text ?? '');
  const fenced = [...source.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  const candidates = fenced.length > 0 ? fenced : [source];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start < 0 || end <= start) continue;
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        continue;
      }
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

export function createReviewAdapter({
  config,
  workspaceManager = null,
  run = runProcess,
  env = process.env,
  manifest = null,
} = {}) {
  if (!config?.review) throw new Error('review adapter requires config.review');
  const review = config.review;
  const timeoutMs = config.timeouts?.reviewMs ?? 20 * 60 * 1000;
  const commandTimeoutMs = config.timeouts?.commandMs ?? 5 * 60 * 1000;
  if (review.args) assertReviewArgsSafe(review.args);

  async function runCommands({ repoDir, commands, headSha, specDigest, secrets = [] }) {
    const results = [];
    for (const entry of commands) {
      const startedAt = new Date().toISOString();
      const execEnv = buildChildEnv({ role: 'test', baseEnv: env });
      const result = await run({
        command: entry.command,
        args: entry.args,
        cwd: repoDir,
        env: execEnv,
        timeoutMs: commandTimeoutMs,
      });
      const stdout = redactText(result.stdout ?? '', { secrets });
      const stderr = redactText(result.stderr ?? '', { secrets });
      results.push({
        command: `${entry.command} ${entry.args.join(' ')}`.trim(),
        exitCode: result.status,
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
    return results;
  }

  async function runReview({
    issueNumber,
    title,
    branch,
    baseRef,
    baseSha,
    headSha,
    specDigest,
    acceptance = [],
    allowedPaths = [],
    workspace = null,
    sourceDir = null,
    commands = review.commands,
    runId = 'review',
  } = {}) {
    if (!headSha) throw new Error('review requires the head sha under review');
    const report = {
      headSha,
      verdict: 'blocked',
      acceptanceResults: [],
      findings: [],
      testEvidence: [],
    };
    const transcript = { stdout: '', stderr: '', exitCode: null, sessionId: null, timedOut: false };
    let activeWorkspace = workspace;
    let acquiredHere = false;
    try {
      if (!activeWorkspace) {
        if (!workspaceManager) throw new Error('review requires a read-only review workspace or a review workspace manager');
        activeWorkspace = await workspaceManager.acquire({
          task: { repository: config.repository, issueNumber },
          headSha,
          baseSha,
          sourceDir,
          runId,
        });
        acquiredHere = true;
      }
      if (!activeWorkspace?.repoDir) throw new Error('review requires an acquired read-only workspace');
      try {
        const gitHead = typeof activeWorkspace.headSha === 'function' ? await activeWorkspace.headSha() : activeWorkspace.head;
        if (gitHead !== headSha) {
          report.findings.push({ severity: 'critical', message: `review workspace head ${gitHead} does not match ${headSha}` });
          return { report, transcript, workspace: activeWorkspace.dir, prompt: null, evidence: [], args: null };
        }
        if (typeof activeWorkspace.uniqueCommits === 'function' && (await activeWorkspace.uniqueCommits()) === 0) {
          report.findings.push({ severity: 'critical', message: 'no business changes between the base and the reviewed head' });
        }
      } catch (err) {
        report.findings.push({ severity: 'critical', message: `review workspace check failed: ${err.message}` });
        return { report, transcript, workspace: activeWorkspace.dir, prompt: null, evidence: [], args: null };
      }
      const evidence = await runCommands({ repoDir: activeWorkspace.repoDir, commands, headSha, specDigest });
      report.testEvidence = evidence.map((item) => ({
        command: item.command,
        exitCode: item.exitCode,
        headSha: item.headSha,
        specDigest: item.specDigest,
        output: item.output,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
      }));

      const prompt = renderTemplate('review', {
        issueNumber,
        title,
        repository: config.repository,
        branch,
        baseRef,
        baseSha,
        headSha,
        specDigest,
        acceptance: acceptance.map((text) => `- ${text}`).join('\n'),
        allowedPaths: allowedPaths.join('\n'),
        workspaceRoot: activeWorkspace.repoDir,
        reviewRoot: activeWorkspace.dir,
        commands: commands.map((entry) => `${entry.command} ${entry.args.join(' ')}`).join('\n'),
        requiredSkills: REQUIRED_REVIEW_SKILLS.join('\n'),
        localTestEvidence: evidence.map((item) => `[${item.exitCode}] ${item.command}`).join('\n'),
      });
      await fsp.writeFile(path.join(activeWorkspace.dir, 'review-prompt.md'), prompt, 'utf8');

      // The review child gets sanitized env only: no GitHub token, no model key.
      const childEnv = buildChildEnv({ role: 'review', baseEnv: env });
      const outputSchemaPath = path.join(activeWorkspace.dir, 'review-output.schema.json');
      const schemaText = readOutputSchema(review.outputSchemaPath);
      if (schemaText) await fsp.writeFile(outputSchemaPath, schemaText, 'utf8');
      const lastMessagePath = path.join(activeWorkspace.dir, 'review-last-message.txt');
      const args = [
        ...(review.cliEntry ? [review.cliEntry] : []),
        'exec',
        '--profile', review.profile,
        '--json',
        '--cd', activeWorkspace.repoDir,
        '--sandbox', 'read-only',
        '-c', 'approval_policy="never"',
        ...(schemaText ? ['--output-schema', outputSchemaPath] : []),
        '--output-last-message', lastMessagePath,
        '-',
        ...(review.args ?? []),
      ];
      const result = await run({
        command: review.executable,
        args,
        cwd: activeWorkspace.dir,
        env: childEnv,
        timeoutMs,
        stdin: prompt,
      });
      transcript.exitCode = result.status;
      transcript.stdout = redactText(result.stdout ?? '', {});
      transcript.stderr = redactText(result.stderr ?? '', {});
      transcript.timedOut = Boolean(result.timedOut);

      let lastMessage = '';
      try {
        lastMessage = await fsp.readFile(lastMessagePath, 'utf8');
      } catch {
        lastMessage = '';
      }
      const parsed = parseCodexJsonl(result.stdout);
      const extracted = extractVerdict(lastMessage) ?? extractVerdict(parsed.messages.join('\n'));
      if (result.timedOut) {
        report.findings.push({ severity: 'critical', message: 'review session timed out' });
      } else if (result.status !== 0 || !extracted) {
        report.findings.push({ severity: 'critical', message: `review session did not produce a valid verdict (exit ${result.status})` });
      } else {
        const validation = validateReviewReport(extracted);
        if (!validation.ok) {
          report.findings.push({
            severity: 'critical',
            message: `review verdict violates the review schema: ${validation.errors.map((e) => e.message).join('; ')}`,
          });
        } else {
          Object.assign(report, validation.report);
          // Controller-run evidence is authoritative: the model report can never
          // replace or hide the independent rerun results.
          report.testEvidence = evidence.map((item) => ({
            command: item.command,
            exitCode: item.exitCode,
            headSha: item.headSha,
            specDigest: item.specDigest,
            output: item.output,
            startedAt: item.startedAt,
            endedAt: item.endedAt,
          }));
        }
      }
      return { report, transcript, workspace: activeWorkspace.dir, prompt, evidence, outputSchemaPath, lastMessagePath, args };
    } catch (err) {
      report.findings.push({ severity: 'critical', message: `review infrastructure failure: ${err.message}` });
      return { report, transcript, workspace: activeWorkspace?.dir ?? null, prompt: null, evidence: [] };
    } finally {
      if (acquiredHere && workspaceManager?.release) {
        await workspaceManager.release(activeWorkspace?.lock).catch(() => {});
      }
    }
  }

  return {
    config,
    review: runReview,
    runCommands,
    async dispose(workspace) {
      if (workspace?.lock?.release) await workspace.lock.release();
    },
  };
}

export { BLOCKING_SEVERITIES, parseCodexJsonl };
