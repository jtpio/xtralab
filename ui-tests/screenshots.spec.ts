// Captures the documentation screenshots against the seeded demo workspace.
// Run with `pnpm screenshots`; images land in docs/src/assets/screenshots/.
import { test as base } from '@jupyterlab/galata';
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUTPUT = path.resolve(
  __dirname,
  '..',
  'docs',
  'src',
  'assets',
  'screenshots'
);

const test = base.extend({
  // Keep the server root exactly as seeded: the default fixture creates a
  // per-test scratch directory in it, which would show up in the file
  // browser and as an untracked entry in the git changes list.
  tmpPath: async ({}, use) => {
    await use('');
  }
});

test.use({
  autoGoto: false,
  // Loaded settings still come from the server (so xtralab's shipped
  // defaults apply); these overrides are layered on top, in memory only.
  // The sidebar tabs are trimmed to the ones the screenshots are about.
  mockSettings: {
    '@jupyterlab/apputils-extension:themes': { theme: 'Pierre Dark' },
    'xtralab:sidebar': {
      showDefaultFileBrowser: false,
      showRunningSessions: false
    }
  }
});

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT, { recursive: true });
});

async function ready(page: IJupyterLabPageFixture): Promise<void> {
  await page.goto();
  await page.waitForSelector('body[data-jp-theme-name="Pierre Dark"]', {
    state: 'attached'
  });
  // Hiding the default file browser can leave the sidebar stack without a
  // current widget, so bring up the xtralab file tree explicitly.
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.activateById('xtralab:file-browser');
  });
  // The tree rows render inside @pierre/trees' shadow DOM, so wait for the
  // visible host instead of row text.
  await page
    .locator('[id="xtralab:file-browser"] file-tree-container')
    .waitFor({ timeout: 15000 });
  // Wide enough for the whole sidebar tab strip.
  await page.sidebar.setWidth(320);
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page: IJupyterLabPageFixture, name: string): Promise<void> {
  // A short settle keeps icon fonts, git badges, and focus rings stable.
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(OUTPUT, name),
    animations: 'disabled'
  });
}

test('launcher', async ({ page }) => {
  await ready(page);
  await page.locator('.jp-xtralab-Launcher-body').waitFor();
  // The changes list fills in once git status resolves, and the agent row
  // once the availability probes come back.
  await page
    .locator('.jp-xtralab-Launcher-change', { hasText: 'metrics.py' })
    .waitFor({ timeout: 15000 });
  await page
    .locator('button', { hasText: 'Claude' })
    .first()
    .waitFor({ timeout: 15000 });
  await shot(page, 'launcher.png');
});

test('git diff', async ({ page }) => {
  await ready(page);
  // Pair the git panel on the left with the diff in the main area.
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.activateById('jp-git-sessions');
  });
  await page
    .locator('[id="jp-git-sessions"]')
    .getByText('metrics.py')
    .first()
    .waitFor({ timeout: 15000 });
  await page
    .locator('.jp-xtralab-Launcher-change', { hasText: 'src/acme/metrics.py' })
    .click();
  await page.locator('.jp-git-diff-root').waitFor();
  // Give the diff worker time to tokenize both sides.
  await page.waitForTimeout(2000);
  await shot(page, 'diff.png');
});

test('omnibox', async ({ page }) => {
  await ready(page);
  // The agent rows come from the availability probes; wait for them (the
  // launcher buttons appear once they resolve) before opening the omnibox.
  await page
    .locator('button', { hasText: 'Claude' })
    .first()
    .waitFor({ timeout: 15000 });
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('xtralab:omnibox:open');
  });
  const input = page.locator('.jp-xtralab-Omnibox-input');
  await input.waitFor();
  await input.pressSequentially('metrics', { delay: 50 });
  // File results stream in after the agent rows; wait for both sections.
  await page
    .locator('.jp-xtralab-Omnibox-item', { hasText: 'metrics.py' })
    .waitFor({ timeout: 15000 });
  await shot(page, 'omnibox.png');
});

test('ask agent', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: 'src/acme/metrics.py'
    });
  });
  await page.locator('.jp-FileEditor .cm-content').waitFor();
  // The collaborative document streams in after the editor mounts; wait for
  // the full file before addressing lines in it.
  await page.waitForFunction(() => {
    const widget = (window as any).jupyterapp.shell.currentWidget;
    return (widget?.content?.editor?.lineCount ?? 0) > 25;
  });
  // Select the average_order_value function, then ask about it.
  await page.evaluate(() => {
    const widget = (window as any).jupyterapp.shell.currentWidget;
    widget.content.editor.setSelection({
      start: { line: 18, column: 0 },
      end: { line: 22, column: 43 }
    });
  });
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('xtralab:ask-agent');
  });
  const popup = page.locator('.jp-xtralab-AskAgent-popup');
  await popup.waitFor();
  await popup
    .locator('.jp-xtralab-AskAgent-input')
    .pressSequentially('Round the result to two decimals', { delay: 30 });
  await shot(page, 'ask-agent.png');
});
