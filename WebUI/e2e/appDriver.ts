import { type Page, test, expect } from '@playwright/test'
import { SetupWizardPage } from './pages/SetupWizardPage'
import { AppShellPage } from './pages/AppShellPage'
import { MainPage } from './pages/MainPage'
import { SpecificSettingsPage } from './pages/SpecificSettingsPage'
import { BACKENDS } from './backends'

/**
 * High-level entry point for the e2e suite. Every test starts with
 * `await app.installAllBackends()`, which brings the app to a running state with
 * all backends installed and up to date, whether starting fresh (Setup Wizard
 * shown) or from a previous run (app already running).
 */
export class AppDriver {
  readonly wizard: SetupWizardPage
  readonly shell: AppShellPage
  readonly main: MainPage
  readonly settings: SpecificSettingsPage

  constructor(private readonly window: Page) {
    this.wizard = new SetupWizardPage(window)
    this.shell = new AppShellPage(window)
    this.main = new MainPage(window)
    this.settings = new SpecificSettingsPage(window)
  }

  /**
   * Install every backend (no Home Agent), then verify via the settings menu that
   * each is at its pinned version — updating any that are not. Idempotent: on a
   * machine where backends are already installed the wizard is skipped and only
   * the verification runs.
   */
  async installAllBackends(): Promise<void> {
    await test.step('Install all backends and reach the running app', async () => {
      const startedOnWizard = await this.waitForWizardOrRunning()

      if (startedOnWizard) {
        await test.step('Enable all backends in the Setup Wizard (no Home Agent)', async () => {
          await this.wizard.expectVisible()
          await this.wizard.disableBackend('Home Agent')
          await this.wizard.enableAll(BACKENDS.map((b) => b.displayName))
        })

        await test.step('Install and continue to the running app', async () => {
          await this.wizard.installAndContinue()
        })
      }

      await this.shell.expectRunning()

      await test.step('Verify each backend is up to date, updating to the pinned version if not', async () => {
        await this.shell.openSetupWizard()
        await this.wizard.expectVisible()
        // Re-opening the wizard reseeds install selection and re-enables any
        // installed backend, so deactivate Home Agent again before continuing.
        await this.wizard.disableBackend('Home Agent')

        for (const backend of BACKENDS.filter((b) => b.hasVersionAction)) {
          await test.step(`Check ${backend.displayName} version`, async () => {
            // Skip backends unavailable in the current product mode (e.g. OpenVINO
            // is disabled in NVIDIA mode) — they are neither installed nor updated.
            if (!(await this.wizard.isAvailable(backend.displayName))) return
            if (await this.wizard.hasUpdateAvailable(backend.displayName)) {
              await this.wizard.updateToLatest(backend.displayName)
            }
            expect(await this.wizard.hasUpdateAvailable(backend.displayName)).toBe(false)
          })
        }

        await this.wizard.continueOut()
        await this.shell.expectRunning()
        // Leave a clean main view (the settings sidebar re-opens on return and
        // would otherwise occlude the prompt area for follow-up steps).
        await this.shell.ensureSettingsClosed()
      })
    })
  }

  /** Resolve once either the wizard or the running shell is on screen. */
  private async waitForWizardOrRunning(): Promise<boolean> {
    await expect(this.wizard.heading.or(this.shell.appSettingsButton)).toBeVisible({
      timeout: 120_000,
    })
    return this.wizard.isVisible()
  }
}
