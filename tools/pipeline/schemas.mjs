// Strict manifest + review schemas. The JSON files under schemas/ are the
// published contract; the validators here are the enforcement.
import crypto from 'node:crypto';
import path from 'node:path';

const HEX40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RESERVED = new Set(['main', 'master', 'trunk', 'head', 'develop', 'release']);
const VERDICTS = new Set(['pass', 'needs-fix', 'blocked']);
const SEVERITIES = new Set(['critical', 'important', 'minor', 'nit']);

/** This controller only ever plans work for the qingfeng-village-game repository. */
export const PLANNED_REPOSITORY = 'xyz537/qingfeng-village-game';

export const taskManifestSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://qingfeng.invalid/schemas/task.schema.json',
  title: 'Qingfeng pipeline task manifest',
  description: 'Frozen, approved task manifest embedded in an Issue body as a single ```json fenced block.',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'repository', 'issueNumber', 'title', 'approvedBy',
    'baseRef', 'baseSha', 'branch', 'allowedPaths', 'acceptance',
    'verificationCommands', 'maxFixRetries',
  ],
  properties: {
    schemaVersion: { const: 1 },
    repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
    issueNumber: { type: 'integer', minimum: 1 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    approvedBy: { type: 'string', minLength: 1, maxLength: 80 },
    baseRef: { type: 'string', minLength: 1, maxLength: 200 },
    baseSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    branch: { type: 'string', pattern: '^agent/issue-[0-9]+-[a-z0-9][a-z0-9-]*$' },
    allowedPaths: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*/$' },
    },
    acceptance: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1, maxLength: 500 } },
    verificationCommands: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'args'],
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    maxFixRetries: { const: 2 },
  },
});

// Strict review report schema. Mirrors schemas/review.schema.json, which is the
// document handed to Codex strict Structured Outputs: every object at every
// depth sets additionalProperties=false and lists *all* of its properties in
// `required` (the API refuses the request before inference otherwise). Optional
// detail is never omitted; it uses the sentinel "" (no evidence/path/output) or
// 0 (no line). The runtime validator below additionally accepts an *absent*
// specDigest/output so controller-built and legacy in-memory reports still
// validate; the model itself is required to emit every key.
export const reviewReportSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://qingfeng.invalid/schemas/review.schema.json',
  title: 'Qingfeng pipeline review report',
  description: 'Independent review verdict emitted by the Codex review session.',
  type: 'object',
  additionalProperties: false,
  required: ['headSha', 'verdict', 'acceptanceResults', 'findings', 'testEvidence'],
  properties: {
    headSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    verdict: { enum: ['pass', 'needs-fix', 'blocked'] },
    acceptanceResults: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'passed', 'evidence'],
        properties: {
          text: { type: 'string', minLength: 1 },
          passed: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'message', 'path', 'line'],
        properties: {
          severity: { enum: ['critical', 'important', 'minor', 'nit'] },
          message: { type: 'string', minLength: 1 },
          path: { type: 'string' },
          line: { type: 'integer' },
        },
      },
    },
    testEvidence: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'exitCode', 'headSha', 'specDigest', 'output', 'startedAt', 'endedAt'],
        properties: {
          command: { type: 'string', minLength: 1 },
          exitCode: { type: 'integer' },
          headSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
          specDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          output: { type: 'string' },
          startedAt: { type: 'string', minLength: 1 },
          endedAt: { type: 'string', minLength: 1 },
        },
      },
    },
  },
});

function error(pathName, message) {
  return { path: pathName, message: `${pathName}: ${message}` };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function checkUnknownKeys(value, allowed, basePath, errors) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(error(`${basePath}.${key}`, `unexpected field`));
  }
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (/[\u0000\r\n]/.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '..' || segment === '.')) return false;
  return segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment));
}

function isSafeBranchName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.')) return false;
  const normalized = value.replace(/^refs\/heads\//, '').toLowerCase();
  if (RESERVED.has(normalized)) return false;
  if (normalized.startsWith('automation/')) return false;
  if (normalized === 'head' || normalized.startsWith('head/')) return false;
  return true;
}

