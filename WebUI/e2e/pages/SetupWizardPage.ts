import { type Locator, type Page, expect } from '@playwright/test'
import { type BackendDisplayName } from '../backends'

/**
 * Page object for the Setup Wizard — the first screen on a fresh start and the
 * screen re-opened from App Settings → "Setup Wizard".
 *
 * Every backend renders through the same row component, so interactions are
 * parametric: pass the row's display name and the methods locate the row group by
 * its accessible name, then the toggle (role=switch), gear (button "<name>
 * options"), and menu items within it.
 */
export class SetupWizardPage {
  constructor(private readonly page: Page) {}

  /** Installing a real backend downloads + sets up a Python env; allow minutes. */
  static readonly INSTALL_TIMEOUT = 12 * 60_000

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'AI Playground Setup' })
  }

  async expectVisible(): Promise<void> {
    await expect(this.heading).toBeVisible({ timeout: 60_000 })
  }

  isVisible(): Promise<boolean> {
    return this.heading.isVisible()
  }

  /** The row for a backend, addressed by its accessible group label. */
  row(displayName: BackendDisplayName): Locator {
    return this.page.getByRole('group', { name: displayName, exact: true })
  }

  /** Each backend toggle has a unique accessible name: "Enable <displayName>". */
  toggle(displayName: BackendDisplayName): Locator {
    return this.page.getByRole('switch', { name: `Enable ${displayName}` })
  }

  /**
   * Whether an optional backend can be installed in the current product mode. An
   * unavailable backend (e.g. OpenVINO in NVIDIA mode) renders a disabled toggle
   * on a dimmed row. Not meaningful for required backends (their toggle is always
   * disabled), so only call this for optional ones.
   */
  async isAvailable(displayName: BackendDisplayName): Promise<boolean> {
    const toggle = this.toggle(displayName)
    if ((await toggle.count()) === 0) return false
    return !(await toggle.isDisabled())
  }

  /** Enable a backend for install unless it is required (already on) or disabled. */
  async enable(displayName: BackendDisplayName): Promise<void> {
    const toggle = this.toggle(displayName)
    await expect(toggle).toBeVisible()
    if (await toggle.isDisabled()) return // required or unavailable in this mode
    if (await toggle.isChecked()) return
    await toggle.click()
    await expect(toggle).toBeChecked()
  }

  async enableAll(displayNames: BackendDisplayName[]): Promise<void> {
    for (const name of displayNames) {
      await this.enable(name)
    }
  }

  /**
   * Turn a backend off if its row is present and enabled. Used to deactivate Home
   * Agent — leaving it on makes the wizard divert to the Home Agent setup page
   * after install instead of reaching the running app. No-op if the row is absent
   * (e.g. the feature is off) or the toggle is disabled.
   */
  async disableBackend(displayName: BackendDisplayName): Promise<void> {
    const toggle = this.toggle(displayName)
    if ((await toggle.count()) === 0) return
    if (await toggle.isDisabled()) return
    if (await toggle.isChecked()) {
      await toggle.click()
      await expect(toggle).not.toBeChecked()
    }
  }

  /** The single wizard CTA: "Install & Continue" (installs pending) or "Continue". */
  get primaryButton(): Locator {
    return this.page.getByRole('button', { name: /^(Install & Continue|Continue)$/ })
  }

  /**
   * Click the primary button and wait for the wizard to close — i.e. for the app
   * to reach the running state. Covers both the install path and the nothing-to-do
   * "Continue" path.
   */
  async installAndContinue(): Promise<void> {
    await expect(this.primaryButton).toBeEnabled()
    await this.primaryButton.click()
    await expect(this.heading).toBeHidden({ timeout: SetupWizardPage.INSTALL_TIMEOUT })
  }

  /**
   * Leave the wizard when nothing needs installing (used after version checks).
   * Uses the primary button ("Continue"), which dismisses to the running app —
   * the wizard's "Close" button shares the name "Close" with the header's
   * window-close (X) control, so it's avoided.
   */
  async continueOut(): Promise<void> {
    await expect(this.primaryButton).toBeEnabled()
    await this.primaryButton.click()
    await expect(this.heading).toBeHidden({ timeout: 60_000 })
  }

  private gear(displayName: BackendDisplayName): Locator {
    return this.page.getByRole('button', { name: `${displayName} options` })
  }

  async openGear(displayName: BackendDisplayName): Promise<void> {
    await this.gear(displayName).click()
  }

  /** The "Update to <version>" menu item, shown only when installed ≠ pinned. */
  get updateMenuItem(): Locator {
    return this.page.getByRole('menuitem', { name: /^Update to / })
  }

  /** Open the gear and report whether an update is offered, then close the menu. */
  async hasUpdateAvailable(displayName: BackendDisplayName): Promise<boolean> {
    await this.openGear(displayName)
    const visible = await this.updateMenuItem.isVisible()
    await this.page.keyboard.press('Escape')
    return visible
  }

  /**
   * Apply the pinned-version update for a backend and wait until it is no longer
   * offered (the reinstall re-installs the pinned version, then the row is up to
   * date). Polls the gear because clicking the item closes the menu.
   */
  async updateToLatest(displayName: BackendDisplayName): Promise<void> {
    await this.openGear(displayName)
    await expect(this.updateMenuItem).toBeVisible()
    await this.updateMenuItem.click()

    await expect
      .poll(
        async () => {
          try {
            return await this.hasUpdateAvailable(displayName)
          } catch {
            return true // transient state mid-reinstall — keep waiting
          }
        },
        { timeout: SetupWizardPage.INSTALL_TIMEOUT, intervals: [5_000] },
      )
      .toBe(false)
  }
}
