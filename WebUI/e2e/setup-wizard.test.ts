import { test, expect, injectElectronMock } from './fixtures'

test.describe('Setup Wizard', () => {
  test('displays the wizard title', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })
  })

  test('shows product mode selection options', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    await expect(page.getByText('Hardware Mode')).toBeVisible()
    await expect(page.getByText('Playground Studio')).toBeVisible()
    await expect(page.getByText('Playground Essentials')).toBeVisible()
  })

  test('shows "Recommended" badge on the recommended mode', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    const badge = page.getByText('Recommended', { exact: false })
    await expect(badge.first()).toBeVisible()
  })

  test('shows backend component list', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    const componentSection = page.locator('h2', { hasText: 'Components' })
    await expect(componentSection).toBeVisible()
    await expect(page.getByText('Llama.cpp - GGUF')).toBeVisible()
    // These names may match multiple elements; verify at least one is in the wizard
    await expect(page.locator('.text-sm.font-medium', { hasText: 'OpenVINO' })).toBeVisible()
    await expect(page.locator('.text-sm.font-medium', { hasText: 'ComfyUI' })).toBeVisible()
  })

  test('shows "Not installed" for backends that are not set up', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    const notInstalledLabels = page.getByText('Not installed')
    await expect(notInstalledLabels.first()).toBeVisible()
  })

  test('shows the primary action button', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    const primaryButton = page.getByRole('button', { name: /Install & Continue|Continue/ })
    await expect(primaryButton).toBeVisible()
  })

  test('selecting a product mode highlights it', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    const studioLabel = page.locator('label').filter({ hasText: 'Playground Studio' })
    await studioLabel.click()

    await expect(studioLabel).toHaveClass(/border-primary/)
  })

  test('shows the language selector in the wizard footer', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    await expect(page.getByText('English')).toBeVisible()
  })

  test('shows the debug button', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    const debugButton = page.getByRole('button', { name: 'Open Developer Logs' })
    await expect(debugButton).toBeVisible()
  })

  test('shows terms and conditions text', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    await expect(page.getByText('terms', { exact: false })).toBeVisible()
  })

  test('displays component info links for each backend', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    const infoLinks = page.locator('a[target="_blank"]').filter({ has: page.locator('svg') })
    const count = await infoLinks.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })
})

test.describe('Setup Wizard with partially installed backends', () => {
  test('shows version info for installed backends', async ({ page }) => {
    await injectElectronMock(page, {
      services: [
        {
          serviceName: 'ai-backend',
          status: 'running',
          baseUrl: 'http://127.0.0.1:59000',
          port: 59000,
          isSetUp: true,
          isRequired: true,
          devices: [],
          sttDevices: [],
          errorDetails: null,
        },
        {
          serviceName: 'llamacpp-backend',
          status: 'notInstalled',
          baseUrl: 'http://127.0.0.1:39000',
          port: 39000,
          isSetUp: false,
          isRequired: false,
          devices: [],
          sttDevices: [],
          errorDetails: null,
        },
        {
          serviceName: 'openvino-backend',
          status: 'notInstalled',
          baseUrl: 'http://127.0.0.1:29000',
          port: 29000,
          isSetUp: false,
          isRequired: false,
          devices: [],
          sttDevices: [],
          errorDetails: null,
        },
        {
          serviceName: 'comfyui-backend',
          status: 'notInstalled',
          baseUrl: 'http://127.0.0.1:49000',
          port: 49000,
          isSetUp: false,
          isRequired: false,
          devices: [],
          sttDevices: [],
          errorDetails: null,
        },
      ],
    })
    await page.goto('/')

    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('3.1.0-alpha', { exact: true })).toBeVisible()
  })

  test('shows the Close button when all required backends are running', async ({ page }) => {
    await injectElectronMock(page, {
      services: [
        {
          serviceName: 'ai-backend',
          status: 'running',
          baseUrl: 'http://127.0.0.1:59000',
          port: 59000,
          isSetUp: true,
          isRequired: true,
          devices: [],
          sttDevices: [],
          errorDetails: null,
        },
        {
          serviceName: 'llamacpp-backend',
          status: 'stopped',
          baseUrl: 'http://127.0.0.1:39000',
          port: 39000,
          isSetUp: true,
          isRequired: false,
          devices: [],
          sttDevices: [],
          errorDetails: null,
        },
        {
          serviceName: 'openvino-backend',
          status: 'notInstalled',
          baseUrl: 'http://127.0.0.1:29000',
          port: 29000,
          isSetUp: false,
          isRequired: false,
          devices: [],
          sttDevices: [],
          errorDetails: null,
        },
        {
          serviceName: 'comfyui-backend',
          status: 'notInstalled',
          baseUrl: 'http://127.0.0.1:49000',
          port: 49000,
          isSetUp: false,
          isRequired: false,
          devices: [],
          sttDevices: [],
          errorDetails: null,
        },
      ],
    })
    await page.goto('/')

    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    // Use a more specific selector - the wizard Close button (not the window close button)
    const wizardCloseButton = page.locator('.flex.gap-3 button').filter({ hasText: 'Close' })
    await expect(wizardCloseButton).toBeVisible()
  })

  test('backend toggles are visible for optional backends', async ({ appPage: page }) => {
    await expect(page.getByText('AI Playground Setup')).toBeVisible({ timeout: 10000 })

    const switches = page.locator('button[role="switch"]')
    const count = await switches.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })
})
