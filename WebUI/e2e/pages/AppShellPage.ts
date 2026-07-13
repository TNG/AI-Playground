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

  /** Close the App Settings sidebar via its (responsive) Close button. */
  async closeAppSettings(): Promise<void> {
    if (!(await this.isSettingsOpen())) return
    const closers = this.page.getByRole('button', { name: 'Close' })
    const count = await closers.count()
    for (let i = 0; i < count; i++) {
      const button = closers.nth(i)
      if (await button.isVisible()) {
        await button.click()
        break
      }
    }
    await expect(this.setupWizardButton).toBeHidden()
  }

  /** Open App Settings and launch the Setup Wizard from the developer section. */
  async openSetupWizard(): Promise<void> {
    await this.openAppSettings()
    await this.setupWizardButton.click()
  }
}
