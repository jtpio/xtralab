// Exercises working-tree diff editing against the suite's disposable Git fixture.
import { test as baseTest, expect } from '@jupyterlab/galata';
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';

const METRICS = 'src/acme/metrics.py';
const fixture = (kind: string, file: string) =>
  readFileSync(path.join(__dirname, 'fixtures', kind, file), 'utf8');
const base = fixture('demo-project', METRICS);
const baseline = fixture('baseline', METRICS);
const readme = fixture('demo-project', 'README.md');
const test = baseTest.extend({
  tmpPath: async ({}, use) => {
    await use('');
  }
});
test.use({
  autoGoto: false,
  mockSettings: {
    '@jupyterlab/apputils-extension:themes': { theme: 'Pierre Light' }
  }
});
const editor = (page: IJupyterLabPageFixture) =>
  page
    .locator(
      '.jp-xtralab-DiffWidget-editRegion [contenteditable="true"]:visible'
    )
    .first();
function contentsURL(page: IJupyterLabPageFixture, file: string): string {
  return new URL(`/api/contents/${file}`, page.url()).toString();
}
async function read(
  page: IJupyterLabPageFixture,
  file = METRICS
): Promise<string> {
  const response = await page.request.get(contentsURL(page, file), {
    params: { content: 1, type: 'file', format: 'text' }
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).content;
}
async function write(
  page: IJupyterLabPageFixture,
  text: string,
  file = METRICS
): Promise<void> {
  const xsrf = (await page.context().cookies()).find(
    cookie => cookie.name === '_xsrf'
  )?.value;
  const response = await page.request.put(contentsURL(page, file), {
    headers: xsrf ? { 'X-XSRFToken': xsrf } : {},
    data: { type: 'file', format: 'text', content: text }
  });
  expect(response.ok()).toBe(true);
}
async function git(
  page: IJupyterLabPageFixture,
  action: 'add' | 'reset'
): Promise<void> {
  const xsrf = (await page.context().cookies()).find(
    cookie => cookie.name === '_xsrf'
  )?.value;
  const response = await page.request.post(
    new URL(`/git/${action}`, page.url()).toString(),
    {
      headers: xsrf ? { 'X-XSRFToken': xsrf } : {},
      data: { filename: METRICS, add_all: false, reset_all: false }
    }
  );
  expect(response.ok()).toBe(true);
}
async function indexedFixture(
  page: IJupyterLabPageFixture,
  reference: string,
  working: string
): Promise<void> {
  await write(page, reference);
  await git(page, 'add');
  await write(page, working);
}
async function diskEquals(
  page: IJupyterLabPageFixture,
  text: string,
  file = METRICS
): Promise<void> {
  await expect.poll(() => read(page, file), { timeout: 12000 }).toBe(text);
}
async function open(
  page: IJupyterLabPageFixture,
  file = METRICS,
  pin = false
): Promise<void> {
  await page.evaluate(
    async ({ file, pin }) => {
      await (window as any).jupyterapp.commands.execute(
        'xtralab:git:open-diff',
        {
          repoPath: '',
          change: { path: file, group: 'unstaged', status: 'modified' },
          pin
        }
      );
    },
    { file, pin }
  );
  await expect(editor(page)).toBeVisible({ timeout: 20000 });
}
async function append(
  page: IJupyterLabPageFixture,
  text: string
): Promise<void> {
  await editor(page).focus();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
  );
  // The editor's document-end caret precedes the terminal newline.
  await page.keyboard.insertText('\n' + text.slice(0, -1));
}
async function replace(
  page: IJupyterLabPageFixture,
  text: string
): Promise<void> {
  await editor(page).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}
async function closeCurrent(page: IJupyterLabPageFixture): Promise<void> {
  await page.evaluate(() =>
    (window as any).jupyterapp.shell.currentWidget.close()
  );
}
async function theme(
  page: IJupyterLabPageFixture,
  name: string
): Promise<void> {
  await page.evaluate(async name => {
    await (window as any).jupyterapp.commands.execute('apputils:change-theme', {
      theme: name
    });
  }, name);
  await expect(page.locator('body')).toHaveAttribute(
    'data-jp-theme-name',
    name
  );
  await expect(page.locator('.jp-Spinner:visible')).toHaveCount(0, {
    timeout: 15000
  });
  await expect(editor(page)).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.goto();
  await page.waitForFunction(() =>
    (window as any).jupyterapp?.commands?.hasCommand('xtralab:git:open-diff')
  );
  await page.evaluate(() => (window as any).jupyterapp.restored);
  await git(page, 'reset');
  await write(page, base);
  await write(page, readme, 'README.md');
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    for (const widget of (window as any).jupyterapp.shell.widgets('main')) {
      if (widget.content?.model?.filename) widget.close();
    }
  });
  // All successful cases settle saves before teardown. Restore fixture edits
  // so screenshot tests start with the same tracked project contents.
  await git(page, 'reset');
  await write(page, base);
  await write(page, readme, 'README.md');
});
// Automatically release intercepted network requests before a test can time
// out, including failures that happen before its explicit cleanup runs.
function saveGate(): { gate: Promise<void>; release: () => void } {
  let resolve!: () => void;
  const gate = new Promise<void>(done => {
    resolve = done;
  });
  const timer = setTimeout(() => resolve(), 15000);
  return {
    gate,
    release: () => {
      clearTimeout(timer);
      resolve();
    }
  };
}
const scenarios: Array<
  [string, (page: IJupyterLabPageFixture) => Promise<void>]
