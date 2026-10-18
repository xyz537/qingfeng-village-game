// GitHub access through a trusted external credential proxy.
// The pipeline never holds a GitHub token itself: the configured
// credentialCommand prints one on stdout and it is passed to `gh` through the
// environment only. It is never logged, never persisted and never forwarded to
// a model or test child process.
import { runProcess } from './runcmd.mjs';
import { redactText } from './redact.mjs';

const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const RESERVED_BRANCHES = new Set(['main', 'master', 'trunk', 'head', 'develop', 'release']);

class GhError extends Error {
  constructor(message, { argv = [], status = 1, stderr = '', code } = {}) {
    super(message);
    this.name = 'GhError';
    this.argv = argv;
    this.status = status;
    this.stderr = stderr;
    this.code = code;
  }
}

class RefExistsError extends GhError {
  constructor(message, options) {
    super(message, { ...options, code: 'CONFLICT' });
    this.name = 'RefExistsError';
  }
}

class NotFoundError extends GhError {
  constructor(message, options) {
    super(message, { ...options, code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

function shortBranch(value) {
  return String(value ?? '').replace(/^refs\/heads\//, '');
}

function assertSafeAllowedBranch(branch, argv) {
  const normalized = shortBranch(branch).toLowerCase();
  if (RESERVED_BRANCHES.has(normalized)) {
    throw new GhError(`refused: ${branch} is a shared/reserved branch and can never be an allowed target`, { argv });
  }
  if (String(branch).includes('*') || String(branch).includes('..')) {
    throw new GhError(`refused: ${branch} is not an exact branch`, { argv });
  }
}

/**
 * Refuse any gh invocation that could publish outside the task branch, force a
 * push, delete a ref, or merge. This is the single choke point for publication.
 *
 * `body` is the parsed JSON payload sent on stdin (`gh api --input -`); guards
 * inspect it as well as the `-f`/`-F` fields so a payload cannot smuggle a
 * `main` branch past the checks.
 */
export function assertArgvAllowed(argv, { allowedBranch = null, allowedRefs = [], allowReadOnly = false, body = null } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new GhError('gh argv must be a non-empty array');
  if (allowedBranch) assertSafeAllowedBranch(allowedBranch, argv);
  for (const ref of allowedRefs) {
    if (typeof ref !== 'string' || !BRANCH_REF.test(ref)) {
      throw new GhError(`refused: allowed ref ${ref} is not an explicit refs/heads/... name`, { argv });
    }
  }
  const [op, ...rest] = argv;
  const allowed = new Set([allowedBranch ? `refs/heads/${allowedBranch}` : null, ...allowedRefs].filter(Boolean));
  const bodyBranch = body && typeof body === 'object' ? body.branch ?? null : null;
  const bodyHead = body && typeof body === 'object' ? body.head ?? null : null;
  const bodyBase = body && typeof body === 'object' ? body.base ?? null : null;
  const bodyRef = body && typeof body === 'object' ? body.ref ?? null : null;

  if (op === 'push') {
    const positional = rest.filter((entry) => !entry.startsWith('-'));
    const flags = rest.filter((entry) => entry.startsWith('-'));
    for (const flag of flags) {
      const bare = flag.split('=')[0];
      if (/^--force(-with-lease|-if-includes)?$/.test(bare) || bare === '-f') {
        throw new GhError(`refused: force push ("${flag}") is never allowed`, { argv });
      }
      if (bare === '--delete' || bare === '-d' || bare === '--mirror' || bare === '--all' || bare === '--tags') {
        throw new GhError(`refused: destructive push ("${flag}") is never allowed`, { argv });
      }
      if (bare === '--prune' && (positional.length > 0 || /^--prune=/.test(flag))) {
        throw new GhError(`refused: pruning refs ("${flag}") is never allowed`, { argv });
      }
    }
    if (positional.length !== 2) {
      throw new GhError('refused: only a single explicit <remote> <src>:<dst> push is allowed', { argv });
    }
    const [, refspec] = positional;
    if (refspec.startsWith('+')) {
      throw new GhError('refused: a forced (+) refspec is never allowed', { argv });
    }
    if (!refspec.includes(':')) {
      throw new GhError('refused: a push must name an explicit <src>:<dst> refspec', { argv });
    }
    const [source, target] = refspec.split(':');
    if (source.includes('*') || target.includes('*')) {
      throw new GhError('refused: wildcard refspecs are not allowed', { argv });
    }
    const targetRef = target.startsWith('refs/') ? target : `refs/heads/${target}`;
    if (RESERVED_BRANCHES.has(shortBranch(targetRef).toLowerCase())) {
      throw new GhError(`refused: target ${targetRef} is a shared branch`, { argv });
    }
    if (!allowed.has(targetRef)) {
      throw new GhError(`refused: target ${targetRef} is not an allowed ref for this task`, { argv });
    }
    return true;
  }

  if (op === 'api') {
    let method = 'GET';
    let endpoint = null;
    const fields = [];
    const rawFields = [];
    for (let i = 0; i < rest.length; i += 1) {
      const entry = rest[i];
      if (entry === '--method' || entry === '-X') {
        method = String(rest[i + 1] ?? '').toUpperCase();
        i += 1;
        continue;
      }
      if (entry.startsWith('--method=')) {
        method = entry.slice('--method='.length).toUpperCase();
        continue;
      }
      if (entry === '-f' || entry === '--field' || entry === '-F' || entry === '--raw-field') {
        const pair = rest[i + 1];
        if (typeof pair === 'string') {
          rawFields.push(pair);
          const eq = pair.indexOf('=');
          if (eq > 0) fields.push([pair.slice(0, eq), pair.slice(eq + 1)]);
        }
        i += 1;
        continue;
      }
      if (entry.startsWith('-')) continue;
      if (endpoint === null) endpoint = entry;
    }
    if (!endpoint) throw new GhError('refused: gh api without an endpoint', { argv });
    if (endpoint.includes('..') || endpoint.startsWith('http:') || endpoint.startsWith('https:')) {
      throw new GhError('refused: gh api endpoint must be a repository-relative API path', { argv });
    }
    if (/\/(merge|merges)\b/.test(endpoint)) {
      throw new GhError('refused: the pipeline has no merge API', { argv });
    }
    if (method === 'DELETE') {
      throw new GhError('refused: DELETE is never part of the pipeline', { argv });
    }
    const isRead = method === 'GET' || method === 'HEAD';
    if (isRead) {
      if (!allowReadOnly) throw new GhError('refused: interactive gh calls are not part of a run', { argv });
      return true;
    }
    const field = (name) => {
      const hit = fields.find(([key]) => key === name);
      return hit ? hit[1] : undefined;
    };

    // Git objects are dangling until a guarded ref points at them; creating the
    // objects themselves is safe and is the only way to build the claim commit.
    if (/\/(git\/blobs|git\/trees|git\/commits)$/.test(endpoint) && method === 'POST') {
      return true;
    }

    // Writing repository files is limited to an exact automation status/log
    // branch. A missing branch is refused outright instead of silently
    // defaulting to the repository default branch (main).
    if (/\/contents\//.test(endpoint)) {
      if (method !== 'PUT') throw new GhError(`refused: ${method} on contents is not allowed`, { argv });
      const branch = bodyBranch ?? field('branch');
      if (typeof branch !== 'string' || branch.length === 0) {
        throw new GhError('refused: a contents write must name an exact branch (no default-branch fallback)', { argv });
      }
      const fullRef = `refs/heads/${shortBranch(branch)}`;
      if (RESERVED_BRANCHES.has(shortBranch(branch).toLowerCase())) {
        throw new GhError(`refused: contents write to shared branch ${branch}`, { argv });
      }
      if (!allowed.has(fullRef)) {
        throw new GhError(`refused: contents write to ${fullRef} is not an allowed automation branch`, { argv });
      }
      return true;
    }

    // Ref creation only. Existing refs are never updated or deleted.
    if (/\/git\/refs$/.test(endpoint)) {
      if (method !== 'POST') throw new GhError(`refused: ${method} on refs is never allowed`, { argv });
      if (body?.force === true || field('force') === 'true' || rawFields.includes('force=true')) {
        throw new GhError('refused: forcing a ref update is never allowed', { argv });
      }
      const ref = bodyRef ?? field('ref');
      if (typeof ref !== 'string' || !BRANCH_REF.test(ref)) {
        throw new GhError('refused: ref must be an explicit refs/heads/... name', { argv });
      }
      if (RESERVED_BRANCHES.has(shortBranch(ref).toLowerCase())) {
        throw new GhError(`refused: ref ${ref} is a shared branch`, { argv });
      }
      if (!allowed.has(ref)) {
        throw new GhError(`refused: ref ${ref} is not allowed for this task`, { argv });
      }
      return true;
    }
    if (/\/git\/refs\/heads\//.test(endpoint)) {
      throw new GhError('refused: existing refs are never updated or deleted by the pipeline', { argv });
    }

    if (/\/pulls$/.test(endpoint) && method === 'POST') {
      const head = bodyHead ?? field('head');
      const base = bodyBase ?? field('base');
      if (typeof head !== 'string' || head.length === 0) {
        throw new GhError('refused: pull request creation must name the task branch as head', { argv });
      }
      if (typeof base !== 'string' || base.length === 0) {
        throw new GhError('refused: pull request creation must name a base branch', { argv });
      }
      if (RESERVED_BRANCHES.has(shortBranch(base).toLowerCase())) {
        throw new GhError(`refused: pull request base ${base} is a shared branch`, { argv });
      }
      if (!allowed.has(`refs/heads/${shortBranch(head)}`)) {
        throw new GhError(`refused: pull request head ${head} is not the task branch`, { argv });
      }
      return true;
    }

    if (/\/issues\/[0-9]+\/comments$/.test(endpoint) && method === 'POST') {
      return true;
    }

    throw new GhError(`refused: ${method} ${endpoint} is not an allowed write for the pipeline`, { argv });
  }

  if (op === 'pr') {
    const sub = rest[0];
    if (sub === 'merge' || sub === 'close' || sub === 'reopen') {
      throw new GhError(`refused: gh pr ${sub} is never part of the pipeline`, { argv });
    }
    if (sub === 'create') {
      const headIndex = rest.findIndex((entry) => entry === '--head');
      const head = headIndex >= 0 ? rest[headIndex + 1] : null;
      if (head && !allowed.has(`refs/heads/${shortBranch(head)}`)) {
        throw new GhError(`refused: pull request head ${head} is not the task branch`, { argv });
      }
      return true;
    }
    if (sub === 'list' || sub === 'view' || sub === 'diff') return true;
    throw new GhError(`refused: gh pr ${sub ?? ''} is not allowed`, { argv });
  }

  if (op === 'issue') {
    const sub = rest[0];
    if (sub === 'close' || sub === 'delete' || sub === 'transfer' || sub === 'edit' || sub === 'lock') {
      throw new GhError(`refused: gh issue ${sub} mutates a task issue`, { argv });
    }
    return true;
  }

  throw new GhError(`refused: gh ${op} is not an allowed subcommand`, { argv });
}

/** Run a trusted credential command and return its stdout (never logged). */
export async function readCredential({ credentialCommand, timeoutMs = 10000, env, run = runProcess } = {}) {
  if (!credentialCommand || typeof credentialCommand.command !== 'string') {
    throw new GhError('a credential command is required');
  }
  const result = await run({ command: credentialCommand.command, args: credentialCommand.args ?? [], timeoutMs, env });
  if (result.status !== 0) {
    throw new GhError(`credential command failed with exit ${result.status}: ${redactText(result.stderr ?? '', {})}`);
  }
  const value = String(result.stdout ?? '').trim();
  if (value.length === 0) throw new GhError('credential command produced no credential');
  if (/[\r\n]/.test(value)) throw new GhError('credential command produced more than one line');
  return value;
}

function mergeBounds(base, extra) {
  const merged = { ...base, ...(extra ?? {}) };
  if (base?.allowedRefs || extra?.allowedRefs) {
    merged.allowedRefs = [...new Set([...(base?.allowedRefs ?? []), ...(extra?.allowedRefs ?? [])])];
  }
  merged.allowReadOnly = Boolean(base?.allowReadOnly || extra?.allowReadOnly);
  return merged;
}

/**
 * Build a gh api caller bound to a config, a credential command and a timeout.
 * Reads are allowed by default (the guard still refuses merge endpoints); every
 * mutation must pass the exact branch bounds for that call.
 */
export function createGhCaller({ credentialCommand, timeoutMs = 60000, run = runProcess, env = process.env, bounds = { allowReadOnly: true } } = {}) {
  let cached = null;
  const credential = async () => {
    if (cached === null) cached = await readCredential({ credentialCommand, timeoutMs: Math.min(timeoutMs, 10000), env, run });
    return cached;
  };
  return async function gh(argv, extraBounds = null, { stdin = undefined } = {}) {
    const limits = mergeBounds(bounds, extraBounds);
    if (stdin !== undefined && limits.body === undefined) {
      try {
        limits.body = JSON.parse(stdin);
      } catch {
        limits.body = null;
      }
    }
    assertArgvAllowed(argv, limits);
    const token = await credential();
    const childEnv = { ...env, GH_TOKEN: token, GITHUB_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    const result = await run({ command: 'gh', args: argv, timeoutMs, env: childEnv, stdin });
    if (result.status !== 0) {
      const stderr = redactText(result.stderr ?? '', { secrets: [token] });
      const combined = `${stderr}\n${redactText(result.stdout ?? '', { secrets: [token] })}`;
      if (/HTTP 422|already exists/i.test(combined)) {
        throw new RefExistsError(`gh ${argv.join(' ')} reported an existing resource`, { argv, status: result.status, stderr });
      }
      if (/HTTP 404|Not Found/i.test(combined)) {
        throw new NotFoundError(`gh ${argv.join(' ')} reported not found`, { argv, status: result.status, stderr });
      }
      throw new GhError(`gh ${argv.join(' ')} failed with exit ${result.status}: ${stderr}`, {
        argv,
        status: result.status,
        stderr,
        code: result.timedOut ? 'TIMEOUT' : undefined,
      });
    }
    const text = String(result.stdout ?? '').trim();
    if (text.length === 0) return {};
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          /* fall through */
        }
      }
      return { raw: text };
    }
  };
}

/** Normalize a raw GitHub pull request ({head:{ref}} shape) for comparisons. */
export function normalizePull(pull) {
  if (!pull || typeof pull !== 'object') return pull;
  const head = typeof pull.head === 'string' ? pull.head : pull.head?.ref ?? null;
  const base = typeof pull.base === 'string' ? pull.base : pull.base?.ref ?? null;
  return {
    number: pull.number ?? null,
    url: pull.html_url ?? pull.url ?? null,
    head,
    base,
    state: pull.state ?? 'open',
    draft: Boolean(pull.draft),
    title: pull.title ?? null,
  };
}

/**
 * Idempotent pull request creation: list first, create only when absent, and
 * never merge or close. An ambiguous create timeout/conflict is resolved by
 * querying again instead of creating a second PR.
 */
export async function ensurePullRequest({ adapter, head, base, title, body, draft = true }) {
  const existing = await adapter.listPulls({ head, base });
  const already = Array.isArray(existing)
    ? existing.map(normalizePull).find((pull) => pull.head === head && pull.base === base && pull.state !== 'closed')
    : null;
  if (already) return { ...already, created: false };
  try {
    const created = normalizePull(await adapter.createPull({ head, base, title, body, draft }));
    return { ...created, created: true };
  } catch (err) {
    if (err?.code !== 'TIMEOUT' && err?.code !== 'CONFLICT') throw err;
    const after = await adapter.listPulls({ head, base });
    const recovered = Array.isArray(after)
      ? after.map(normalizePull).find((pull) => pull.head === head && pull.base === base && pull.state !== 'closed')
      : null;
    if (recovered) return { ...recovered, created: false, recovered: true };
    throw err;
  }
}

/**
 * Build the GitHub adapter. It only ever performs ref/commit/PR/status/file
 * operations; there is deliberately no merge or issue-close method.
 */
export function createGithubAdapter({ config, run = runProcess, env = process.env, credentialCommand, remote = 'origin' } = {}) {
  if (!config?.repository) throw new GhError('github adapter requires a configured repository');
  const repo = config.repository;
  const caller = createGhCaller({
    credentialCommand: credentialCommand ?? config.github.credentialCommand,
    timeoutMs: config.timeouts?.gitMs ?? 60000,
    run,
    env,
    bounds: { allowReadOnly: true, allowedRefs: [config.github.logRef] },
  });
  const taskBounds = (branch) => ({ allowedBranch: branch, allowedRefs: [config.github.logRef], allowReadOnly: true });

  const api = (argv, extraBounds, options) => caller(argv, extraBounds, options);

  async function getIssue(number) {
    const issue = await api(['api', `repos/${repo}/issues/${number}`]);
    const labels = Array.isArray(issue?.labels) ? issue.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean) : [];
    if (issue?.pull_request) throw new GhError(`#${number} is a pull request, not a task issue`);
    return {
      number: issue?.number ?? number,
      title: issue?.title ?? '',
      body: issue?.body ?? '',
      state: issue?.state ?? 'unknown',
      user: { login: issue?.user?.login ?? '' },
      labels,
      labelsDetailed: Array.isArray(issue?.labels) ? issue.labels : [],
    };
  }

  async function commitExists({ sha, ref = null } = {}) {
    if (ref) {
      try {
        const found = await api(['api', `repos/${repo}/git/ref/heads/${shortBranch(ref)}`]);
        return found?.object?.sha === sha;
      } catch (err) {
        if (err.code === 'NOT_FOUND') return false;
        throw err;
      }
    }
    try {
      const found = await api(['api', `repos/${repo}/git/commits/${sha}`]);
      return Boolean(found?.sha);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return false;
      throw err;
    }
  }

  async function createCommit({ treeText, message, parents = [], branch }) {
    const blob = await api(['api', '--method', 'POST', `repos/${repo}/git/blobs`, '--input', '-'], { allowedBranch: branch || undefined },
      { stdin: JSON.stringify({ content: treeText, encoding: 'utf-8' }) });
    const tree = await api(['api', '--method', 'POST', `repos/${repo}/git/trees`, '--input', '-'], { allowedBranch: branch || undefined },
      { stdin: JSON.stringify({ tree: [{ path: 'task.json', mode: '100644', type: 'blob', sha: blob.sha }] }) });
    const commit = await api(['api', '--method', 'POST', `repos/${repo}/git/commits`, '--input', '-'], { allowedBranch: branch || undefined },
      { stdin: JSON.stringify({ message, tree: tree.sha, parents: [...parents] }) });
    return { sha: commit.sha, tree: tree.sha, message, parents: [...parents], branch: branch ?? null };
  }

  async function createRef({ ref, sha, bounds }) {
    await api(['api', '--method', 'POST', `repos/${repo}/git/refs`, '--input', '-'], bounds ?? { allowedRefs: [ref] },
      { stdin: JSON.stringify({ ref, sha }) });
    return { ref, sha };
  }

  async function getRef(ref) {
    const found = await api(['api', `repos/${repo}/git/ref/heads/${shortBranch(ref)}`]);
    return { ref, sha: found?.object?.sha ?? null };
  }

  async function readFile({ path: filePath, ref }) {
    try {
      const found = await api(['api', `repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`]);
      if (!found?.content) return null;
      return { content: Buffer.from(String(found.content).replace(/\n/g, ''), 'base64').toString('utf8'), sha: found.sha };
    } catch (err) {
      if (err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async function writeFile({ path: filePath, content, message, branch }) {
    const current = await readFile({ path: filePath, ref: branch }).catch(() => null);
    const payload = {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(current?.sha ? { sha: current.sha } : {}),
    };
    return api(
      ['api', '--method', 'PUT', `repos/${repo}/contents/${filePath}`, '--input', '-'],
      { allowedBranch: branch },
      { stdin: JSON.stringify(payload) },
    );
  }

  async function ensureRef({ ref, sha, message }) {
    try {
      await createRef({ ref, sha, bounds: { allowedRefs: [ref] } });
      return { ref, sha, created: true };
    } catch (err) {
      if (err.code !== 'CONFLICT' && err.code !== 'TIMEOUT') throw err;
      const existing = await getRef(ref).catch(() => null);
      if (!existing?.sha) throw err;
      return { ref, sha: existing.sha, created: false, recovered: true };
    }
  }

  const statusPathFor = (issueNumber) => `.pipeline/status/issue-${issueNumber}.json`;
  const statusBranchFor = (issueNumber) => `automation/status/issue-${issueNumber}`;
  const claimRefFor = (issueNumber) => `${config.github.refPrefix}/issue-${issueNumber}`;

  async function readStatus(issueNumber) {
    const branch = statusBranchFor(issueNumber);
    const found = await readFile({ path: statusPathFor(issueNumber), ref: branch }).catch((err) => {
      if (err.code === 'NOT_FOUND') return null;
      throw err;
    });
    if (!found) return null;
    try {
      return JSON.parse(found.content);
    } catch {
      throw new GhError(`remote status for issue ${issueNumber} is not valid JSON`);
    }
  }

  async function writeStatus(issueNumber, payload) {
    const branch = statusBranchFor(issueNumber);
    const ref = `refs/heads/${branch}`;
    const existing = await getRef(ref).catch((err) => {
      if (err.code === 'NOT_FOUND') return null;
      throw err;
    });
    if (!existing?.sha) {
      const commit = await createCommit({ treeText: '{}', message: `automation status issue-${issueNumber}`, parents: [payload.baseSha ?? config.baseRef], branch });
      await createRef({ ref, sha: commit.sha, bounds: { allowedRefs: [ref] } });
    }
    await writeFile({
      path: statusPathFor(issueNumber),
      content: `${JSON.stringify(payload, null, 2)}\n`,
      message: `automation status issue-${issueNumber} -> ${payload.status}`,
      branch,
    });
    return { ok: true, branch };
  }

  async function acquireClaim({ spec, workerId, runId, digest }) {
    const ref = claimRefFor(spec.issueNumber);
    const payload = { schemaVersion: 1, issueNumber: spec.issueNumber, workerId, runId, specDigest: digest, baseSha: spec.baseSha, branch: spec.branch };
    const bodyText = JSON.stringify(payload, null, 2);
    const commit = await createCommit({ treeText: bodyText, message: `automation claim issue-${spec.issueNumber} (${workerId})`, parents: [spec.baseSha], branch: spec.branch });
    try {
      await createRef({ ref, sha: commit.sha, bounds: { allowedRefs: [ref] } });
      return { claimed: true, ref, commit, owner: payload };
    } catch (err) {
      if (err.code !== 'CONFLICT' && err.code !== 'TIMEOUT') throw err;
      return { claimed: false, reason: 'exists', ref };
    }
  }

  async function ownerOfClaim(issueNumber) {
    const ref = claimRefFor(issueNumber);
    let existing = null;
    try {
      existing = await getRef(ref);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return null;
      throw err;
    }
    if (!existing?.sha) return null;
    const commit = await api(['api', `repos/${repo}/git/commits/${existing.sha}`]);
    const treeSha = commit?.tree?.sha;
    if (!treeSha) throw new GhError(`claim commit ${existing.sha} has no tree`);
    const tree = await api(['api', `repos/${repo}/git/trees/${treeSha}`]);
    const entry = Array.isArray(tree?.tree) ? tree.tree.find((node) => node.type === 'blob') : null;
    if (!entry?.sha) return { owner: null, sha: existing.sha, ref };
    const blob = await api(['api', `repos/${repo}/git/blobs/${entry.sha}`]);
    let text = '';
    if (blob?.content) text = Buffer.from(String(blob.content).replace(/\n/g, ''), 'base64').toString('utf8');
    else if (blob?.raw) text = String(blob.raw);
    let owner = null;
    try {
      owner = JSON.parse(text);
    } catch {
      return { owner: null, sha: existing.sha, ref };
    }
    return { owner, sha: existing.sha, ref };
  }

  async function listPulls({ head, base }) {
    const data = await api(['api', `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${head}`)}&base=${encodeURIComponent(base)}`]);
    return Array.isArray(data) ? data.map(normalizePull) : [];
  }

  async function createPull({ head, base, title, body, draft }) {
    const created = await api(
      ['api', '--method', 'POST', `repos/${repo}/pulls`, '--input', '-'],
      { allowedBranch: head },
      { stdin: JSON.stringify({ title, head, base, body, draft: Boolean(draft) }) },
    );
    return normalizePull({ ...created, head, base, draft: created?.draft ?? draft, state: created?.state ?? 'open' });
  }

  async function refSha(ref) {
    try {
      const found = await getRef(ref);
      return found.sha ?? null;
    } catch (err) {
      if (err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  return {
    async probe() {
      const user = await api(['api', 'user']);
      return { login: user?.login ?? null, repository: repo };
    },
    getIssue,
    commitExists,
    createCommit,
    createRef,
    getRef,
    refSha,
    readFile,
    writeFile,
    statusBranchFor,
    claimRefFor,
    acquireClaim,
    ownerOfClaim,
    readStatus,
    writeStatus,
    listPulls,
    createPull,
    api,
    bounds: taskBounds,
    remote,
    repository: repo,
  };
}

export { GhError, RefExistsError, NotFoundError, BRANCH_REF };
