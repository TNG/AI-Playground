import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchElectronApp } from './fixtures'
import { getMainWindow } from './helpers'

async function ensureRunningState(window: Page): Promise<void> {
  const promptArea = window.locator('#prompt-area')
  const wizardTitle = window.getByText('AI Playground Setup')
  await expect(promptArea.or(wizardTitle)).toBeVisible({ timeout: 30_000 })

  if (await wizardTitle.isVisible()) {
    const installButton = window.getByRole('button', { name: /Install & Continue/ })
    const continueButton = window.getByRole('button', { name: 'Continue' })

    if (await installButton.isVisible()) {
      await installButton.click()
      await expect(promptArea.or(continueButton)).toBeVisible({ timeout: 5 * 60_000 })
    }
    if (await continueButton.isVisible()) {
      await continueButton.click()
    }
  }
  await expect(promptArea).toBeVisible({ timeout: 30_000 })
}

let electronApp: ElectronApplication
let window: Page

base.describe.serial('Chat Inference End-to-End', () => {
  base.beforeAll(async () => {
    electronApp = await launchElectronApp()
    window = await getMainWindow(electronApp)
    await ensureRunningState(window)
  })

  base.afterAll(async () => {
    if (electronApp) await electronApp.close()
  })

  base('select the test model via chat settings', async () => {
    await window.locator('#advanced-settings-button').click()
    const sidebar = window.locator('#advanced-settings-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5_000 })

    const modelLabel = sidebar.getByText('Model', { exact: true })
    await expect(modelLabel).toBeVisible()

    // The model dropdown trigger is in the same grid row as the Model label
    const modelRow = sidebar
      .locator('.grid')
      .filter({ has: sidebar.getByText('Model', { exact: true }) })
    const trigger = modelRow.locator('button').first()
    await trigger.click()

    const testModelItem = window.getByText('LFM2.5-350M', { exact: false }).first()
    await expect(testModelItem).toBeVisible({ timeout: 10_000 })
    await testModelItem.click()

    const closeBtn = sidebar.locator('.i-close')
    await closeBtn.click({ force: true })
    await expect(sidebar).not.toBeVisible({ timeout: 5_000 })
  })

  base('send a message and receive a streamed response', async () => {
    const textarea = window.locator('#prompt-input')
    await textarea.fill('Say hello in one short sentence.')
    await window.locator('#send-button').click()

    // Wait for the chat panel (model may need to download ~255MB + load)
    const chatPanel = window.locator('#chatPanel')
    await expect(chatPanel).toBeVisible({ timeout: 5 * 60_000 })

    // Wait for assistant response
    const assistantIcon = chatPanel.locator('img[src*="ai-icon"]').first()
    await expect(assistantIcon).toBeVisible({ timeout: 5 * 60_000 })
  })

  base('user message is visible in the chat', async () => {
    const chatPanel = window.locator('#chatPanel')
    await expect(chatPanel.getByText('Say hello in one short sentence.')).toBeVisible({
      timeout: 10_000,
    })
  })

  base('assistant response contains text', async () => {
    const chatPanel = window.locator('#chatPanel')
    const assistantBlocks = chatPanel.locator('.flex.items-start.gap-3').last()
    const text = await assistantBlocks.innerText()
    expect(text.length).toBeGreaterThan(10)
  })

  base('copy button is available on messages', async () => {
    const chatPanel = window.locator('#chatPanel')
    const copyButton = chatPanel.getByText('Copy').last()
    await expect(copyButton).toBeVisible({ timeout: 5_000 })
  })

  base('can send a follow-up message', async () => {
    const textarea = window.locator('#prompt-input')
    await textarea.fill('What is 2 + 2?')
    await window.locator('#send-button').click()

    const chatPanel = window.locator('#chatPanel')
    const aiIcons = chatPanel.locator('img[src*="ai-icon"]')
    await expect(aiIcons).toHaveCount(2, { timeout: 5 * 60_000 })
  })

  base('conversation is listed in history', async () => {
    const historyButton = window.locator('#show-history-button')
    await historyButton.click()

    const historyPanel = window.locator('#history-panel')
    await expect(historyPanel).toBeVisible({ timeout: 5_000 })

    await expect(historyPanel.getByText('hello', { exact: false })).toBeVisible({
      timeout: 10_000,
    })

    const closeBtn = historyPanel.locator('.i-close')
    await closeBtn.click({ force: true })
  })
})
