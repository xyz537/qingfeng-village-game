// Local allowlist for verification commands. An Issue manifest can only select
// command names and argument shapes that are preinstalled on this machine and
// reviewed here. No shell, no interpolation, no absolute paths.
import path from 'node:path';

const SAFE_ARG = /^[A-Za-z0-9._/@%+=-]+$/;
const REPO_ROOT = process.cwd();

/**
 * First-round policy required by the spec. One entry per preinstalled binary;
 * the first round only allows node, and only in the three reviewed shapes.
 */
export const ALLOWED_COMMAND_POLICY = Object.freeze([
  Object.freeze({
    name: 'node',
    names: Object.freeze(['node', 'node.exe']),
    description: 'The repository has no dependencies; node may only type-check or run fixed entry points.',
    shapes: Object.freeze([
      Object.freeze({ kind: 'exact', args: Object.freeze(['test.cjs']), description: 'repository regression suite' }),
      Object.freeze({ kind: 'check', pathIndex: 1, description: 'node --check <repo-relative file>' }),
      Object.freeze({ kind: 'test-runner', pathIndex: 1, description: 'node --test <repo-relative .mjs>' }),
    ]),
  }),
  Object.freeze({
    name: 'node-pipeline-suite',
    names: Object.freeze(['node.exe']),
    description: 'Explicit alias for the pipeline suite so the policy documents what CI runs.',
    shapes: Object.freeze([
      Object.freeze({ kind: 'exact', args: Object.freeze(['test.cjs']), description: 'repository regression suite' }),
      Object.freeze({ kind: 'check', pathIndex: 1, description: 'node --check <repo-relative file>' }),
      Object.freeze({ kind: 'test-runner', pathIndex: 1, description: 'node --test <repo-relative .mjs>' }),
    ]),
  }),
]);

export const DEFAULT_VERIFICATION_COMMANDS = Object.freeze([
  Object.freeze({ command: 'node', args: Object.freeze(['--check', 'game.js']) }),
  Object.freeze({ command: 'node', args: Object.freeze(['--check', 'test.cjs']) }),
  Object.freeze({ command: 'node', args: Object.freeze(['test.cjs']) }),
]);

function policyFor(command) {
  return ALLOWED_COMMAND_POLICY.find((entry) => entry.names.includes(command)) ?? null;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\u0000') || value.includes('\r') || value.includes('\n')) return false;
  if (/[\s"'`;$&|<>*?!]/.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '..' || segment === '' )) return false;
  return segments.every((segment) => SAFE_ARG.test(segment));
}

/** True when the command may run on this machine as a task verification step. */
export function isAllowedVerificationCommand(command, policy = ALLOWED_COMMAND_POLICY) {
  if (!command || typeof command !== 'object') return false;
  const { command: name, args } = command;
  if (typeof name !== 'string' || !Array.isArray(args)) return false;
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 200) return false;
  }
  const entry = policy.find((candidate) => candidate.names.includes(name)) ?? null;
  if (!entry) return false;
  for (const shape of entry.shapes) {
    if (shape.kind === 'exact') {
      if (args.length === shape.args.length && shape.args.every((expected, i) => args[i] === expected)) return true;
    } else if (shape.kind === 'check') {
      if (args.length === 2 && args[0] === '--check' && isSafeRelativePath(args[1])) return true;
    } else if (shape.kind === 'test-runner') {
      if (args.length === 2 && args[0] === '--test' && isSafeRelativePath(args[1]) && args[1].endsWith('.mjs')) return true;
    }
  }
  return false;
}

/** Human-readable refusal reason, or null when allowed. */
export function verificationCommandProblem(command) {
  if (!command || typeof command !== 'object') return 'command must be an object';
  const name = command.command;
  const args = command.args;
  if (typeof name !== 'string') return 'command name must be a string';
  if (!policyFor(name)) return `command "${name}" is not on this machine's allowlist`;
  if (!Array.isArray(args)) return 'args must be an array';
  if (isAllowedVerificationCommand(command)) return null;
  return `arguments for "${name}" (${args.join(' ')}) do not match an allowed shape`;
}

export function verificationPolicy() {
  return {
    commandNames: ALLOWED_COMMAND_POLICY.map((entry) => entry.names).flat(),
    allowShell: false,
    allowAbsolutePaths: false,
    allowIssueSuppliedCommands: false,
    defaults: DEFAULT_VERIFICATION_COMMANDS.map((entry) => `${entry.command} ${entry.args.join(' ')}`),
    cwd: REPO_ROOT,
  };
}
