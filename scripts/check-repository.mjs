import {execFileSync} from 'node:child_process';
import {readFileSync, lstatSync} from 'node:fs';

// Inspect tracked files, including new files staged before the initial commit.
const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const denied = /(^|\/)(?:local-data|preview-data|data|backups|deliverables|\.deploy-secrets|node_modules)(?:\/|$)|(^|\/)(?:secrets|accounts)\.json$|(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|tar\.gz|zip)$/;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{25,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/;
const errors = [];
for (const file of files) {
  if (denied.test(file) && file !== '.env.example') errors.push(`${file}: private data or credential file`);
  if (lstatSync(file).isSymbolicLink()) { errors.push(`${file}: symbolic links are not supported`); continue; }
  const data = readFileSync(file);
  if (data.includes(0)) { errors.push(`${file}: binary file; review before tracking`); continue; }
  if (secret.test(data.toString('utf8'))) errors.push(`${file}: possible credential; remove and rotate if real`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${files.length} tracked source files; no forbidden files or common credential patterns.`);
// Pattern checks complement manual review; they cannot prove absence of all private information.
