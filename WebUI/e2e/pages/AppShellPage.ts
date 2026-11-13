import { type Locator, type Page, expect } from '@playwright/test'

export type AppSettingsTab = 'App Settings' | 'Component Manager' | 'Model Library'

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

  get settingsDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'App Settings' })
  }

  settingsTab(name: AppSettingsTab): Locator {
    return this.settingsDialog.getByRole('tab', { name, exact: true })
  }

  settingsPanel(name: AppSettingsTab): Locator {
    return this.settingsDialog.getByRole('tabpanel', { name, exact: true })
  }

  get mediaModesSwitch(): Locator {
    return this.settingsPanel('App Settings')
      .getByRole('region', { name: 'Media Modes', exact: true })
      .getByRole('switch', { name: 'Media Modes', exact: true })
  }

  /** Drives the Media Modes preference to `on` through App Settings, leaving the dialog closed. */
  async setMediaModes(on: boolean): Promise<void> {
    await this.openAppSettings()
    const toggle = this.mediaModesSwitch
    if ((await toggle.isChecked()) !== on) await toggle.click()
    await expect(toggle).toBeChecked({ checked: on })
    await this.ensureSettingsClosed()
  }

  /** Scoped to the dialog: the header's window-close (X) is also named "Close" and quits the app. */
  get settingsCloseButton(): Locator {
    return this.settingsDialog.getByRole('button', { name: 'Close', exact: true })
  }

  get openDeveloperConsoleButton(): Locator {
    return this.settingsDialog.getByRole('button', { name: 'Open Developer Console' })
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

  /** The header theme menu's shortcut: App Settings scrolled to Theme, customizer open. */
  async customizeTheme(): Promise<void> {
    await this.themeButton.click()
    await this.page.getByRole('menuitem', { name: 'Customize…' }).click()
    await expect(this.settingsDialog).toBeVisible()
  }

  private themeOption(name: string): Locator {
    return this.page.getByRole('menu').getByRole('menuitemradio', { name, exact: true })
  }

  get setupWizardButton(): Locator {
    return this.settingsDialog.getByRole('button', { name: 'Setup Wizard' })
  }

  /** The app is in the running state once the App Settings gear is available. */
  async expectRunning(): Promise<void> {
    await expect(this.appSettingsButton).toBeVisible({ timeout: 60_000 })
  }

  isRunning(): Promise<boolean> {
    return this.appSettingsButton.isVisible()
  }

  private isSettingsOpen(): Promise<boolean> {
    return this.settingsDialog.isVisible().catch(() => false)
  }

  /** Open the App Settings dialog. No-op if it is already open. */
  async openAppSettings(): Promise<void> {
    if (await this.isSettingsOpen()) return
    await this.appSettingsButton.click()
    await expect(this.settingsDialog).toBeVisible()
  }

  /**
   * Ensure the App Settings dialog is closed, leaving a clean main view. It
   * re-opens when returning from the wizard; retry the close + assert to ride
   * out the transition.
   */
  async ensureSettingsClosed(): Promise<void> {
    await expect(async () => {
      if (!(await this.isSettingsOpen())) return
      await this.settingsCloseButton.click({ timeout: 5_000 }).catch(() => {})
      await expect(this.settingsDialog).toBeHidden({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
  }

  /** Open App Settings and launch the Setup Wizard from its Advanced section. */
  async openSetupWizard(): Promise<void> {
    await this.openAppSettings()
    await this.setupWizardButton.click()
  }
}
