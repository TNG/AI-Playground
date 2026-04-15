import { test, expect } from './fixtures'

test('Electron app launches and shows the header', async ({ window }) => {
  const header = window.locator('header.main-title')
  await expect(header).toBeVisible({ timeout: 30_000 })
  await expect(header).toContainText('AI')
  await expect(header).toContainText('PLAYGROUND')
})
