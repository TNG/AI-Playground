import { test, expect, injectElectronMock, RUNNING_SERVICES } from './fixtures'

test.describe('App Startup', () => {
  test('renders the header with AI Playground title', async ({ appPage: page }) => {
    const header = page.locator('header.main-title')
    await expect(header).toBeVisible({ timeout: 10000 })
    await expect(header).toContainText('AI')
    await expect(header).toContainText('PLAYGROUND')
  })

  test('displays the platform title from envVars', async ({ appPage: page }) => {
    const header = page.locator('header.main-title')
    await expect(header).toContainText('from Intel®', { timeout: 10000 })
  })

  test('shows window control buttons in the header', async ({ appPage: page }) => {
    const header = page.locator('header.main-title')
    await expect(header).toBeVisible({ timeout: 10000 })

    const buttons = header.locator('button')
    const count = await buttons.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('shows the setup wizard when backends are not installed', async ({ appPage: page }) => {
    const wizardTitle = page.getByText('AI Playground Setup')
    await expect(wizardTitle).toBeVisible({ timeout: 10000 })
  })
})

test.describe('App State Transitions', () => {
  test('transitions to running state when required backends are set up', async ({ page }) => {
    await injectElectronMock(page, { services: RUNNING_SERVICES, productMode: 'essentials' })
    await page.goto('/')

    const chatArea = page.locator('#prompt-area')
    await expect(chatArea).toBeVisible({ timeout: 10000 })
  })

  test('shows the history button in running state', async ({ runningAppPage: page }) => {
    const historyButton = page.locator('#show-history-button')
    await expect(historyButton).toBeVisible({ timeout: 10000 })
    await expect(historyButton).toContainText('Show History')
  })

  test('shows the app settings button in running state', async ({ runningAppPage: page }) => {
    const settingsButton = page.locator('#app-settings-button')
    await expect(settingsButton).toBeVisible({ timeout: 10000 })
  })

  test('shows "Let\'s Generate" prompt area in running state', async ({ runningAppPage: page }) => {
    await expect(page.getByText("Let's Generate")).toBeVisible({ timeout: 10000 })
  })

  test('shows the footer with version info', async ({ runningAppPage: page }) => {
    await expect(page.getByText('AI Playground version:')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('v3.1.0-alpha')).toBeVisible()
  })

  test('shows the footer with GitHub link', async ({ runningAppPage: page }) => {
    const githubLink = page.getByRole('link', {
      name: 'https://github.com/intel/ai-playground',
    })
    await expect(githubLink).toBeVisible({ timeout: 10000 })
  })
})
