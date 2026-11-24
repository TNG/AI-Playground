import { type Locator, type Page, expect } from '@playwright/test'

/**
 * Page object for App Settings' Component Manager tab (`components/ComponentManager.vue`)
 * and its title-bar entry point.
 *
 * Everything is located by role + accessible name: the tab is a `tabpanel` named
 * "Component Manager", each Component is a `group` named after it, its switch is
 * `Enable <name>`, and the header shortcut is a button named "Component Manager"
 * that stays pressed only while this tab shows.
 */
export class ComponentManagerPage {
  constructor(private readonly page: Page) {}

  get openButton(): Locator {
    return this.page.getByRole('banner').getByRole('button', { name: 'Component Manager' })
  }

  get settingsDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'App Settings' })
  }

  get tabPanel(): Locator {
    return this.settingsDialog.getByRole('tabpanel', { name: 'Component Manager', exact: true })
  }

  /** The health line: running, with updates, needing attention. */
  get healthLine(): Locator {
    return this.tabPanel.getByRole('status')
  }

  /** A Component row, named after the Component. */
  row(name: string): Locator {
    return this.tabPanel.getByRole('group', { name, exact: true })
  }

  /** A row's enable switch. */
  toggle(name: string): Locator {
    return this.row(name).getByRole('switch', { name: `Enable ${name}`, exact: true })
  }

  /** Open the tab from the header button. Idempotent. */
  async open(): Promise<void> {
    if (await this.isOpen()) return
    await this.openButton.click()
    await expect(this.tabPanel).toBeVisible()
  }

  async close(): Promise<void> {
    if (!(await this.isOpen())) return
    await this.settingsDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(this.settingsDialog).toBeHidden()
  }

  isOpen(): Promise<boolean> {
    return this.tabPanel.isVisible().catch(() => false)
  }

  /** Expand the speech sidecars nested under Core Services. */
  async expandCoreServices(): Promise<void> {
    await this.row('Core Services')
      .getByRole('button', { name: 'Core Services details', exact: true })
      .click()
  }

  /** Switch a Component on or off, leaving it in the requested state. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const toggle = this.toggle(name)
    if ((await toggle.isChecked()) !== enabled) await toggle.click()
    await expect(toggle).toBeChecked({ checked: enabled })
  }
}
