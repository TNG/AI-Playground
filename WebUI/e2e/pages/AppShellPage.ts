import { type Locator, type Page, expect } from '@playwright/test'

/**
 * Page object for the running app shell (header / settings), used to assert the
 * app reached the running state and to re-open the Setup Wizard from settings.
 */
export class AppShellPage {
  constructor(private readonly page: Page) {}

  get appSettingsButton(): Locator {
    return this.page.getByRole('button', { name: 'App Settings' })
  }

  get header(): Locator {
    return this.page.getByRole('banner')
  }

  get sessionsPanel(): Locator {
    return this.page.getByRole('region', { name: 'Sessions' })
  }

  /** Opens a fresh, untitled Session on the desktop; it lists first among the untitled ones. */
  async startNewSession(): Promise<void> {
    await this.sessionsPanel.getByRole('button', { name: 'New Session', exact: true }).click()
  }

  /** Turns on "Reachable from Channels" for the open Session, on the prompt bar. */
  async makeOpenSessionReachable(): Promise<void> {
    const reachable = this.page.getByRole('button', {
      name: 'Reachable from Channels',
      exact: true,
    })
    await expect(reachable).toBeVisible()
    if ((await reachable.getAttribute('aria-pressed')) !== 'true') await reachable.click()
    await expect(reachable).toHaveAttribute('aria-pressed', 'true')
  }

  get openDeveloperConsoleButton(): Locator {
    return this.page
      .getByRole('region', { name: 'App Settings' })
      .getByRole('button', { name: 'Open Developer Console' })
  }

  get footer(): Locator {
    return this.page.getByRole('contentinfo')
  }

  get themeButton(): Locator {
    return this.header.getByRole('button', { name: 'Theme' })
  }

  get themeOptions(): Locator {
    return this.page.getByRole('menu').getByRole('menuitemradio')
  }

  async activeTheme(): Promise<string> {
    await this.themeButton.click()
    await expect(this.themeOptions.first()).toBeVisible()
    let active = ''
    for (const option of await this.themeOptions.all()) {
      if (await option.isChecked()) active = (await option.innerText()).trim()
    }
    await this.closeThemeMenu()
    return active
  }

  async chooseTheme(name: string): Promise<void> {
    await this.themeButton.click()
    await this.themeOption(name).click()
    await expect(this.themeOptions).toHaveCount(0)
    await this.themeButton.click()
    await expect(this.themeOption(name)).toBeChecked()
    await this.closeThemeMenu()
  }

  async closeThemeMenu(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.themeOptions).toHaveCount(0)
  }

  private themeOption(name: string): Locator {
    return this.page.getByRole('menu').getByRole('menuitemradio', { name, exact: true })
  }

  get setupWizardButton(): Locator {
    return this.page.getByRole('button', { name: 'Setup Wizard' })
  }

  /** The app is in the running state once the App Settings gear is available. */
  async expectRunning(): Promise<void> {
    await expect(this.appSettingsButton).toBeVisible({ timeout: 60_000 })
  }

  isRunning(): Promise<boolean> {
    return this.appSettingsButton.isVisible()
  }

  private isSettingsOpen(): Promise<boolean> {
    return this.setupWizardButton.isVisible().catch(() => false)
  }

  /** Open the App Settings sidebar. No-op if it is already open (avoids the open
   *  sidebar intercepting a second click on the gear button). */
  async openAppSettings(): Promise<void> {
    if (await this.isSettingsOpen()) return
    await this.appSettingsButton.click()
    await expect(this.setupWizardButton).toBeVisible()
  }

  /**
   * Ensure the App Settings sidebar is closed, leaving a clean main view. The
   * sidebar re-opens when returning from the wizard and can occlude the prompt
   * area; retry the close + assert to ride out the transition.
   */
  async ensureSettingsClosed(): Promise<void> {
    // Scope the Close to the sidebar region — the header's window-close (X) button
    // is also named "Close" and clicking it would quit the app.
    const sidebar = this.page.getByRole('region', { name: 'App Settings' })
    await expect(async () => {
      if (!(await this.isSettingsOpen())) return
      const closers = sidebar.getByRole('button', { name: 'Close' })
      const count = await closers.count()
      for (let i = 0; i < count; i++) {
        const button = closers.nth(i)
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5_000 }).catch(() => {})
          break
        }
      }
      await expect(this.setupWizardButton).toBeHidden({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
  }

  /** Open App Settings and launch the Setup Wizard from the developer section. */
  async openSetupWizard(): Promise<void> {
    await this.openAppSettings()
    await this.setupWizardButton.click()
  }
}
