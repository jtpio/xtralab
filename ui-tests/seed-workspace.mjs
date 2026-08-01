// Builds the workspace the screenshot suite runs against: the fixture project
// as a git repository, with a baseline commit and working-tree changes on top.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import workspaceRoot from './workspace-root.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const workspace = join(workspaceRoot, 'demo-project');

rmSync(workspaceRoot, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
cpSync(join(fixtures, 'demo-project'), workspace, { recursive: true });

// Fixed identity and dates, no user/system config: the seeded repository is
// identical from one run to the next.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Acme Dev',
  GIT_AUTHOR_EMAIL: 'dev@acme.test',
  GIT_COMMITTER_NAME: 'Acme Dev',
  GIT_COMMITTER_EMAIL: 'dev@acme.test',
  GIT_AUTHOR_DATE: '2024-03-01T09:00:00Z',
  GIT_COMMITTER_DATE: '2024-03-01T09:00:00Z'
};
const git = (...args) =>
  execFileSync('git', args, { cwd: workspace, env, stdio: 'pipe' });

git('init', '--initial-branch=main');

// Commit the baseline versions, then restore the working-tree state: a
// modified README.md and metrics.py plus an untracked forecast.py.
rmSync(join(workspace, 'src', 'acme', 'forecast.py'));
cpSync(join(fixtures, 'baseline'), workspace, { recursive: true });
git('add', '-A');
git('commit', '-m', 'Initial analytics toolkit');
cpSync(join(fixtures, 'demo-project'), workspace, { recursive: true });

console.log(`Seeded ${workspace}`);
