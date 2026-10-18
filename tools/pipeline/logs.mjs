// Local full-fidelity logs plus sanitized exports.
// Raw transcripts stay on this machine; exports and remote summaries never
// contain credentials, auth headers or machine-specific absolute paths.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { redactObject, redactText } from './redact.mjs';

const SUMMARY_KEYS = [
  'issueNumber', 'status', 'reason', 'attempt', 'fixRetries', 'specDigest',
  'baseSha', 'headSha', 'branch', 'phase', 'pull', 'updatedAt', 'workerId',
  'runId', 'verdict', 'sessionId',
];

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

/**
 * Create a log store rooted at a local directory.
 * `machineRoots` are absolute local paths that must never appear in an export.
 * `secrets` are exact values that must never appear in an export.
 */
export function createLogStore({ dir, machineRoots = [], secrets = [], now = () => new Date().toISOString() } = {}) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('log store requires an absolute local directory');
  const roots = [...machineRoots];
  const knownSecrets = new Set(secrets);

  const issueDir = (issueNumber) => path.join(dir, `issue-${safeSegment(issueNumber)}`);
  const rawPath = (issueNumber) => path.join(issueDir(issueNumber), 'raw.jsonl');
  const exportDir = (issueNumber) => path.join(dir, '_exports', `issue-${safeSegment(issueNumber)}`);
  const exportPath = (issueNumber) => path.join(exportDir(issueNumber), 'export.log');
  const summaryPath = (issueNumber) => path.join(issueDir(issueNumber), 'summary.json');

  function redactOptions() {
    return { machineRoots: roots, secrets: [...knownSecrets] };
  }

  return {
    dir,
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 4) knownSecrets.add(secret);
    },
    addMachineRoot(root) {
      if (typeof root === 'string' && path.isAbsolute(root)) roots.push(root);
    },
    /** Append one record to the local raw transcript. */
    async record(issueNumber, event) {
      await fsp.mkdir(issueDir(issueNumber), { recursive: true });
      const safe = redactObject({ at: now(), ...event }, redactOptions());
      await fsp.appendFile(rawPath(issueNumber), `${JSON.stringify(safe)}\n`, 'utf8');
      if (event && typeof event === 'object' && 'status' in event) {
        await this.writeSummary(issueNumber, event);
      }
      return safe;
    },
    /** Persist the task snapshot that both `status` and `export-logs` read. */
    async writeSummary(issueNumber, state) {
      await fsp.mkdir(issueDir(issueNumber), { recursive: true });
      const summary = {};
      for (const key of SUMMARY_KEYS) {
        if (state[key] !== undefined) summary[key] = state[key];
      }
      summary.updatedAt = state.updatedAt ?? now();
      await fsp.writeFile(summaryPath(issueNumber), `${JSON.stringify(redactObject(summary, redactOptions()), null, 2)}\n`, 'utf8');
      return summary;
    },
    async summary(issueNumber) {
      try {
        return JSON.parse(await fsp.readFile(summaryPath(issueNumber), 'utf8'));
      } catch {
        return null;
      }
    },
    async list(issueNumber) {
      try {
        return await fsp.readdir(issueDir(issueNumber));
      } catch {
        return [];
      }
    },
    async readRaw(issueNumber) {
      try {
        return await fsp.readFile(rawPath(issueNumber), 'utf8');
      } catch {
        return '';
      }
    },
    /**
     * Write the sanitized local export. Only redacted data leaves this machine.
     * This never uploads raw credentials and never claims to have uploaded
     * anything: sharing is a separate, explicit publisher step.
     */
    async exportIssue(issueNumber, targetDir) {
      const outDir = targetDir ?? exportDir(issueNumber);
      await fsp.mkdir(outDir, { recursive: true });
      const raw = await this.readRaw(issueNumber);
      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const redactedLines = lines.map((line) => {
        try {
          return JSON.stringify(redactObject(JSON.parse(line), redactOptions()));
        } catch {
          return JSON.stringify({ type: 'unparsed', text: redactText(line, redactOptions()) });
        }
      });
      const summary = (await this.summary(issueNumber)) ?? {};
      const header = JSON.stringify({ kind: 'pipeline-export', schemaVersion: 1, issueNumber, exportedAt: now(), redaction: 'secrets and machine paths removed' });
      const summaryLine = JSON.stringify({ kind: 'summary', ...redactObject(summary, redactOptions()) });
      const file = path.join(outDir, 'export.log');
      await fsp.writeFile(file, [header, summaryLine, ...redactedLines].join('\n') + '\n', 'utf8');
      return file;
    },
    /** The digest-only payload that may be attached to an Issue or PR. */
    async remoteSummary(issueNumber, { logsRef = null, runId = null } = {}) {
      const summary = (await this.summary(issueNumber)) ?? {};
      return {
        schemaVersion: 1,
        issueNumber,
        status: summary.status ?? 'unknown',
        reason: summary.reason ?? null,
        attempt: summary.attempt ?? null,
        fixRetries: summary.fixRetries ?? null,
        specDigest: summary.specDigest ?? null,
        headSha: summary.headSha ?? null,
        runId: runId ?? summary.runId ?? null,
        logsRef,
        note: 'sanitized summary only; raw transcripts stay on the controller machine',
      };
    },
    paths: { issueDir, rawPath, exportDir, exportPath, summaryPath },
    exportDirFor: exportDir,
  };
}

export { SUMMARY_KEYS };
