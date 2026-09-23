// Captures the documentation screenshots against the seeded demo workspace.
import { test as base } from '@jupyterlab/galata';
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
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
  // The default fixture creates a per-test scratch directory in the server
  // root, which would show up in the file browser and the changes list.
  tmpPath: async ({}, use) => {
    await use('');
  }
});

test.use({
  autoGoto: false,
  // Layered on top of xtralab's shipped defaults, in memory only.
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
 * Whether a CLI resolves in a login shell, the closest match to the
 * environment the server hands to new terminals.
 */
function hasCli(command: string): boolean {
  const shell = process.env.SHELL ?? '/bin/sh';
  return (
    spawnSync(shell, ['-lc', `command -v ${command}`], { stdio: 'ignore' })
      .status === 0
  );
}

/**
 * Hide WebGL so the terminal falls back to the canvas renderer: under
 * headless capture the WebGL renderer sizes its canvas for a scale factor of
 * 1, which the page then stretches into blurry text at 2x.
 */
async function hideWebgl(page: IJupyterLabPageFixture): Promise<void> {
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
}

/**
 * Read a terminal widget's xterm buffer. JupyterLab keeps its xterm in the
 * widget's private `_term` field.
 */
function terminalText(
  page: IJupyterLabPageFixture,
  widgetId: string
): Promise<string> {
  return page.evaluate(id => {
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
  }, widgetId);
}

function pressEnter(
  page: IJupyterLabPageFixture,
  widgetId: string
): Promise<void> {
  return page.evaluate(id => {
    const widgets = Array.from(
      (window as any).jupyterapp.shell.widgets('main')
    ) as any[];
    widgets
      .find(w => w.id === id)
      ?.content?.session?.send({ type: 'stdin', content: ['\r'] });
  }, widgetId);
}

/**
 * Wait for a freshly launched agent's TUI, answering one-time first-run
 * screens (claude's folder trust, codex's onboarding) with Enter. Resolves
 * when `until` matches, or without it once the buffer has painted past the
 * shell prompt and gone quiet.
 */
async function awaitAgentReady(
  page: IJupyterLabPageFixture,
  widgetId: string,
  until?: RegExp
): Promise<void> {
  const prompts = /do you trust|press enter|enter to continue/i;
  const deadline = Date.now() + 90000;
  const answered: string[] = [];
  const initial = await terminalText(page, widgetId);
  let previous = '';
  let stable = 0;
  for (;;) {
    await page.waitForTimeout(700);
    const text = await terminalText(page, widgetId);
    const prompt = prompts.exec(text)?.[0]?.toLowerCase() ?? '';
    if (prompt && !answered.includes(prompt)) {
      answered.push(prompt);
      await pressEnter(page, widgetId);
    } else if (until) {
      if (until.test(text)) {
        return;
      }
    } else {
      stable =
        text.trim() !== '' && text !== initial && text === previous
          ? stable + 1
          : 0;
      if (stable >= 3) {
        return;
      }
    }
    previous = text;
    if (Date.now() > deadline) {
      if (!until) {
        return;
      }
      throw new Error(
        `agent terminal never became ready; buffer ends with:\n${text.slice(-400)}`
      );
    }
  }
}

/**
 * Wait until a terminal's buffer stops changing. Capped, since parts of an
 * agent's screen (a cycling input-box hint) never settle for good.
 */
async function settleTerminal(
  page: IJupyterLabPageFixture,
  widgetId: string
): Promise<void> {
  let previous = '';
  for (let stable = 0, samples = 0; stable < 2 && samples < 15; samples++) {
    await page.waitForTimeout(700);
    const text = await terminalText(page, widgetId);
    stable = text === previous ? stable + 1 : 0;
    previous = text;
  }
}

/**
 * The canvas renderer sizes its layers for a scale factor of 1 when a
 * terminal first opens under headless capture; nudging the font size forces
 * the reflow that re-sizes them.
 */
async function refitRenderer(
  page: IJupyterLabPageFixture,
  widgetId: string
): Promise<void> {
  await page.evaluate(id => {
    const widgets = Array.from(
      (window as any).jupyterapp.shell.widgets('main')
    ) as any[];
    const term = widgets.find(w => w.id === id)?.content?._term;
    if (term) {
      term.options.fontSize = 14;
      term.options.fontSize = 13;
    }
  }, widgetId);
  await settleTerminal(page, widgetId);
}

/**
 * Shut a terminal widget's session down so it does not outlive its shot.
 */
function shutdownTerminal(
  page: IJupyterLabPageFixture,
  widgetId: string
): Promise<void> {
  return page.evaluate(async id => {
    const app = (window as any).jupyterapp;
    const widgets = Array.from(app.shell.widgets('main')) as any[];
    const name = widgets.find(w => w.id === id)?.content?.session?.name;
    if (name) {
      await app.serviceManager.terminals.shutdown(name);
    }
  }, widgetId);
}

async function ready(page: IJupyterLabPageFixture): Promise<void> {
  await page.goto();
  await page.waitForSelector('body[data-jp-theme-name="Pierre Dark"]', {
    state: 'attached'
  });
  // Hiding the default file browser can leave the sidebar stack without a
  // current widget.
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.activateById('xtralab:file-browser');
  });
  // Tree rows live in @pierre/trees' shadow DOM, so wait on the host.
  await page
    .locator('[id="xtralab:file-browser"] file-tree-container')
    .waitFor({ timeout: 15000 });
  // Wide enough for the whole sidebar tab strip.
  await page.sidebar.setWidth(320);
  await page.evaluate(() => document.fonts.ready);
}

