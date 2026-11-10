const { expect, test } = require('@playwright/test');

test('xtralite loads the xtralab launcher with the lite agents', async ({
  page
}) => {
  await page.goto('lab/index.html');

  const launcher = page.locator('.jp-xtralab-Launcher');
  await expect(launcher).toBeVisible({ timeout: 60_000 });

  const agents = launcher.locator('.jp-xtralab-Launcher-agent-label');
  await expect(agents.filter({ hasText: /^Pi$/ })).toBeVisible();
  await expect(agents.filter({ hasText: 'Pi chat' })).toBeVisible();
  await expect(agents.filter({ hasText: 'Jupyternaut chat' })).toBeVisible();
  await expect(agents.filter({ hasText: 'Claude' })).toHaveCount(0);

  await expect(page.locator('.jp-xtralab-FileBrowserPanel')).toBeVisible();
  await expect(page.locator('#jp-MainLogo')).toHaveCount(0);
});

/**
 * Close the dialog in which pi asks for a model provider: the test site has
 * none, so a message to pi opens it.
 */
async function closeProviderDialog(page) {
  const dialog = page.locator('dialog.jp-Dialog');
  if (await dialog.count()) {
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
}

/**
 * Select the first two lines of a file and open the ask-agent prompt box.
 */
async function askAboutSelection(page) {
  await page.evaluate(async () => {
    await window.jupyterapp.commands.execute('docmanager:open', {
      path: 'src/acme/metrics.py'
    });
  });
  const editor = page.locator('.jp-FileEditor .cm-content').first();
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+.');
  await expect(page.locator('.jp-xtralab-AskAgent-popup')).toBeVisible();
}

test('the ask-agent prompt box sends to open chats', async ({ page }) => {
  // Expose `window.jupyterapp`, as Galata does.
  await page.route('**/jupyter-lite.json', async route => {
    const response = await route.fetch();
    const json = await response.json();
    json['jupyter-config-data'] = {
      ...(json['jupyter-config-data'] ?? {}),
      exposeAppInBrowser: true
    };
    await route.fulfill({ response, json });
  });
  await page.goto('lab/index.html');
  const launcher = page.locator('.jp-xtralab-Launcher');
  await expect(launcher).toBeVisible({ timeout: 60_000 });

  // Start a chat with Pi from the launcher.
  await launcher.locator('textarea').fill('Hello Pi');
  await launcher
    .locator('.jp-xtralab-Launcher-agent-label', { hasText: 'Pi chat' })
    .click();
  await expect(
    page.locator('.lm-TabBar-tab', { hasText: '.chat' })
  ).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  await closeProviderDialog(page);

  // The open chat is a target of the prompt box.
  await askAboutSelection(page);
  const targets = page.locator('.jp-xtralab-AskAgent-targetButton');
  const chatTarget = targets.filter({ hasText: 'Pi chat' });
  await expect(chatTarget).toHaveCount(1);
  await expect(targets.filter({ hasText: 'Jupyternaut' })).toHaveCount(0);
  await chatTarget.click();
  await page
    .locator('.jp-xtralab-AskAgent-input')
    .fill('Round the result to two decimals');
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.Toastify__toast', { hasText: 'Prompt sent to Pi chat' })
  ).toBeVisible();
  const sent = await page.evaluate(() =>
    [...window.jupyterapp.shell.widgets('main')]
      .filter(widget => widget.model?.name?.endsWith('.chat'))
      .flatMap(widget => widget.model.messages)
      .some(
        message =>
          message.body.includes('Round the result to two decimals') &&
          message.metadata?.to_persona === 'pi-frontend'
      )
  );
  expect(sent).toBe(true);
  await closeProviderDialog(page);
});