> = [
  [
    'conflict-overwrite-after-undo-to-saved',
    async page => {
      await open(page);
      await append(page, '\n# undo before overwrite\n');
      await write(page, base + '\n# conflicting external\n');
      await expect(
        page.getByRole('button', { name: 'Overwrite', exact: true })
      ).toBeVisible();
      await editor(page).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await page
        .getByRole('button', { name: 'Overwrite', exact: true })
        .click();
      await diskEquals(page, base);
    }
  ],
  [
    'external-refresh-then-undo-to-clean',
    async page => {
      await open(page);
      await append(page, '\n# undo refreshed draft\n');
      const external = base + '\n# authoritative external\n';
      await write(page, external);
      await page.evaluate(() =>
        (window as any).jupyterapp.shell.currentWidget.content.refresh()
      );
      await expect(
        page.getByRole('button', { name: 'Discard my edits', exact: true })
      ).toBeVisible();
      await editor(page).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await expect(editor(page)).toContainText('authoritative external');
      await expect(
        page.getByRole('button', { name: 'Discard my edits', exact: true })
      ).toHaveCount(0);
      await diskEquals(page, external);
      await append(page, '\n# editing after reconciliation\n');
      await diskEquals(page, external + '\n# editing after reconciliation\n');
    }
  ],
  [
    'shrinking-block-discard-first-click',
    async page => {
      const reference = 'alpha\nbravo\ncharlie\n';
      const working = 'ALPHA\nBRAVO\ncharlie\n';
      const partial = 'alpha\nBRAVO\ncharlie\n';
      await indexedFixture(page, reference, working);
      await open(page);
      await replace(page, partial);
      await page
        .getByRole('button', { name: 'Discard change', exact: true })
        .first()
        .click();
      await diskEquals(page, reference);
      await editor(page).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await diskEquals(page, partial);
    }
  ],
  [
    'layout-theme-while-dirty',
    async page => {
      await open(page);
      const host = await editor(page).evaluateHandle(
        el => (el.getRootNode() as ShadowRoot).host
      );
      const { gate, release } = saveGate();
      await page.route('**/api/contents/src/acme/metrics.py*', async route => {
        if (route.request().method() === 'PUT') await gate;
        await route.continue();
      });
      const marker = '\n# layout-preserved draft\n';
      await append(page, marker);
      try {
        await page
          .getByRole('tab', { name: 'Unified view', exact: true })
          .click();
        await expect(editor(page)).toContainText('layout-preserved draft');
        await page
          .getByRole('tab', { name: 'Split view', exact: true })
          .click();
        const resize = page.getByRole('separator', {
          name: 'Resize the diff panes'
        });
        const rect = (await resize.boundingBox())!;
        await page.mouse.move(rect.x + rect.width / 2, rect.y + 50);
        await page.mouse.down();
        await page.mouse.move(rect.x + 120, rect.y + 50);
        await page.mouse.up();
        await theme(page, 'JupyterLab Dark');
        await expect(editor(page)).toContainText('layout-preserved draft');
        assert.ok(
          await editor(page).evaluate(
            (el, original) =>
              (el.getRootNode() as ShadowRoot).host === original,
            host
          ),
          'layout and theme should preserve the FileDiff host'
        );
      } finally {
        release();
      }
      await diskEquals(page, base + marker);
      await editor(page).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await diskEquals(page, base);
    }
  ],
  [
    'delayed-save-more-typing',
    async page => {
      await open(page);
      const { gate, release } = saveGate();
      const writes: string[] = [];
      await page.route('**/api/contents/src/acme/metrics.py*', async route => {
        if (route.request().method() === 'PUT') {
          writes.push(route.request().postDataJSON().content);
          if (writes.length === 1) {
            await gate;
          }
        }
        await route.continue();
      });
      const first = '\n# first pending write\n';
      const second = '\n# newer typing retained\n';
      await append(page, first);
      await page.keyboard.press('ControlOrMeta+s');
      try {
        await expect.poll(() => writes.length).toBe(1);
        await append(page, second);
        await expect(editor(page)).toContainText('newer typing retained');
      } finally {
        release();
      }
      await diskEquals(page, base + first + second);
      await expect(editor(page)).toContainText('newer typing retained');
      assert.equal(
        writes.length,
        2,
        'the save loop should drain its newer draft after the first PUT'
      );
      assert.equal(writes[0], base + first);
      assert.equal(writes[1], base + first + second);
    }
  ],
  [
    'external-refresh-while-dirty',
    async page => {
      await open(page);
      await append(page, '\n# refresh-preserved local draft\n');
      const external = base + '\n# refreshed external contents\n';
      await write(page, external);
      await page.evaluate(() =>
        (window as any).jupyterapp.shell.currentWidget.content.refresh()
      );
      await expect(editor(page)).toContainText('refresh-preserved local draft');
      await expect(editor(page)).not.toContainText(
        'refreshed external contents'
      );
      await expect(
        page.getByRole('button', { name: 'Discard my edits', exact: true })
      ).toBeVisible({ timeout: 10000 });
      assert.equal(await read(page), external);
      await page
        .getByRole('button', { name: 'Discard my edits', exact: true })
        .click();
      await expect(editor(page)).toContainText('refreshed external contents');
      await expect(editor(page)).not.toContainText(
        'refresh-preserved local draft'
      );
      assert.equal(await read(page), external);
      await append(page, '\n# editing after refreshed conflict\n');
      await diskEquals(
        page,
        external + '\n# editing after refreshed conflict\n'
      );
    }
  ],
  [
    'failed-save-retry-cmd-s',
    async page => {
      await open(page);
      let fail = true;
      await page.route('**/api/contents/src/acme/metrics.py*', async route => {
        if (fail && route.request().method() === 'PUT') {
          fail = false;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              message: 'Regression injected save failure'
            })
          });
        } else await route.continue();
      });
      const marker = '\n# failure then retry\n';
      await append(page, marker);
      await page.keyboard.press('ControlOrMeta+s');
      await expect(
        page.locator('.jp-xtralab-DiffWidget-saveStatus')
      ).toHaveAttribute('data-state', 'error');
      assert.equal(await read(page), base);
      await expect(editor(page)).toContainText('failure then retry');
      await editor(page).focus();
      await page.keyboard.press('ControlOrMeta+s');
      await diskEquals(page, base + marker);
    }
  ],
  [
    'shifted-live-hunk-discard-before-debounce',
    async page => {
      await open(page);
      const prefix = '# shifted line one\n# shifted line two\n';
      await editor(page).focus();
      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home'
      );
      const start = Date.now();
      await page.keyboard.insertText(prefix);
      await page
        .getByRole('button', { name: 'Discard change', exact: true })
        .first()
        .click();
      assert.ok(
        Date.now() - start < 500,
        'first discard click must precede autosave'
      );
      await expect
        .poll(() => read(page))
        .not.toContain('def average_order_value');
      assert.ok(
        (await read(page)).startsWith(prefix),
        'discard should retain inserted lines preceding the original block'
      );
      assert.ok(
        (await read(page)).includes('or None if empty'),
        'discard should preserve the neighboring changed block'
      );
      await editor(page).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await diskEquals(page, prefix + base);
    }
  ],
  [
    'typing-autosave-undo-redo',
    async page => {
      await open(page);
      const marker = '\n# autosave regression\n';
      await append(page, marker);
      await diskEquals(page, base + marker);
      await editor(page).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await diskEquals(page, base);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await diskEquals(page, base + marker);
    }
  ],
  [
    'cmd-s-immediate-save',
    async page => {
      await open(page);
      const marker = '\n# explicit save regression\n';
      await append(page, marker);
      const start = Date.now();
      const put = page.waitForRequest(
        req =>
          req.method() === 'PUT' &&
          req.url().includes('/api/contents/src/acme/metrics.py')
      );
      await page.keyboard.press('ControlOrMeta+s');
      await put;
      assert.ok(
        Date.now() - start < 500,
        'Cmd+S should bypass the 500ms autosave delay'
      );
      await diskEquals(page, base + marker);
    }
  ],
  [
    'discard-hunk-undo',
    async page => {
      await open(page);
      await page
        .getByRole('button', { name: 'Discard change', exact: true })
        .first()
        .click();
      await expect.poll(() => read(page)).not.toBe(base);
      await editor(page).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await diskEquals(page, base);
    }
  ],
  [
    'conflict-discard-local',
    async page => {
      await open(page);
      await append(page, '\n# local unsaved\n');
      const external = base + '\n# external retained\n';
      await write(page, external);
      await expect(
        page.getByRole('button', { name: 'Discard my edits', exact: true })
      ).toBeVisible({ timeout: 10000 });
      assert.equal(
        await read(page),
        external,
        'autosave must preserve conflicting disk text'
      );
      await page
        .getByRole('button', { name: 'Discard my edits', exact: true })
        .click();
      await expect(editor(page)).toContainText('external retained');
      assert.equal(await read(page), external);
      await append(page, '\n# after conflict\n');
      await diskEquals(page, external + '\n# after conflict\n');
    }
  ],
  [
    'conflict-overwrite',
    async page => {
      await open(page);
      const marker = '\n# local overwrite\n';
      await append(page, marker);
      await write(page, base + '\n# external overwritten\n');
      await expect(
        page.getByRole('button', { name: 'Overwrite', exact: true })
      ).toBeVisible({ timeout: 10000 });
      await page
        .getByRole('button', { name: 'Overwrite', exact: true })
        .click();
      await diskEquals(page, base + marker);
    }
  ],
  [
    'close-before-debounce',
    async page => {
      await open(page);
      const marker = '\n# close before debounce\n';
      await append(page, marker);
      await closeCurrent(page);
      await diskEquals(page, base + marker);
    }
  ],
  [
    'switch-preview-before-debounce',
    async page => {
      await open(page);
      const marker = '\n# switch before debounce\n';
      await append(page, marker);
      await open(page, 'README.md');
      await diskEquals(page, base + marker);
      assert.equal(await read(page, 'README.md'), readme);
      await open(page);
      await expect(editor(page)).toContainText('switch before debounce');
    }
  ],
  [
    'no-diff-tab-stays-editable',
    async page => {
      await open(page);
      await replace(page, baseline);
      await diskEquals(page, baseline);
      await expect(editor(page)).toBeVisible();
      await append(page, '\n# editing restored\n');
      await diskEquals(page, baseline + '\n# editing restored\n');
    }
  ],
  [
    'jupyterlab-light-dark-token-colors',
    async page => {
      await open(page);
      for (const name of ['JupyterLab Light', 'JupyterLab Dark']) {
        await theme(page, name);
        await append(page, `\n# ${name} regression\n`);
        await page.keyboard.press('ControlOrMeta+s');
        await expect.poll(() => read(page)).toContain(name + ' regression');
        const comment = editor(page)
          .locator('[data-line] span')
          .filter({ hasText: `# ${name} regression` })
          .last();
        const colors = () =>
          comment.evaluate(node => {
            const reference = document.createElement('span');
            reference.style.color = 'var(--jp-mirror-editor-comment-color)';
            reference.style.backgroundColor = 'var(--jp-layout-color1)';
            document.body.appendChild(reference);
            const expected = getComputedStyle(reference).color;
            const background = getComputedStyle(reference).backgroundColor;
            reference.remove();
            const actual = getComputedStyle(node).color;
            const luminance = (color: string) => {
              const channels = color
                .match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number)
                .map(value => {
                  const channel = value / 255;
                  return channel <= 0.04045
                    ? channel / 12.92
                    : ((channel + 0.055) / 1.055) ** 2.4;
                });
              return (
                channels[0] * 0.2126 +
                channels[1] * 0.7152 +
                channels[2] * 0.0722
              );
            };
            const light = luminance(actual);
            const dark = luminance(background);
            return {
              matches: actual === expected,
              actual,
              expected,
              contrast:
                (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
            };
          });
        await expect.poll(async () => (await colors()).matches).toBe(true);
        expect((await colors()).contrast).toBeGreaterThan(3);
        await test.info().attach(name, {
          body: await page.screenshot(),
          contentType: 'image/png'
        });
      }
    }
  ]
];
for (const [name, scenario] of scenarios) {
  test(name, async ({ page }) => {
    await scenario(page);
  });
}

for (const [name, reference, working] of [
  ['unicode-crlf', 'message = "😄"\r\n', 'message = "😀"\r\n'],
  ['crlf-only', 'a\n', 'a\r\n'],
  ['cr-only', 'a\rc\r', 'a\rb\r']
]) {
  test(`discard-and-undo-${name}`, async ({ page }) => {
    await indexedFixture(page, reference, working);
    await open(page);
    await page
      .getByRole('button', { name: 'Discard change', exact: true })
      .first()
      .click();
    await diskEquals(page, reference);
    await editor(page).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await diskEquals(page, working);
  });
}
