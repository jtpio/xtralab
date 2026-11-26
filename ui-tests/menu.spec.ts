// Tests of the main menu with touch input.
import { expect, test } from '@jupyterlab/galata';
import type { Locator, Page } from '@playwright/test';

const BUTTON = '#xtralab-main-menu-button';
const POPUP = '.jp-xtralab-MainMenuPopup';
const VIEW = '#jp-mainmenu-view';
const APPEARANCE = '#jp-mainmenu-view-appearance';

// A tap sends no pointer move, unlike a mouse click.
test.use({ hasTouch: true });

/**
 * Find the item of a menu from its label.
 */
function item(page: Page, menu: string, label: string): Locator {
  return page.locator(`${menu} > ul > .lm-Menu-item`).filter({
    has: page.locator('.lm-Menu-itemLabel', {
      hasText: new RegExp(`^${label}$`)
    })
  });
}

test('taps open the submenus and run a command', async ({ page }) => {
  await page.locator(BUTTON).tap();
  await item(page, POPUP, 'View').tap();
  await item(page, VIEW, 'Appearance').tap();
  await item(page, APPEARANCE, 'Show Menu Bar').tap();
  await expect(page.locator('#jp-MainMenu')).toBeVisible();
  await expect(page.locator('.lm-Menu')).toHaveCount(0);

  // The same command, from the menu bar.
  await page.locator('#jp-MainMenu .lm-MenuBar-item', { hasText: 'View' }).tap();
  await item(page, VIEW, 'Appearance').tap();
  await item(page, APPEARANCE, 'Show Menu Bar').tap();
  await expect(page.locator(BUTTON)).toBeVisible();
  await expect(page.locator('#jp-MainMenu')).toBeHidden();
});

test('a tap on the menu button closes its menu', async ({ page }) => {
  const popup = page.locator(POPUP);
  await page.locator(BUTTON).tap();
  await expect(popup).toBeVisible();
  await page.locator(BUTTON).tap();
  await expect(popup).toHaveCount(0);
  await page.locator(BUTTON).tap();
  await expect(popup).toBeVisible();
});
