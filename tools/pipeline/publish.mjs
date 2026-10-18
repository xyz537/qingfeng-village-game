// Publication adapter. All GitHub writes go through the external publisher;
// this module only builds and validates the exact argv it may execute.
// It has no merge API, no auto-merge and no issue-close path by construction.
import { ensurePullRequest, assertArgvAllowed } from './github.mjs';
import { git } from './git.mjs';

const RESERVED = new Set(['main', 'master', 'trunk', 'head']);

/** Publication is limited to the task's own branch and the automation refs. */
export function assertPushable({ branch, expectedBranch, baseRef }) {
  if (branch !== expectedBranch) {
    throw new Error(`refused: publication branch ${branch} is not the task branch ${expectedBranch}`);
  }
  const normalized = String(branch).replace(/^refs\/heads\//, '');
  if (RESERVED.has(normalized.toLowerCase())) throw new Error(`refused: ${branch} is a shared branch`);
  if (!normalized.startsWith('agent/issue-')) throw new Error(`refused: ${branch} is not an agent task branch`);
  const base = String(baseRef ?? '').replace(/^refs\/heads\//, '').toLowerCase();
  if (RESERVED.has(base)) throw new Error(`refused: base ${baseRef} is a shared branch`);
  return true;
}

/** Allowed automation refs for logs/status publication. */
export function assertAutomationRef(ref) {
  if (typeof ref !== 'string' || !/^refs\/heads\/automation\/[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`refused: ${ref} is not an automation ref`);
  }
  if (ref.includes('*') || ref.includes('..')) throw new Error('refused: wildcard or parent refs are not allowed');
  return true;
}

/**
 * Adapter that publishes the verified task branch and an idempotent draft PR.
 * `push`/`run` are injected so tests can verify the exact argv without touching
 * the network.
 */
export function createPublishAdapter({ config, github, run = null, push = undefined, env = process.env } = {}) {
  if (!config?.baseRef) throw new Error('publish adapter requires a configured base ref');
  if (!github) throw new Error('publish adapter requires a github adapter');
  const remote = github.remote ?? 'origin';

  return {
    remote,
    /** Validate + push exactly one branch. Never force, never delete, never wildcard. */
    async pushBranch({ repoDir, branch, expectedBranch, baseRef, headSha }) {
      assertPushable({ branch, expectedBranch, baseRef: baseRef ?? config.baseRef });
      const argv = ['push', remote, `HEAD:refs/heads/${branch}`];
      assertArgvAllowed(argv, { allowedBranch: branch });
      if (typeof push === 'function') {
        const result = await push({ argv, repoDir, branch, headSha });
        return { branch, sha: headSha, created: result?.created ?? true, argv };
      }
      if (typeof run === 'function') {
        const result = await run({ command: 'git', args: argv, cwd: repoDir, env, timeoutMs: config.timeouts?.gitMs ?? 120000 });
        if (result.status !== 0) {
          const err = new Error(`push failed with exit ${result.status}: ${String(result.stderr ?? '').trim()}`);
          err.code = 'PUSH_FAILED';
          throw err;
        }
        return { branch, sha: headSha, created: true, argv };
      }
      const result = await git(argv, { cwd: repoDir, timeoutMs: config.timeouts?.gitMs ?? 120000 });
      return { branch, sha: headSha, created: true, argv, stdout: result.stdout };
    },
    /** Idempotent draft PR creation against the configured base ref. */
    async ensurePullRequest({ branch, headSha, title, body, baseRef }) {
      assertPushable({ branch, expectedBranch: branch, baseRef: baseRef ?? config.baseRef });
      return ensurePullRequest({
        adapter: github,
        head: branch,
        base: (baseRef ?? config.baseRef).replace(/^refs\/heads\//, ''),
        title,
        body,
        draft: true,
      });
    },
    /** Publish the sanitized log export into the automation logs ref. */
    async pushLogs({ ref = config.github.logRef, exportPath, issueNumber }) {
      assertAutomationRef(ref);
      const argv = ['push', remote, `HEAD:${ref}`];
      assertArgvAllowed(argv, { allowedRefs: [ref] });
      if (typeof push === 'function') {
        await push({ argv, ref, issueNumber, exportPath });
        return { ref, updated: true, argv };
      }
      return { ref, updated: false, argv, planned: true };
    },
    /** Never available: the pipeline has no merge capability. */
    async merge() {
      throw new Error('refused: the pipeline never merges');
    },
    /** Never available: the pipeline never closes a task issue. */
    async closeIssue() {
      throw new Error('refused: the pipeline never closes a task issue');
    },
  };
}

/** Build a human-readable PR body. Contains no credentials and no machine paths. */
export function buildPullRequestBody({ spec, review = null, headSha = null, runId, workerId, logsRef = null }) {
  // The approved workflow opens the draft PR right after the self test, before
  // the independent review runs, so the body is written for two states: the
  // pre-review draft (review=null) and a report-bearing re-render.
  const delivery = headSha ?? review?.headSha ?? '';
  const verdictLines = review
    ? [
      `- verdict：\`${review.verdict ?? 'unknown'}\``,
      ...(review.acceptanceResults ?? []).map((entry) => `- [${entry.passed ? 'x' : ' '}] ${entry.text}${entry.evidence ? ` — ${entry.evidence}` : ''}`),
    ]
    : [
      '- verdict：独立验收在本 Draft PR 创建后于只读工作区进行，结论写入控制器本地状态与去敏日志，并以本 PR 的精确 head 绑定。',
      '- 验收未通过时保持 Draft 打开并附带具体反馈；通过时保持打开，不自动合并。',
    ];
  const lines = [
    `自动化交付：Issue #${spec.issueNumber} ${spec.title}`,
    '',
    `- 清单摘要 sha256：\`${spec.specDigest ?? 'unknown'}\``,
    `- 基础分支：\`${spec.baseRef}\``,
    `- 基础提交：\`${spec.baseSha}\``,
    `- 业务分支：\`${spec.branch}\``,
    `- 交付提交：\`${delivery}\``,
    `- runId：\`${runId ?? 'unknown'}\``,
    `- workerId：\`${workerId ?? 'unknown'}\``,
    '',
    '## 验收条件',
    ...spec.acceptance.map((text, i) => `${i + 1}. ${text}`),
    '',
    '## 独立验收结论',
    ...verdictLines,
    '',
    '## 去敏日志',
    logsRef ? `- 摘要与去敏记录：\`${logsRef}\`` : '- 尚未发布（导出仅保留在本机）',
    '',
    '统计与限制：本 PR 由单次流水线创建，保持 Draft 且不自动合并；Issue 保持打开，等待用户决定合并。',
    '原始 JSONL 与完整日志保存在控制器本机，未上传任何凭据或本机绝对路径。',
  ];
  return lines.join('\n');
}
