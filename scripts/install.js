import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKILL_SRC = join(ROOT, 'skills', 'snipra', 'SKILL.md');

const PLATFORMS = [
  {
    name: 'Claude Code',
    bin: 'claude',
    skillDir: join(homedir(), '.claude', 'skills', 'snipra'),
  },
  {
    name: 'Codex',
    bin: 'codex',
    skillDir: join(homedir(), '.agents', 'skills', 'snipra'),
  },
  {
    name: 'OpenCode',
    bin: 'opencode',
    skillDir: join(homedir(), '.config', 'opencode', 'skills', 'snipra'),
  },
  {
    name: 'OpenClaw',
    bin: 'openclaw',
    skillDir: join(homedir(), '.openclaw', 'skills', 'snipra'),
  },
  {
    name: 'Hermes Agent',
    bin: 'hermes',
    skillDir: join(homedir(), '.hermes', 'skills', 'snipra'),
  },
];

function detectPlatform(name, bin) {
  try {
    execSync(`which ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installSkill(skillDir, name) {
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(SKILL_SRC, join(skillDir, 'SKILL.md'));
  console.log(`✓ Installed to ${name.padEnd(16)} (${skillDir})`);
}

console.log('snipra skill installer v2.0.0');
console.log('Detecting platforms...\n');

if (!existsSync(SKILL_SRC)) {
  console.error(`Error: SKILL.md not found at ${SKILL_SRC}`);
  console.error('Make sure skills/snipra/SKILL.md exists before running install.');
  process.exit(1);
}

let installed = 0;
let skipped = 0;

for (const { name, bin, skillDir } of PLATFORMS) {
  if (detectPlatform(name, bin)) {
    try {
      installSkill(skillDir, name);
      installed++;
    } catch (e) {
      console.log(`✗ Failed ${name.padEnd(16)} — ${e.message}`);
      skipped++;
    }
  } else {
    console.log(`✗ Skipped ${name.padEnd(16)} (not found)`);
    skipped++;
  }
}

console.log(`\nDone. ${installed} platform(s) configured, ${skipped} skipped.`);
if (installed > 0) {
  console.log('Restart your platform(s) to load the skill.');
}
