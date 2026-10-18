// Fixed prompt rendering. Issue text is substituted into a local markdown
// template as data; it is never interpolated into a shell command.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const TEMPLATE_NAMES = Object.freeze(['implement', 'review']);

export function templatePath(name) {
  if (!TEMPLATE_NAMES.includes(name)) throw new Error(`unknown prompt template: ${name}`);
  return path.join(HERE, 'templates', `${name}.md`);
}

export function readTemplate(name) {
  return fs.readFileSync(templatePath(name), 'utf8');
}

/**
 * Render a fixed template. Every <<value>> placeholder must be supplied; a
 * missing value is a programming error, not a silent empty string. Values that
 * contain a fence are neutralised so a manifest cannot break out of the prompt
 * structure, and the result is checked for leftovers.
 */
export function renderTemplate(name, values = {}) {
  const template = readTemplate(name);
  const rendered = template.replace(/<<([A-Za-z0-9_]+)>>/g, (_match, key) => {
    if (!(key in values)) throw new Error(`prompt template ${name} references unknown value ${key}`);
    const value = values[key];
    if (value === undefined || value === null) throw new Error(`prompt template ${name} value ${key} is empty`);
    return String(value).replace(/```/g, '``\u200b`');
  });
  const leftover = /<<[A-Za-z0-9_]+>>/.exec(rendered);
  if (leftover) throw new Error(`prompt template ${name} still contains ${leftover[0]}`);
  return rendered;
}

export function renderImplementPrompt(values) {
  return renderTemplate('implement', values);
}

export function renderReviewPrompt(values) {
  return renderTemplate('review', values);
}

export function listTemplates() {
  return TEMPLATE_NAMES.map((name) => ({ name, path: templatePath(name) }));
}
