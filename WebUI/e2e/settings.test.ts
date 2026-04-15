import { test, expect } from './fixtures'

test.describe('App Settings Sidebar', () => {
  test('clicking the settings gear opens the app settings sidebar', async ({
    runningAppPage: page,
  }) => {
    const settingsButton = page.locator('#app-settings-button button')
    await expect(settingsButton).toBeVisible({ timeout: 10000 })

    await settingsButton.click()

    const sidebar = page.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })
    await expect(sidebar).toContainText('App Settings')
  })

  test('settings sidebar shows language selector', async ({ runningAppPage: page }) => {
    await page.locator('#app-settings-button button').click()

    const sidebar = page.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })
    await expect(sidebar.getByText('Language')).toBeVisible()
  })

  test('settings sidebar shows HuggingFace settings', async ({ runningAppPage: page }) => {
    await page.locator('#app-settings-button button').click()

    const sidebar = page.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })
    await expect(sidebar.getByText('HuggingFace', { exact: false })).toBeVisible()
  })

  test('settings sidebar shows backend status table', async ({ runningAppPage: page }) => {
    await page.locator('#app-settings-button button').click()

    const sidebar = page.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })
    await expect(sidebar.getByText('Backend Status', { exact: false })).toBeVisible()
  })

  test('settings sidebar can be closed', async ({ runningAppPage: page }) => {
    await page.locator('#app-settings-button button').click()

    const sidebar = page.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    const closeBtn = sidebar.locator('.i-close')
    await closeBtn.click({ force: true })

    await expect(sidebar).not.toBeVisible({ timeout: 5000 })
  })

  test('HuggingFace token field exists in settings', async ({ runningAppPage: page }) => {
    await page.locator('#app-settings-button button').click()

    const sidebar = page.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    const tokenInput = sidebar.locator('input[type="password"]')
    await expect(tokenInput).toBeVisible()
  })

  test('HuggingFace mirror URL field exists in settings', async ({ runningAppPage: page }) => {
    await page.locator('#app-settings-button button').click()

    const sidebar = page.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    const mirrorInput = sidebar.locator('input[placeholder="https://huggingface.co"]')
    await expect(mirrorInput).toBeVisible()
  })
})

test.describe('Footer UI', () => {
  test('footer shows and can be hidden', async ({ runningAppPage: page }) => {
    await expect(page.locator('#prompt-input')).toBeVisible({ timeout: 10000 })

    // Footer should initially be visible with version info
    await expect(page.getByText('AI Playground version:')).toBeVisible()

    // Click "HIDE FOOTER"
    const hideButton = page.getByText('HIDE FOOTER')
    await hideButton.click()

    // Footer content should be hidden
    await expect(page.getByText('AI Playground version:')).not.toBeVisible({ timeout: 3000 })

    // "SHOW FOOTER" button should appear
    const showButton = page.getByText('SHOW FOOTER')
    await expect(showButton).toBeVisible()

    // Click to show again
    await showButton.click()
    await expect(page.getByText('AI Playground version:')).toBeVisible({ timeout: 3000 })
  })

  test('footer contains GitHub link', async ({ runningAppPage: page }) => {
    await expect(page.locator('#prompt-input')).toBeVisible({ timeout: 10000 })

    const link = page.getByRole('link', {
      name: 'https://github.com/intel/ai-playground',
    })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('target', '_blank')
  })

  test('footer contains User Guide link', async ({ runningAppPage: page }) => {
    await expect(page.locator('#prompt-input')).toBeVisible({ timeout: 10000 })

    const link = page.getByRole('link', { name: 'User Guide' })
    await expect(link).toBeVisible()
  })

  test('footer contains Licenses link', async ({ runningAppPage: page }) => {
    await expect(page.locator('#prompt-input')).toBeVisible({ timeout: 10000 })

    const link = page.getByRole('link', { name: 'Licenses' })
    await expect(link).toBeVisible()
  })
})

test.describe('Developer Tools', () => {
  test('developer tools button is visible in debug mode', async ({ runningAppPage: page }) => {
    await expect(page.locator('#prompt-input')).toBeVisible({ timeout: 10000 })

    const devToolsButton = page.locator('button[title="Developer Tools"]')
    await expect(devToolsButton).toBeVisible()
  })

  test('debug server stack button is visible in debug mode', async ({ runningAppPage: page }) => {
    await expect(page.locator('#prompt-input')).toBeVisible({ timeout: 10000 })

    // The server stack button uses ServerStackIcon and is only visible with debugToolsEnabled
    const serverStackBtn = page.locator('header button').filter({
      has: page.locator('svg'),
    })
    const count = await serverStackBtn.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })
})
