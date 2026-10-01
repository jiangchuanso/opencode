import { expect, type Locator, type Page } from "@playwright/test"

export const APP_READY_TIMEOUT = 30_000

export async function expectAppVisible(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: APP_READY_TIMEOUT })
}

export async function expectSessionTitle(page: Page, title: string) {
  await expectAppVisible(page.getByRole("heading", { name: title }))
}

// Content (review-panel file text, timeline projections) is rendered inside
// virtualized / asynchronously-mounted views. Strict `toBeVisible()` is flaky
// there: off-screen or just-laid-out rows report a zero bounding box under
// software rendering. Waiting for attachment verifies the content actually
// loaded into the DOM, which is what these assertions intend, without coupling
// to layout/visibility quirks.
export async function expectAttached(locator: Locator, timeout = 30_000) {
  await expect(locator.first()).toBeAttached({ timeout })
}

// Same intent as `expectAttached`, but also tolerates the element still being
// mid-layout by waiting for visibility after it is attached. Use when the test
// genuinely needs the node to be on-screen.
export async function expectVisibleSettled(locator: Locator, timeout = 30_000) {
  await expect(locator.first()).toBeAttached({ timeout })
  await expect(locator.first()).toBeVisible({ timeout })
}
