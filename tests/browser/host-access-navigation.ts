import { expect, type Locator, type Page } from "@playwright/test";

export const hostAccessCloseSelector =
  'button[aria-label="Close Host and access"], button[aria-label="Close session actions"]';

export function hostAccessDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Host & access" });
}

export function hostAccessCloseButton(dialog: Locator): Locator {
  return dialog.getByRole("button", {
    name: /^(?:Close Host and access|Close session actions)$/u
  });
}

export function hostAccessScrollOwner(dialog: Locator): Locator {
  return dialog.locator(
    ".hostdeck-session-actions__scroller, .hostdeck-sheet__body"
  ).first();
}

export async function openHostAccess(page: Page): Promise<Locator> {
  const hostAccess = hostAccessDialog(page);
  if (await hostAccess.isVisible()) return hostAccess;

  const directTrigger = page.getByRole("button", { name: "Open Host and access" });
  if (await directTrigger.isVisible()) {
    await directTrigger.click();
  } else {
    const sessionActions = page.getByRole("dialog", { name: "Session actions" });
    if (!(await sessionActions.isVisible())) {
      await page.getByRole("button", { name: "Open session actions" }).click();
      await expect(sessionActions).toBeVisible();
    }
    await sessionActions.getByRole("button", { name: /Host & access/iu }).click();
  }

  await expect(hostAccess).toBeVisible();
  return hostAccess;
}
