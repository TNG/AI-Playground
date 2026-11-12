import { type Page, type Locator, test, expect } from '@playwright/test'

/**
 * Page object for the Agent Library overlay (`views/AgentLibrary.vue`), opened from the Assistant
 * mode button's hover picker ("Manage Agents…").
 */
export class AgentLibraryPage {
  constructor(private readonly window: Page) {}

  private get library(): Locator {
    return this.window.getByRole('dialog', { name: 'Agent Library' })
  }

  async open(): Promise<void> {
    await test.step('Open the Agent Library', async () => {
      if (await this.library.isVisible().catch(() => false)) return
      await this.window
        .getByRole('group', { name: 'Mode', exact: true })
        .getByRole('button', { name: 'Assistant', exact: true })
        .hover()
      const manage = this.window.getByRole('button', { name: 'Manage Agents…' })
      await manage.hover()
      await manage.click()
      await expect(this.library).toBeVisible({ timeout: 15_000 })
    })
  }

  async close(): Promise<void> {
    await this.library.getByRole('button', { name: 'Close Agent Library' }).click()
    await expect(this.library).toBeHidden()
  }

  /** A saved one-Step Agent with "Can be started from a Channel" on. */
  async createStartableAgent(name: string, step: string): Promise<void> {
    await test.step(`Create the Agent "${name}", startable from a Channel`, async () => {
      await this.open()
      await this.library.getByRole('button', { name: 'New Agent' }).click()
      await this.library.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
      await this.library.getByRole('textbox', { name: 'Step 1 prompt' }).fill(step)
      await this.library.getByRole('button', { name: 'Save', exact: true }).click()
      const startable = this.library.getByRole('switch', { name: 'Can be started from a Channel' })
      await expect(startable).toBeEnabled({ timeout: 15_000 })
      await startable.click()
      await expect(startable).toBeChecked()
      await this.close()
    })
  }
}