/**
 * Validate a decoded task manifest.
 * `expectedRepository` may pin the manifest to this controller's repository; a
 * manifest for any other repository is refused outright.
 * Returns { ok, spec, errors }. A failed manifest is never executed.
 */
export function validateTaskSpec(candidate, { expectedRepository = PLANNED_REPOSITORY } = {}) {
  const errors = [];
  if (!isPlainObject(candidate)) {
    return { ok: false, spec: null, errors: [error('manifest', 'must be a JSON object')] };
  }
  const fields = taskManifestSchema.required;
  checkUnknownKeys(candidate, fields, 'manifest', errors);
  for (const field of fields) {
    if (candidate[field] === undefined || candidate[field] === null) errors.push(error(`manifest.${field}`, 'is required'));
  }
  if (candidate.schemaVersion !== 1) errors.push(error('manifest.schemaVersion', 'must be exactly 1'));
  if (typeof candidate.repository !== 'string' || !REPO.test(candidate.repository)) {
    errors.push(error('manifest.repository', 'must be an owner/name repository'));
  } else if (expectedRepository && candidate.repository !== expectedRepository) {
    errors.push(error('manifest.repository', `must be ${expectedRepository}, not ${candidate.repository}`));
  }
  if (!Number.isInteger(candidate.issueNumber) || candidate.issueNumber < 1) {
    errors.push(error('manifest.issueNumber', 'must be a positive integer'));
  }
  if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0 || candidate.title.length > 200) {
    errors.push(error('manifest.title', 'must be 1..200 characters'));
  }
  if (typeof candidate.approvedBy !== 'string' || candidate.approvedBy.trim().length === 0 || candidate.approvedBy.length > 80) {
    errors.push(error('manifest.approvedBy', 'must name the approving user'));
  }
  if (typeof candidate.baseRef !== 'string' || !isSafeBranchName(candidate.baseRef)) {
    errors.push(error('manifest.baseRef', 'must be a non-shared branch name'));
  }
  if (typeof candidate.baseSha !== 'string' || !HEX40.test(candidate.baseSha)) {
    errors.push(error('manifest.baseSha', 'must be a full 40 character commit sha'));
  }
  if (typeof candidate.branch !== 'string' || !/^agent\/issue-[0-9]+-[a-z0-9][a-z0-9-]*$/.test(candidate.branch)) {
    errors.push(error('manifest.branch', 'must match agent/issue-<N>-<slug>'));
  } else {
    const expected = `agent/issue-${candidate.issueNumber}-`;
    if (!candidate.branch.startsWith(expected)) {
      errors.push(error('manifest.branch', `must start with ${expected}`));
    }
    if (candidate.branch.length > 120) errors.push(error('manifest.branch', 'is too long'));
  }
  if (!Array.isArray(candidate.allowedPaths) || candidate.allowedPaths.length === 0) {
    errors.push(error('manifest.allowedPaths', 'must be a non-empty array of repository-relative directories'));
  } else {
    candidate.allowedPaths.forEach((entry, i) => {
      if (typeof entry !== 'string' || !entry.endsWith('/') || !isSafeRelativePath(entry.replace(/\/$/, ''))) {
        errors.push(error(`manifest.allowedPaths[${i}]`, 'must be a relative directory like tools/pipeline/'));
      }
    });
  }
  if (!Array.isArray(candidate.acceptance) || candidate.acceptance.length === 0) {
    errors.push(error('manifest.acceptance', 'must be a non-empty array of acceptance statements'));
  } else {
    candidate.acceptance.forEach((entry, i) => {
      if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 500) {
        errors.push(error(`manifest.acceptance[${i}]`, 'must be a 1..500 character statement'));
      }
    });
  }
  if (!Array.isArray(candidate.verificationCommands) || candidate.verificationCommands.length === 0) {
    errors.push(error('manifest.verificationCommands', 'must be a non-empty array'));
  } else {
    // Shape only. The machine-local allowlist is enforced when the task is
    // claimed (checkEligibility -> command-not-allowed), not here.
    candidate.verificationCommands.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        errors.push(error(`manifest.verificationCommands[${i}]`, 'must be an object'));
        return;
      }
      const extra = Object.keys(entry).filter((key) => key !== 'command' && key !== 'args');
      if (extra.length > 0) errors.push(error(`manifest.verificationCommands[${i}].${extra[0]}`, 'unexpected field'));
      if (typeof entry.command !== 'string' || entry.command.trim().length === 0 || entry.command.length > 240) {
        errors.push(error(`manifest.verificationCommands[${i}].command`, 'must be a command name'));
      }
      if (!Array.isArray(entry.args)) {
        errors.push(error(`manifest.verificationCommands[${i}].args`, 'must be an array of strings'));
      } else {
        entry.args.forEach((arg, j) => {
          if (typeof arg !== 'string' || arg.length > 200 || /[\r\n]/.test(arg)) {
            errors.push(error(`manifest.verificationCommands[${i}].args[${j}]`, 'must be a single-line string'));
          }
        });
      }
    });
  }
  if (candidate.maxFixRetries !== 2) errors.push(error('manifest.maxFixRetries', 'must be exactly 2'));

  if (errors.length > 0) return { ok: false, spec: null, errors };
  const spec = {
    schemaVersion: 1,
    repository: candidate.repository,
    issueNumber: candidate.issueNumber,
    title: candidate.title,
    approvedBy: candidate.approvedBy,
    baseRef: candidate.baseRef,
    baseSha: candidate.baseSha,
    branch: candidate.branch,
    allowedPaths: [...candidate.allowedPaths],
    acceptance: [...candidate.acceptance],
    verificationCommands: candidate.verificationCommands.map((entry) => ({ command: entry.command, args: [...entry.args] })),
    maxFixRetries: 2,
  };
  return { ok: true, spec, errors: [] };
}