async function shot(
  page: IJupyterLabPageFixture,
  name: string,
  options: { clip?: { x: number; y: number; width: number; height: number } } = {}
): Promise<void> {
  // A short settle keeps icon fonts, git badges, and focus rings stable.
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(OUTPUT, name),
    animations: 'disabled',
    ...options
  });
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Capture the smallest box that holds every given element, plus padding, so
 * the image shows one feature instead of the whole window.
 */
async function shotAround(
  page: IJupyterLabPageFixture,
  name: string,
  elements: (Locator | Box)[],
  padding = 16
): Promise<void> {
  await page.waitForTimeout(1000);
  const boxes: Box[] = [];
  for (const element of elements) {
    const box =
      'boundingBox' in element ? await element.boundingBox() : element;
    if (!box) {
      throw new Error(`${name}: an element to capture is not visible`);
    }
    boxes.push(box);
  }
  const viewport = page.viewportSize()!;
  const left = Math.max(0, Math.min(...boxes.map(b => b.x)) - padding);
  const top = Math.max(0, Math.min(...boxes.map(b => b.y)) - padding);
  const right = Math.min(
    viewport.width,
    Math.max(...boxes.map(b => b.x + b.width)) + padding
  );
  const bottom = Math.min(
    viewport.height,
    Math.max(...boxes.map(b => b.y + b.height)) + padding
  );
  await page.screenshot({
    path: path.join(OUTPUT, name),
    animations: 'disabled',
    clip: { x: left, y: top, width: right - left, height: bottom - top }
  });
}

/**
 * Collapse the left sidebar. Galata's sidebar helper goes through the View
 * menu, which xtralab hides behind the menu button.
 */
function collapseLeft(page: IJupyterLabPageFixture): Promise<void> {
  return page.evaluate(() => {
    (window as any).jupyterapp.shell.collapseLeft();
  });
}

async function launcherReady(page: IJupyterLabPageFixture): Promise<void> {
  await page.locator('.jp-xtralab-Launcher-body').waitFor();
  // The changes list waits on git status, the agent row on the probes.
  await page
    .locator('.jp-xtralab-Launcher-change', { hasText: 'metrics.py' })
    .waitFor({ timeout: 15000 });
  await page
    .locator('button', { hasText: 'Claude' })
    .first()
    .waitFor({ timeout: 15000 });
}

/**
 * Open a file in the editor and wait for its collaborative document, which
 * streams in after the editor mounts.
 */
async function openEditor(
  page: IJupyterLabPageFixture,
  filePath: string,
  minLines: number
): Promise<void> {
  await page.evaluate(async p => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: p
    });
  }, filePath);
  await page.locator('.jp-FileEditor .cm-content').waitFor();
  await page.waitForFunction(n => {
    const widget = (window as any).jupyterapp.shell.currentWidget;
    return (widget?.content?.editor?.lineCount ?? 0) > n;
  }, minLines);
}

/**
 * Select a line range in the current editor and open the ask-agent popup.
 */
async function askAbout(
  page: IJupyterLabPageFixture,
  from: number,
  to: number,
  instruction: string
): Promise<Locator> {
  await page.evaluate(
    ([start, end]) => {
      const editor = (window as any).jupyterapp.shell.currentWidget.content
        .editor;
      editor.setSelection({
        start: { line: start, column: 0 },
        end: { line: end, column: editor.getLine(end).length }
      });
    },
    [from, to]
  );
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('xtralab:ask-agent');
  });
  const popup = page.locator('.jp-xtralab-AskAgent-popup');
  await popup.waitFor();
  await popup
    .locator('.jp-xtralab-AskAgent-input')
    .pressSequentially(instruction, { delay: 20 });
  return popup;
}

