// Secret exposure review: looks through the repository for passwords, keys, tokens and .env files.
//   npm run secret-scan            (from booking-service; scans the whole repository)
// Exit code 1 if anything is found, so it can also run in CI.
// Matches are printed masked (first 4 characters only), so the scan itself never leaks a secret.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'coverage', '.vercel']);
const TEXT = /\.(js|json|md|sql|yml|yaml|html|css|http|txt|env|example|sh|ps1|cjs|mjs)$|^\.env/;

// Values that are public on purpose (test fixtures and the documented local demo password).
const ALLOWED = [/test/i, /example/i, /fake/i, /not-a-real/i, /placeholder/i, /YOUR-/, /Demo-Pass-2026/, /choose-a-long-random/i, /wrong-secret/i, /another-secret/i];

const RULES = [
  { name: 'Database URL with a password', re: /postgres(?:ql)?:\/\/[^:\s/'"]+:([^@\s'"]{6,})@/g },
  { name: 'JWT / bearer token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Hard-coded secret', re: /\b(?:JWT_SECRET|WEBHOOK_SECRET|ORS_API_KEY|API_KEY|SECRET_KEY|PASSWORD|TOKEN)\b\s*[:=]\s*['"]?([A-Za-z0-9_+/=-]{16,})/g },
  { name: 'Discord/Slack webhook', re: /https:\/\/(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)\/[A-Za-z0-9_/-]{20,}/g }
];

function files() {
  try {
    // Only what git would publish (tracked + not ignored), when this is a git checkout.
    const out = execSync('git ls-files --cached --others --exclude-standard', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.split('\n').filter(Boolean).map((f) => path.join(ROOT, f));
  } catch (error) {
    const found = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (SKIP_DIRS.has(e.name)) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else found.push(full);
    });
    walk(ROOT);
    return found;
  }
}

// Outside a git checkout: a .env is only a finding if no .gitignore on its path ignores it.
function ignoredByGitignore(file) {
  let dir = path.dirname(file);
  while (dir.startsWith(ROOT)) {
    const gi = path.join(dir, '.gitignore');
    if (fs.existsSync(gi) && fs.readFileSync(gi, 'utf8').split(/\r?\n/).map((l) => l.trim()).includes('.env')) return true;
    if (dir === ROOT) break;
    dir = path.dirname(dir);
  }
  return false;
}

function scan() {
  const findings = [];
  const list = files();
  for (const file of list) {
    const name = path.basename(file);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') {
      if (ignoredByGitignore(file)) continue;   // never published: .gitignore keeps it out of the repository
      findings.push({ file: rel, line: 0, rule: '.env file would be published', sample: name });
      continue;
    }
    if (!TEXT.test(name) || !fs.existsSync(file) || fs.statSync(file).size > 2 * 1024 * 1024) continue;
    if (name === 'package-lock.json') continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(text))) {
          const value = m[1] || m[0];
          if (ALLOWED.some((ok) => ok.test(text))) continue;
          if (value.includes('${')) continue;   // a code template that is filled in at run time, not a value
          findings.push({ file: rel, line: i + 1, rule: rule.name, sample: `${value.slice(0, 4)}****` });
        }
      }
    });
  }
  return { scanned: list.length, findings };
}

if (require.main === module) {
  const { scanned, findings } = scan();
  if (findings.length === 0) {
    console.log(`Secret scan: ${scanned} files checked, no secrets found.`);
  } else {
    console.log(`Secret scan: ${findings.length} possible secret(s) in ${scanned} files:`);
    console.table(findings);
    process.exitCode = 1;
  }
}

module.exports = { scan };
