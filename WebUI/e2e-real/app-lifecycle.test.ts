import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchElectronApp } from './fixtures'
import { getMainWindow } from './helpers'

let electronApp: ElectronApplication
let window: Page

base.describe.serial('Full App Lifecycle', () => {
  base.beforeAll(async () => {
    electronApp = await launchElectronApp()
    window = await getMainWindow(electronApp)
  })

  base.afterAll(async () => {
    if (electronApp) await electronApp.close()
  })

  base('app shows the setup wizard on fresh start', async () => {
    const wizardTitle = window.getByText('AI Playground Setup')
    await expect(wizardTitle).toBeVisible({ timeout: 30_000 })
  })

  base('setup wizard displays hardware modes', async () => {
    await expect(window.getByText('HARDWARE MODE')).toBeVisible({ timeout: 10_000 })
    const modeLabels = window.locator('label').filter({ hasText: /PLAYGROUND/ })
    const count = await modeLabels.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  base('setup wizard displays backend components', async () => {
    const componentHeading = window.locator('h2').filter({ hasText: 'COMPONENTS' })
    await expect(componentHeading).toBeVisible({ timeout: 10_000 })
    await expect(window.getByText('Llama.cpp - GGUF')).toBeVisible()
  })

  base('can select essentials mode', async () => {
    const essentialsLabel = window.locator('label').filter({ hasText: 'essentials' })
    await essentialsLabel.click()
    await expect(essentialsLabel).toHaveClass(/border-primary/)
  })

  base('toggle off unsupported backends on Linux', async () => {
    // OpenVINO and ComfyUI are not supported on Linux — toggle them off
    // to prevent installation failures from blocking the wizard.
    const backendRows = window.locator('button[role="switch"]')
    const count = await backendRows.count()

    // Toggle OFF the switches for OpenVINO and ComfyUI
    for (let i = 0; i < count; i++) {
      const switchEl = backendRows.nth(i)
      const row = switchEl.locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').first()
      const rowText = await row.innerText()

      if (
        (rowText.includes('OpenVINO') || rowText.includes('ComfyUI')) &&
        (await switchEl.getAttribute('data-state')) === 'checked'
      ) {
        await switchEl.click()
      }
    }
  })

  base('"Install & Continue" installs backends and transitions to running state', async () => {
    const installButton = window.getByRole('button', { name: /Install & Continue|Continue/ })
    await expect(installButton).toBeVisible({ timeout: 10_000 })
    await installButton.click()

    const promptArea = window.locator('#prompt-area')
    const continueButton = window.getByRole('button', { name: 'Continue' })
    await expect(promptArea.or(continueButton)).toBeVisible({ timeout: 5 * 60_000 })

    if (await continueButton.isVisible()) {
      await continueButton.click()
    }
    await expect(promptArea).toBeVisible({ timeout: 30_000 })
  })

  base('main app shows header, prompt input, and footer', async () => {
    const header = window.locator('header.main-title')
    await expect(header).toBeVisible({ timeout: 10_000 })
    await expect(header).toContainText('AI')
    await expect(header).toContainText('PLAYGROUND')

    await expect(window.locator('#prompt-input')).toBeVisible()
    await expect(window.locator('#send-button')).toBeVisible()
    await expect(window.getByText('AI Playground version:')).toBeVisible()
  })

  base('can type in the prompt textarea', async () => {
    const textarea = window.locator('#prompt-input')
    await textarea.fill('Hello world')
    await expect(textarea).toHaveValue('Hello world')
    await textarea.fill('')
  })

  base('can open and close the history panel', async () => {
    const historyButton = window.locator('#show-history-button')
    await expect(historyButton).toBeVisible({ timeout: 10_000 })
    await historyButton.click()

    const historyPanel = window.locator('#history-panel')
    await expect(historyPanel).toBeVisible({ timeout: 5_000 })

    const closeButton = historyPanel.locator('.i-close')
    await closeButton.click({ force: true })
    await expect(historyButton).toBeVisible({ timeout: 5_000 })
  })

  base('can open and close the app settings sidebar', async () => {
    await window.locator('#app-settings-button button').click()
    const sidebar = window.locator('#app-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5_000 })
    await expect(sidebar).toContainText('App Settings')
    await expect(sidebar).toContainText('Language')
    await expect(sidebar).toContainText('Backend Status')

    const closeBtn = sidebar.locator('.i-close')
    await closeBtn.click({ force: true })
    await expect(sidebar).not.toBeVisible({ timeout: 5_000 })
  })

  base('can open and close the chat settings sidebar', async () => {
    await window.locator('#advanced-settings-button').click()
    const sidebar = window.locator('#advanced-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5_000 })
    await expect(sidebar.getByText('Model')).toBeVisible()

    const closeBtn = sidebar.locator('.i-close')
    await closeBtn.click({ force: true })
    await expect(sidebar).not.toBeVisible({ timeout: 5_000 })
  })

  base('footer can be hidden and shown', async () => {
    await expect(window.getByText('AI Playground version:')).toBeVisible({ timeout: 10_000 })

    await window.getByText('HIDE FOOTER').click()
    await expect(window.getByText('AI Playground version:')).not.toBeVisible({ timeout: 3_000 })

    await window.getByText('SHOW FOOTER').click()
    await expect(window.getByText('AI Playground version:')).toBeVisible({ timeout: 3_000 })
  })

  base('can reopen the setup wizard and close it', async () => {
    const serverStackButton = window.locator('header.main-title button').first()
    await serverStackButton.click()

    await expect(window.getByText('AI Playground Setup')).toBeVisible({ timeout: 10_000 })

    const closeButton = window.locator('.flex.gap-3 button').filter({ hasText: 'Close' })
    if (await closeButton.isVisible()) {
      await closeButton.click()
    } else {
      await serverStackButton.click()
    }

    await expect(window.locator('#prompt-area')).toBeVisible({ timeout: 30_000 })
  })
})