test('launcher', async ({ page }) => {
  await ready(page);
  await launcherReady(page);
  await shotAround(
    page,
    'launcher.png',
    [page.locator('.jp-xtralab-Launcher-body')],
    0
  );
});

test('launcher mcp', async ({ page }) => {
  await ready(page);
  await launcherReady(page);
  const section = page.locator('.jp-xtralab-Launcher-mcp-section');
  await section.locator('summary').click();
  await section.locator('.jp-xtralab-Launcher-mcp-item').first().waitFor();
  await shotAround(page, 'launcher-mcp.png', [section]);
});

test('git diff', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 530 });
  await ready(page);
  await launcherReady(page);
  await collapseLeft(page);
  await page
    .locator('.jp-xtralab-Launcher-change', { hasText: 'src/acme/metrics.py' })
    .click();
  await page.locator('.jp-git-diff-root').waitFor();
  // Give the diff worker time to tokenize both sides.
  await page.waitForTimeout(2000);
  await shotAround(page, 'diff.png', [page.locator('#jp-main-dock-panel')], 0);
});

test('notebook diff', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 935 });
  await ready(page);
  await launcherReady(page);
  await collapseLeft(page);
  await page
    .locator('.jp-xtralab-Launcher-change', {
      hasText: 'notebooks/exploration.ipynb'
    })
    .click();
  await page.locator('.jp-git-diff-root').waitFor();
  await page.waitForTimeout(2000);
  await shotAround(
    page,
    'notebook-diff.png',
    [page.locator('#jp-main-dock-panel')],
    0
  );
});

test('omnibox', async ({ page }) => {
  await ready(page);
  // The omnibox lists agents too, so wait for the probes to resolve.
  await launcherReady(page);
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('xtralab:omnibox:open');
  });
  const input = page.locator('.jp-xtralab-Omnibox-input');
  await input.waitFor();
  // A hovered row takes the active highlight from the first result.
  await page.mouse.move(0, 0);
  await input.pressSequentially('notebook', { delay: 50 });
  // File results stream in after the agent rows; wait for both sections.
  await page
    .locator('.jp-xtralab-Omnibox-item', { hasText: 'exploration.ipynb' })
    .waitFor({ timeout: 15000 });
  await shotAround(
    page,
    'omnibox.png',
    [page.locator('.jp-xtralab-Omnibox-panel')],
    0
  );
});

test('ask agent', async ({ page }) => {
  await ready(page);
  await launcherReady(page);
  await collapseLeft(page);
  await openEditor(page, 'src/acme/metrics.py', 25);
  // The average_order_value function.
  const popup = await askAbout(
    page,
    18,
    22,
    'Round the result to two decimals'
  );
  const gutter = (await page
    .locator('.jp-FileEditor .cm-gutters')
    .boundingBox())!;
  const lineBoxes = await page
    .locator('.jp-FileEditor .cm-line')
    .evaluateAll(nodes =>
      nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      })
    );
  const popupBox = (await popup.boundingBox())!;
  const popupBottom = popupBox.y + popupBox.height;
  const top = lineBoxes[16].top;
  const bottom =
    lineBoxes.find(line => line.bottom >= popupBottom + 6)?.bottom ??
    popupBottom + 8;
  await shotAround(
    page,
    'ask-agent.png',
    [
      {
        x: gutter.x,
        y: top,
        width: popupBox.x + popupBox.width + 16 - gutter.x,
        height: bottom - top
      }
    ],
    0
  );
});

test('prompt queue', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await ready(page);
  await launcherReady(page);
  await openEditor(page, 'src/acme/metrics.py', 25);
  let popup = await askAbout(page, 18, 22, 'Round the result to two decimals');
  await popup.locator('.jp-xtralab-AskAgent-input').press('Control+Enter');
  await popup.waitFor({ state: 'detached' });
  popup = await askAbout(page, 25, 30, 'Raise ValueError on empty input');
  await popup.locator('.jp-xtralab-AskAgent-input').press('Control+Enter');
  await popup.waitFor({ state: 'detached' });
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute(
      'xtralab:ask-agent-queue'
    );
  });
  const queue = page.locator('.jp-xtralab-AskAgentQueue');
  await queue.waitFor();
  await page.sidebar.setWidth(400, 'right');
  await shotAround(page, 'prompt-queue.png', [queue], 0);
});

