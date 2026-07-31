// Captures the documentation screenshots against the seeded demo workspace.
// Run with `pnpm screenshots`; images land in docs/src/assets/screenshots/.
import { test as base } from '@jupyterlab/galata';
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
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

/**
 * Whether the `claude` CLI resolves in a login shell — the closest match to
 * the environment the server hands to new terminals. The hero capture runs a
 * real Claude Code session, so it is skipped on machines without the CLI.
 */
function hasClaudeCli(): boolean {
  const shell = process.env.SHELL ?? '/bin/sh';
  return (
    spawnSync(shell, ['-lc', 'command -v claude'], { stdio: 'ignore' })
      .status === 0
  );
}

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

// The landing-page capture: launcher, git diff, and a live Claude Code
// session in one workspace. Kept last so the agent session can never bleed
// into the other captures, and skipped when the CLI is not installed.
test('hero', async ({ page }) => {
  test.skip(!hasClaudeCli(), 'the hero capture needs the claude CLI');
  // Claude Code's startup is the slow part of this capture.
  test.setTimeout(180000);

  // A larger canvas than the feature shots: the hero packs three panes plus
  // the sidebar, and the landing page shows it big. Tall enough for the full
  // launcher (through the changes list) above a readable terminal.
  await page.setViewportSize({ width: 2000, height: 1160 });
  // Headless WebGL renders the terminal into a canvas sized for a scale
  // factor of 1, which the page then stretches — blurry text at our 2x
  // capture. Hide WebGL so the terminal falls back to the canvas renderer.
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function (
      type: string,
      ...args: any[]
    ) {
      if (type === 'webgl' || type === 'experimental-webgl') {
        return null;
      }
      return (getContext as any).call(this, type, ...args);
    };
  });
  await ready(page);

  // Launcher fully populated: agent buttons and the changes list.
  await page.locator('.jp-xtralab-Launcher-body').waitFor();
  await page
    .locator('button', { hasText: 'Claude' })
    .first()
    .waitFor({ timeout: 15000 });
  await page
    .locator('.jp-xtralab-Launcher-change', { hasText: 'src/acme/metrics.py' })
    .waitFor({ timeout: 15000 });

  // Open the metrics.py diff, then dock it to the right of the launcher.
  await page
    .locator('.jp-xtralab-Launcher-change', { hasText: 'src/acme/metrics.py' })
    .click();
  await page.locator('.jp-git-diff-root').waitFor();
  await page.evaluate(() => {
    const shell = (window as any).jupyterapp.shell;
    const widgets = Array.from(shell.widgets('main')) as any[];
    const launcher = widgets.find(w => w.title.label === 'Launcher');
    const diff = widgets.find(w => w.title.label.startsWith('metrics.py'));
    shell._dockPanel.addWidget(diff, { mode: 'split-right', ref: launcher });
  });

  // Carve out a bottom pane spanning the full width and weight the split
  // like a real session. A placeholder terminal shapes the pane first so the
  // Claude Code session opens straight into its final geometry — claude
  // paints its welcome screen once and a later resize would garble it.
  const placeholderId: string = await page.evaluate(async () => {
    const app = (window as any).jupyterapp;
    const placeholder = await app.commands.execute('terminal:create-new');
    const dock = app.shell._dockPanel;
    dock.addWidget(placeholder, { mode: 'split-bottom' });
    const layout = dock.saveLayout();
    if (layout.main?.type === 'split-area') {
      layout.main.sizes = [0.62, 0.38];
    }
    dock.restoreLayout(layout);
    dock.activateWidget(placeholder);
    return placeholder.id;
  });
  // Let the split settle and the placeholder's xterm fit the pane, so the
  // agent terminal tabs in next to it with trustworthy dimensions.
  await page.waitForTimeout(1000);

  // Start Claude through the launcher's own command — the terminal opens as
  // a tab beside the placeholder — then retire the placeholder.
  const termId: string = await page.evaluate(async id => {
    const app = (window as any).jupyterapp;
    const term = await app.commands.execute('xtralab:start-agent:claude');
    const widgets = Array.from(app.shell.widgets('main')) as any[];
    const placeholder = widgets.find(w => w.id === id);
    const name = placeholder?.content?.session?.name;
    placeholder?.dispose();
    if (name) {
      await app.serviceManager.terminals.shutdown(name);
    }
    app.shell._dockPanel.activateWidget(term);
    return term.id;
  }, placeholderId);

  const terminalText = (): Promise<string> =>
    page.evaluate(id => {
      const widgets = Array.from(
        (window as any).jupyterapp.shell.widgets('main')
      ) as any[];
      const buffer = widgets.find(w => w.id === id)?.content?._term?.buffer
        ?.active;
      if (!buffer) {
        return '';
      }
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    }, termId);

  // Wait for Claude's full welcome screen: the version banner, the `❯`
  // input box, and the hint footer, drawn in that order. On a machine that
  // has never run claude in the seeded workspace, a one-time folder-trust
  // prompt comes first — accept its default.
  let trusted = false;
  await expect
    .poll(
      async () => {
        const text = await terminalText();
        if (!trusted && /do you trust the files/i.test(text)) {
          trusted = true;
          await page.evaluate(id => {
            const widgets = Array.from(
              (window as any).jupyterapp.shell.widgets('main')
            ) as any[];
            widgets
              .find(w => w.id === id)
              ?.content?.session?.send({ type: 'stdin', content: ['\r'] });
          }, termId);
          return '';
        }
        return text;
      },
      { timeout: 120000 }
    )
    .toMatch(/Claude Code v[\d.]+[\s\S]*❯[\s\S]*(for shortcuts|for agents|mode on)/);

  const settle = async (): Promise<void> => {
    // Let the welcome screen settle: claude repaints a few times right
    // after the footer appears. Capped, since parts of the screen (the
    // input-box placeholder hint) keep cycling forever.
    let previous = '';
    for (let stable = 0, samples = 0; stable < 2 && samples < 15; samples++) {
      await page.waitForTimeout(700);
      const text = await terminalText();
      stable = text === previous ? stable + 1 : 0;
      previous = text;
    }
  };
  await settle();

  // The canvas renderer sizes its layers for a scale factor of 1 when the
  // terminal first opens under headless capture, drawing 2x glyphs off the
  // bottom of the backing store. It re-sizes them correctly on the next
  // real reflow, so nudge the font size to force one, then let claude
  // repaint at the final dimensions.
  await page.evaluate(id => {
    const widgets = Array.from(
      (window as any).jupyterapp.shell.widgets('main')
    ) as any[];
    const term = widgets.find(w => w.id === id)?.content?._term;
    if (term) {
      term.options.fontSize = 14;
      term.options.fontSize = 13;
    }
  }, termId);
  await settle();

  await shot(page, 'hero.png');

  // Shut the agent session down so it does not outlive the capture.
  await page.evaluate(async id => {
    const app = (window as any).jupyterapp;
    const widgets = Array.from(app.shell.widgets('main')) as any[];
    const name = widgets.find(w => w.id === id)?.content?.session?.name;
    if (name) {
      await app.serviceManager.terminals.shutdown(name);
    }
  }, termId);
});