/** Deterministic digest of the approved requirements. */
export function canonicalJson(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return `[${node.map(walk).join(',')}]`;
    if (node && typeof node === 'object') {
      const keys = Object.keys(node).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${walk(node[key])}`).join(',')}}`;
    }
    return JSON.stringify(node ?? null);
  };
  return walk(value);
}

export function schemaDigest(spec) {
  return crypto.createHash('sha256').update(canonicalJson(spec), 'utf8').digest('hex');
}

/**
 * Extract the single approved manifest from an Issue body.
 * Multiple JSON blocks, or a block that is not a valid manifest, are refused.
 */
export function extractManifest(body, options = {}) {
  if (typeof body !== 'string') {
    return { ok: false, spec: null, errors: [error('issue.body', 'is empty')] };
  }
  const blocks = [...body.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  if (blocks.length === 0) return { ok: false, spec: null, errors: [error('issue.body', 'has no json fenced block')] };
  if (blocks.length > 1) return { ok: false, spec: null, errors: [error('issue.body', 'has more than one json fenced block')] };
  let parsed;
  try {
    parsed = JSON.parse(blocks[0]);
  } catch (err) {
    return { ok: false, spec: null, errors: [error('issue.body.json', `is not valid JSON: ${err.message}`)] };
  }
  return validateTaskSpec(parsed, options);
}

/** Validate a review verdict object. */
export function validateReviewReport(candidate) {
  const errors = [];
  if (!isPlainObject(candidate)) {
    return { ok: false, report: null, errors: [error('review', 'must be a JSON object')] };
  }
  const fields = reviewReportSchema.required;
  checkUnknownKeys(candidate, fields, 'review', errors);
  for (const field of fields) {
    if (candidate[field] === undefined || candidate[field] === null) errors.push(error(`review.${field}`, 'is required'));
  }
  if (typeof candidate.headSha !== 'string' || !HEX40.test(candidate.headSha)) {
    errors.push(error('review.headSha', 'must be a full 40 character commit sha'));
  }
  if (typeof candidate.verdict !== 'string' || !VERDICTS.has(candidate.verdict)) {
    errors.push(error('review.verdict', 'must be pass, needs-fix or blocked'));
  }
  if (!Array.isArray(candidate.acceptanceResults) || candidate.acceptanceResults.length === 0) {
    errors.push(error('review.acceptanceResults', 'must be a non-empty array'));
  } else {
    candidate.acceptanceResults.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        errors.push(error(`review.acceptanceResults[${i}]`, 'must be an object'));
        return;
      }
      checkUnknownKeys(entry, ['text', 'passed', 'evidence'], `review.acceptanceResults[${i}]`, errors);
      if (typeof entry.text !== 'string' || entry.text.length === 0) errors.push(error(`review.acceptanceResults[${i}].text`, 'is required'));
      if (typeof entry.passed !== 'boolean') errors.push(error(`review.acceptanceResults[${i}].passed`, 'must be a boolean'));
      // The model is required to emit evidence; "" is the explicit "nothing to
      // cite" sentinel, so an absent key is tolerated only for controller-built
      // reports while a wrong type is always refused.
      if (entry.evidence !== undefined && typeof entry.evidence !== 'string') errors.push(error(`review.acceptanceResults[${i}].evidence`, 'must be a string'));
    });
  }
  if (!Array.isArray(candidate.findings)) {
    errors.push(error('review.findings', 'must be an array'));
  } else {
    candidate.findings.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        errors.push(error(`review.findings[${i}]`, 'must be an object'));
        return;
      }
      checkUnknownKeys(entry, ['severity', 'message', 'path', 'line'], `review.findings[${i}]`, errors);
      if (typeof entry.severity !== 'string' || !SEVERITIES.has(entry.severity)) {
        errors.push(error(`review.findings[${i}].severity`, 'must be critical, important, minor or nit'));
      }
      if (typeof entry.message !== 'string' || entry.message.length === 0) errors.push(error(`review.findings[${i}].message`, 'is required'));
      // "" means "no specific file" and 0 means "no specific line": both are
      // valid sentinels, a wrong type or a negative line is not.
      if (entry.path !== undefined && typeof entry.path !== 'string') errors.push(error(`review.findings[${i}].path`, 'must be a string'));
      if (entry.line !== undefined && (!Number.isInteger(entry.line) || entry.line < 0)) {
        errors.push(error(`review.findings[${i}].line`, 'must be a non-negative integer'));
      }
    });
  }
  if (!Array.isArray(candidate.testEvidence) || candidate.testEvidence.length === 0) {
    errors.push(error('review.testEvidence', 'must be a non-empty array of rerun command results'));
  } else {
    candidate.testEvidence.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        errors.push(error(`review.testEvidence[${i}]`, 'must be an object'));
        return;
      }
      checkUnknownKeys(entry, ['command', 'exitCode', 'headSha', 'specDigest', 'output', 'startedAt', 'endedAt'], `review.testEvidence[${i}]`, errors);
      if (typeof entry.command !== 'string' || entry.command.length === 0) errors.push(error(`review.testEvidence[${i}].command`, 'is required'));
      if (!Number.isInteger(entry.exitCode)) errors.push(error(`review.testEvidence[${i}].exitCode`, 'must be an integer'));
      if (typeof entry.headSha !== 'string' || !HEX40.test(entry.headSha)) errors.push(error(`review.testEvidence[${i}].headSha`, 'must be a full commit sha'));
      // The model's schema requires a real digest; "" is accepted here only as
      // the explicit "not bound" sentinel for controller-built evidence.
      if (entry.specDigest !== undefined && entry.specDigest !== '' && (typeof entry.specDigest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.specDigest))) {
        errors.push(error(`review.testEvidence[${i}].specDigest`, 'must be a sha256 hex digest when present'));
      }
      if (typeof entry.startedAt !== 'string' || entry.startedAt.length === 0) errors.push(error(`review.testEvidence[${i}].startedAt`, 'is required'));
      if (typeof entry.endedAt !== 'string' || entry.endedAt.length === 0) errors.push(error(`review.testEvidence[${i}].endedAt`, 'is required'));
      if (entry.output !== undefined && typeof entry.output !== 'string') errors.push(error(`review.testEvidence[${i}].output`, 'must be a string'));
    });
  }
  if (errors.length > 0) return { ok: false, report: null, errors };
  return { ok: true, report: candidate, errors: [] };
}

export { HEX40, VERDICTS, SEVERITIES, isSafeBranchName, isSafeRelativePath };