test('main menu', async ({ page }) => {
  await ready(page);
  await launcherReady(page);
  await collapseLeft(page);
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute(
      'xtralab:open-main-menu'
    );
  });
  const menu = page.locator('.jp-xtralab-MainMenuPopup');
  await menu.waitFor();
  await shotAround(
    page,
    'main-menu.png',
    [page.locator('.jp-xtralab-TopBarButton').first(), menu],
    8
  );
});

// The terminals-panel capture: live coding agents side by side. Runs late so
// the sessions cannot bleed into the feature captures.
test('terminals', async ({ page }) => {
  const agents = [
    { id: 'codex', cli: 'codex' },
    { id: 'claude', cli: 'claude' },
    { id: 'copilot', cli: 'copilot' }
  ];
  test.skip(
    !agents.every(agent => hasCli(agent.cli)),
    'the terminals capture needs the codex, claude, and copilot CLIs'
  );
  test.setTimeout(300000);

  await page.setViewportSize({ width: 960, height: 1160 });
  await hideWebgl(page);
  await ready(page);
  // Room for the activity lines under each row.
  await page.sidebar.setWidth(420);
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.activateById('xtralab-running-terminals');
  });

  const widgetIds: string[] = [];
  for (const agent of agents) {
    const widgetId: string = await page.evaluate(async agentId => {
      const app = (window as any).jupyterapp;
      const term = await app.commands.execute(`xtralab:start-agent:${agentId}`);
      return term.id;
    }, agent.id);
    widgetIds.push(widgetId);
    await awaitAgentReady(page, widgetId);
  }

  // Every session listed, with activity lines under most rows: an idle
  // agent whose buffer is all chrome legitimately has none.
  await expect(page.locator('.jp-xtralab-Terminals-item')).toHaveCount(
    agents.length,
    { timeout: 15000 }
  );
  await expect
    .poll(
      () => page.locator('.jp-xtralab-Terminals-item-detail').count(),
      { timeout: 20000 }
    )
    .toBeGreaterThanOrEqual(agents.length - 1);

  const claudeId = widgetIds[1];
  await page.evaluate(id => {
    (window as any).jupyterapp.shell.activateById(id);
  }, claudeId);
  await awaitAgentReady(
    page,
    claudeId,
    /Claude Code v[\d.]+[\s\S]*❯[\s\S]*(for shortcuts|for agents|mode on)/
  );
  await refitRenderer(page, claudeId);

  const panel = (await page
    .locator('[id="xtralab-running-terminals"]')
    .boundingBox())!;
  const lastRow = (await page
    .locator('.jp-xtralab-Terminals-item')
    .last()
    .boundingBox())!;
  await shotAround(
    page,
    'terminals.png',
    [
      {
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: lastRow.y + lastRow.height + 12 - panel.y
      }
    ],
    0
  );

  for (const widgetId of widgetIds) {
    await shutdownTerminal(page, widgetId);
  }
});

// The landing-page capture: launcher, git diff, and a live Claude Code
// session. Kept last so the session cannot bleed into the other captures.
test('hero', async ({ page }) => {
  test.skip(!hasCli('claude'), 'the hero capture needs the claude CLI');
  // Claude Code's startup is the slow part of this capture.
  test.setTimeout(180000);

  // Three panes plus the sidebar, tall enough for the full launcher above a
  // readable terminal.
  await page.setViewportSize({ width: 2000, height: 1160 });
  await hideWebgl(page);
  await ready(page);

  await page.locator('.jp-xtralab-Launcher-body').waitFor();
  await page
    .locator('button', { hasText: 'Claude' })
    .first()
    .waitFor({ timeout: 15000 });
  await page
    .locator('.jp-xtralab-Launcher-change', { hasText: 'src/acme/metrics.py' })
    .waitFor({ timeout: 15000 });

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

  // A placeholder shapes the bottom pane first so the agent opens into its
  // final geometry: claude paints its welcome once, and a resize garbles it.
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
  // Let the placeholder's xterm fit the pane before the agent tabs in.
  await page.waitForTimeout(1000);

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

  // The regex spans Claude's full welcome screen: version banner, `❯` input
  // box, and hint footer.
  await awaitAgentReady(
    page,
    termId,
    /Claude Code v[\d.]+[\s\S]*❯[\s\S]*(for shortcuts|for agents|mode on)/
  );
  await settleTerminal(page, termId);
  await refitRenderer(page, termId);

  await shot(page, 'hero.png');

  await shutdownTerminal(page, termId);
});
