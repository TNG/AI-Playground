import { test, expect } from './fixtures'

test.describe.serial('Full App Lifecycle', () => {
  test('app shows the setup wizard on fresh start', async ({ window }) => {
    const wizardTitle = window.getByText('AI Playground Setup')
    await expect(wizardTitle).toBeVisible({ timeout: 30_000 })
  })

  test('setup wizard displays hardware modes', async ({ window }) => {
    const wizard = window.getByText('AI Playground Setup')
    await expect(wizard).toBeVisible({ timeout: 30_000 })

    await expect(window.getByText('HARDWARE MODE')).toBeVisible()
    const modeLabels = window.locator('label').filter({ hasText: /PLAYGROUND/ })
    const count = await modeLabels.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('setup wizard displays backend components', async ({ window }) => {
    await expect(window.getByText('AI Playground Setup')).toBeVisible({ timeout: 30_000 })

    const componentHeading = window.locator('h2').filter({ hasText: 'COMPONENTS' })
    await expect(componentHeading).toBeVisible({ timeout: 10_000 })
    await expect(window.getByText('Llama.cpp - GGUF')).toBeVisible()
  })

  test('can select essentials mode', async ({ window }) => {
    await expect(window.getByText('AI Playground Setup')).toBeVisible({ timeout: 30_000 })

    const essentialsLabel = window.locator('label').filter({ hasText: 'essentials' })
    await essentialsLabel.click()
    await expect(essentialsLabel).toHaveClass(/border-primary/)
  })

  test('"Install & Continue" transitions to running state', async ({ window }) => {
    await expect(window.getByText('AI Playground Setup')).toBeVisible({ timeout: 30_000 })

    // Toggle off unsupported backends (OpenVINO, ComfyUI) that fail on Linux
    const switches = window.locator('button[role="switch"]')
    const switchCount = await switches.count()
    for (let i = 0; i < switchCount; i++) {
      const sw = switches.nth(i)
      const row = sw.locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').first()
      const rowText = await row.innerText()
      if (
        (rowText.includes('OpenVINO') || rowText.includes('ComfyUI')) &&
        (await sw.getAttribute('data-state')) === 'checked'
      ) {
        await sw.click()
      }
    }

    const installButton = window.getByRole('button', { name: /Install & Continue|Continue/ })
    await installButton.click()

    const promptArea = window.locator('#prompt-area')
    const continueButton = window.getByRole('button', { name: 'Continue' })
    await expect(promptArea.or(continueButton)).toBeVisible({ timeout: 5 * 60_000 })

    if (await continueButton.isVisible()) {
      await continueButton.click()
    }
    await expect(promptArea).toBeVisible({ timeout: 30_000 })
  })

  test('main app shows header, prompt input, and footer', async ({ window }) => {
    // This test gets a fresh Electron instance, ensure it reaches running state
    const promptArea = window.locator('#prompt-area')
    const wizard = window.getByText('AI Playground Setup')
    await expect(promptArea.or(wizard)).toBeVisible({ timeout: 30_000 })

    if (await wizard.isVisible()) {
      const btn = window.getByRole('button', { name: /Continue/ })
      if (await btn.isVisible()) await btn.click()
    }
    await expect(promptArea).toBeVisible({ timeout: 30_000 })

    const header = window.locator('header.main-title')
    await expect(header).toContainText('AI')
    await expect(header).toContainText('PLAYGROUND')
    await expect(window.locator('#prompt-input')).toBeVisible()
    await expect(window.locator('#send-button')).toBeVisible()
    await expect(window.getByText('AI Playground version:')).toBeVisible()
  })

  test('can type in the prompt textarea', async ({ window }) => {
    const promptArea = window.locator('#prompt-area')
    const wizard = window.getByText('AI Playground Setup')
    await expect(promptArea.or(wizard)).toBeVisible({ timeout: 30_000 })
    if (await wizard.isVisible()) {
      const btn = window.getByRole('button', { name: /Continue/ })
      if (await btn.isVisible()) await btn.click()
    }
    await expect(promptArea).toBeVisible({ timeout: 30_000 })

    const textarea = window.locator('#prompt-input')
    await textarea.fill('Hello world')
    await expect(textarea).toHaveValue('Hello world')
    await textarea.fill('')
  })

  test('can open and close the history panel', async ({ window }) => {
    const promptArea = window.locator('#prompt-area')
    const wizard = window.getByText('AI Playground Setup')
    await expect(promptArea.or(wizard)).toBeVisible({ timeout: 30_000 })
    if (await wizard.isVisible()) {
      const btn = window.getByRole('button', { name: /Continue/ })
      if (await btn.isVisible()) await btn.click()
    }
    await expect(promptArea).toBeVisible({ timeout: 30_000 })

    const historyButton = window.locator('#show-history-button')
    await historyButton.click()
    const historyPanel = window.locator('#history-panel')
    await expect(historyPanel).toBeVisible({ timeout: 5_000 })

    const closeButton = historyPanel.locator('.i-close')
    await closeButton.click({ force: true })
    await expect(historyButton).toBeVisible({ timeout: 5_000 })
  })

  test('can open and close the app settings sidebar', async ({ window }) => {
    const promptArea = window.locator('#prompt-area')
    const wizard = window.getByText('AI Playground Setup')
    await expect(promptArea.or(wizard)).toBeVisible({ timeout: 30_000 })
    if (await wizard.isVisible()) {
      const btn = window.getByRole('button', { name: /Continue/ })
      if (await btn.isVisible()) await btn.click()
    }
    await expect(promptArea).toBeVisible({ timeout: 30_000 })

    await window.locator('#app-settings-button button').click()
    const sidebar = window.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5_000 })
    await expect(sidebar).toContainText('App Settings')
    await expect(sidebar).toContainText('Backend Status')

    const closeBtn = sidebar.locator('.i-close')
    await closeBtn.click({ force: true })
    await expect(sidebar).not.toBeVisible({ timeout: 5_000 })
  })

  test('footer can be hidden and shown', async ({ window }) => {
    const promptArea = window.locator('#prompt-area')
    const wizard = window.getByText('AI Playground Setup')
    await expect(promptArea.or(wizard)).toBeVisible({ timeout: 30_000 })
    if (await wizard.isVisible()) {
      const btn = window.getByRole('button', { name: /Continue/ })
      if (await btn.isVisible()) await btn.click()
    }
    await expect(promptArea).toBeVisible({ timeout: 30_000 })

    await expect(window.getByText('AI Playground version:')).toBeVisible({ timeout: 10_000 })
    await window.getByText('HIDE FOOTER').click()
    await expect(window.getByText('AI Playground version:')).not.toBeVisible({ timeout: 3_000 })

    await window.getByText('SHOW FOOTER').click()
    await expect(window.getByText('AI Playground version:')).toBeVisible({ timeout: 3_000 })
  })
})
