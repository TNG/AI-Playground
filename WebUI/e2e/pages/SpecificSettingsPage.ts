import { type Locator, type Page, expect } from '@playwright/test'
import { type ChatMode } from './MainPage'

/**
 * Page object for the mode-specific settings sidebar (the one with the PRESET
 * grid) opened from the prompt area's "<Mode> Settings" button. Used here to
 * pick the chat preset that puts the assistant in agentic mode.
 */
export class SpecificSettingsPage {
  constructor(private readonly page: Page) {}

  private heading(mode: ChatMode): Locator {
    return this.page.getByRole('heading', { name: `${mode} Settings` })
  }

  private openButton(mode: ChatMode): Locator {
    return this.page.getByRole('button', { name: `${mode} Settings` })
  }

  /** Preset cards are role=button with the preset name as their accessible name. */
  preset(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true })
  }

  async open(mode: ChatMode = 'Chat'): Promise<void> {
    if (
      await this.heading(mode)
        .isVisible()
        .catch(() => false)
    )
      return
    await this.openButton(mode).click()
    await expect(this.heading(mode)).toBeVisible()
  }

  /** True if the preset card is present in the currently-open settings grid. */
  async isPresetVisible(name: string): Promise<boolean> {
    return this.preset(name)
      .isVisible()
      .catch(() => false)
  }

  async selectPreset(name: string): Promise<void> {
    await expect(this.preset(name)).toBeVisible()
    await this.preset(name).click()
    // Gated (high-memory / video-VRAM) presets only apply once their warning popup is
    // confirmed. It's auto-dismissed globally (see the `window` fixture), but confirm it
    // here too in case the global handler hasn't fired yet — tolerant of it already
    // being gone (dismissed) so the two paths never fight.
    const confirm = this.page
      .getByRole('dialog', { name: 'Warning' })
      .getByRole('button', { name: 'Confirm', exact: true })
    if (
      await confirm
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false)
    ) {
      await confirm.click().catch(() => {})
    }
    // Generous timeout: the confirm→apply round-trip and settings reload take a moment.
    await expect(this.preset(name)).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
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
