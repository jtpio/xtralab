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
});
