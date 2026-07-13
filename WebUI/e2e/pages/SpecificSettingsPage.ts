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

  async selectPreset(name: string): Promise<void> {
    await expect(this.preset(name)).toBeVisible()
    await this.preset(name).click()
    await expect(this.preset(name)).toHaveAttribute('aria-pressed', 'true')
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
