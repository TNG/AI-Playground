import { type Locator, type Page, expect } from '@playwright/test'
import { type ChatMode } from './MainPage'

/**
 * Page object for the mode-specific settings sidebar (the one with the PRESET
 * grid) opened from the prompt area's "<Mode> Settings" button. Used here to
 * pick the chat preset that puts the assistant in agentic mode.
 */
export class SpecificSettingsPage {
  constructor(private readonly page: Page) {}

  // The settings sidebar renders with `hide-header` (no <h2> banner — see
  // SideModalSpecificSettings.vue), so its only stable handle is the SideModalBase
  // region, whose aria-label is `${mode} Settings`.
  private panel(mode: ChatMode): Locator {
    return this.page.getByRole('region', { name: `${mode} Settings` })
  }

  private openButton(mode: ChatMode): Locator {
    return this.page.getByRole('button', { name: `${mode} Settings` })
  }

  async open(mode: ChatMode = 'Chat'): Promise<void> {
    if (
      await this.panel(mode)
        .isVisible()
        .catch(() => false)
    )
      return
    await this.openButton(mode).click()
    await expect(this.panel(mode)).toBeVisible()
  }

  /**
   * Reference-image file inputs of the active ComfyUI preset, inside the settings
   * sidebar. Each is a `<input type="file">` rendered by the LoadImage control; we
   * target them as a semantic element type scoped to the mode's settings region
   * (the labels differ per preset — "Reference Image", "Input Image", etc.).
   */
  private imageInputs(mode: ChatMode): Locator {
    return this.page.getByRole('region', { name: `${mode} Settings` }).locator('input[type="file"]')
  }

  /**
   * Load the same fixture image into every reference-image slot of the active preset
   * (edit-image, image-to-video and reference-based create-image presets need one).
   * Returns how many slots were filled.
   */
  async attachReferenceImages(mode: ChatMode, filePath: string): Promise<number> {
    const inputs = this.imageInputs(mode)
    // The LoadImage inputs render a beat after the preset's settings load, so wait for
    // the first one before counting rather than racing an empty grid.
    await inputs
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .catch(() => {})
    const count = await inputs.count()
    for (let i = 0; i < count; i++) {
      await inputs.nth(i).setInputFiles(filePath)
    }
    return count
  }

  /**
   * The chat "Backend" picker trigger (a DropDownNew button). Present only when the
   * active preset allows more than one backend (see SettingsChat.vue `isBackendLocked`);
   * located via its "Backend" label row inside the settings region.
   */
  private backendTrigger(mode: ChatMode): Locator {
    return this.panel(mode).locator('div.grid', { hasText: 'Backend' }).getByRole('button')
  }

  /**
   * Backend labels offered by the picker (e.g. 'llamaCPP - GGUF', 'OpenVINO'), or an
   * empty list when the preset is locked to one backend / the picker isn't shown.
   * Opens and closes the dropdown without changing the selection.
   */
  async availableBackends(mode: ChatMode = 'Chat'): Promise<string[]> {
    const trigger = this.backendTrigger(mode)
    if (!(await trigger.isVisible().catch(() => false))) return []
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    const labels = (await menu.getByRole('menuitem').allInnerTexts())
      .map((l) => l.trim())
      .filter(Boolean)
    await this.page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    return labels
  }

  /**
   * Select a chat backend by its picker label and wait for the switch to land (the
   * trigger's label reflects the active backend). Must be called with the settings
   * sidebar open. Switching backend can kick off a backend (re)start, so callers
   * should let the app settle (and resolve any model-download dialog) before sending.
   */
  async selectBackend(label: string, mode: ChatMode = 'Chat'): Promise<void> {
    const trigger = this.backendTrigger(mode)
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.getByRole('menuitem', { name: label, exact: true }).click()
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    await expect(trigger).toContainText(label, { timeout: 15_000 })
  }

  /** Close the sidebar via its (responsive) Close button, scoped to the sidebar
   *  region so it can't match the header's window-close (X) button. */
  async close(mode: ChatMode = 'Chat'): Promise<void> {
    const sidebar = this.page.getByRole('region', { name: `${mode} Settings` })
    const closers = sidebar.getByRole('button', { name: 'Close' })
    const count = await closers.count()
    for (let i = 0; i < count; i++) {
      const button = closers.nth(i)
      if (await button.isVisible()) {
        await button.click()
        break
      }
    }
    await expect(sidebar).toBeHidden()
  }
}
