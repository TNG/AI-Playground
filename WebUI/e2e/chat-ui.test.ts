import { test, expect } from './fixtures'

test.describe('Chat UI in Running State', () => {
  test('shows the prompt textarea', async ({ runningAppPage: page }) => {
    const textarea = page.locator('#prompt-input')
    await expect(textarea).toBeVisible({ timeout: 10000 })
  })

  test('prompt textarea has correct placeholder text', async ({ runningAppPage: page }) => {
    const textarea = page.locator('#prompt-input')
    await expect(textarea).toBeVisible({ timeout: 10000 })

    const placeholder = await textarea.getAttribute('placeholder')
    expect(placeholder).toBeTruthy()
  })

  test('shows the send button', async ({ runningAppPage: page }) => {
    const sendButton = page.locator('#send-button')
    await expect(sendButton).toBeVisible({ timeout: 10000 })
  })

  test('shows the chat settings button', async ({ runningAppPage: page }) => {
    const settingsButton = page.locator('#advanced-settings-button')
    await expect(settingsButton).toBeVisible({ timeout: 10000 })
    await expect(settingsButton).toContainText('Settings')
  })

  test('can type text in the prompt area', async ({ runningAppPage: page }) => {
    const textarea = page.locator('#prompt-input')
    await expect(textarea).toBeVisible({ timeout: 10000 })

    await textarea.fill('Hello, how are you?')
    await expect(textarea).toHaveValue('Hello, how are you?')
  })

  test('shows the "Let\'s Generate" heading', async ({ runningAppPage: page }) => {
    await expect(page.getByText("Let's Generate")).toBeVisible({ timeout: 10000 })
  })

  test('shows the camera button in chat mode', async ({ runningAppPage: page }) => {
    const cameraButton = page.locator('#camera-button')
    await expect(cameraButton).toBeVisible({ timeout: 10000 })
  })

  test('shows the microphone button in chat mode', async ({ runningAppPage: page }) => {
    const micButton = page.locator('#microphone-button')
    await expect(micButton).toBeVisible({ timeout: 10000 })
  })

  test('shows font size zoom controls in chat mode', async ({ runningAppPage: page }) => {
    await expect(page.locator('#prompt-input')).toBeVisible({ timeout: 10000 })

    const zoomControls = page.locator('button[title="Decrease font size"]')
    await expect(zoomControls).toBeVisible()

    const zoomIn = page.locator('button[title="Increase font size"]')
    await expect(zoomIn).toBeVisible()
  })

  test('send button arrow is visible and clickable', async ({ runningAppPage: page }) => {
    const sendButton = page.locator('#send-button')
    await expect(sendButton).toBeVisible({ timeout: 10000 })
    await expect(sendButton).toContainText('→')
  })

  test('textarea can be cleared after typing', async ({ runningAppPage: page }) => {
    const textarea = page.locator('#prompt-input')
    await expect(textarea).toBeVisible({ timeout: 10000 })

    await textarea.fill('Some test text')
    await expect(textarea).toHaveValue('Some test text')

    await textarea.fill('')
    await expect(textarea).toHaveValue('')
  })
})

test.describe('Chat History Panel', () => {
  test('clicking "Show History" opens the history panel', async ({ runningAppPage: page }) => {
    const historyButton = page.locator('#show-history-button')
    await expect(historyButton).toBeVisible({ timeout: 10000 })

    await historyButton.click()

    const historyPanel = page.locator('#history-panel')
    await expect(historyPanel).toBeVisible()
  })

  test('history panel shows "New Conversation" button', async ({ runningAppPage: page }) => {
    const historyButton = page.locator('#show-history-button')
    await expect(historyButton).toBeVisible({ timeout: 10000 })
    await historyButton.click()

    await expect(page.getByText('New Conversation', { exact: false })).toBeVisible({
      timeout: 5000,
    })
  })

  test('history panel can be closed', async ({ runningAppPage: page }) => {
    const historyButton = page.locator('#show-history-button')
    await expect(historyButton).toBeVisible({ timeout: 10000 })

    await historyButton.click()
    const historyPanel = page.locator('#history-panel')
    await expect(historyPanel).toBeVisible()

    // The side modal has two close buttons (responsive). Click the visible one via the i-close icon.
    const closeButton = historyPanel.locator('.i-close')
    await closeButton.click({ force: true })

    // After closing, the "Show History" button should reappear
    await expect(historyButton).toBeVisible({ timeout: 5000 })
  })
})

test.describe('Prompt Area Advanced Settings', () => {
  test('clicking settings button opens the side modal', async ({ runningAppPage: page }) => {
    const settingsButton = page.locator('#advanced-settings-button')
    await expect(settingsButton).toBeVisible({ timeout: 10000 })

    await settingsButton.click()

    const sideModal = page.locator('#advanced-settings-sidebar')
    await expect(sideModal).toBeVisible({ timeout: 5000 })
  })

  test('settings sidebar shows the correct title for chat mode', async ({
    runningAppPage: page,
  }) => {
    const settingsButton = page.locator('#advanced-settings-button')
    await expect(settingsButton).toBeVisible({ timeout: 10000 })

    await settingsButton.click()

    const sideModal = page.locator('#advanced-settings-sidebar')
    await expect(sideModal).toBeVisible({ timeout: 5000 })
    await expect(sideModal).toContainText('Settings')
  })

  test('settings sidebar can be closed', async ({ runningAppPage: page }) => {
    const settingsButton = page.locator('#advanced-settings-button')
    await expect(settingsButton).toBeVisible({ timeout: 10000 })

    await settingsButton.click()
    const sideModal = page.locator('#advanced-settings-sidebar')
    await expect(sideModal).toBeVisible({ timeout: 5000 })

    const closeBtn = sideModal.locator('.i-close')
    await closeBtn.click({ force: true })

    await expect(sideModal).not.toBeVisible({ timeout: 5000 })
  })
})
