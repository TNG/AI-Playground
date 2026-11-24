import { type Locator, type Page, expect } from '@playwright/test'
import type { BackendDisplayName } from '../backends'

/**
 * Page object for App Settings' Component Manager tab (`components/ComponentManager.vue`)
 * and its title-bar entry point.
 *
 * Everything is located by role + accessible name: the tab is a `tabpanel` named
 * "Component Manager", each Component is a `group` named after it, its switch is
 * `Enable <name>`, and the header shortcut is a button named "Component Manager"
 * that stays pressed only while this tab shows.
 */
type ComponentRowName = BackendDisplayName | 'Hybrid Cloud'

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
  row(name: ComponentRowName): Locator {
    return this.tabPanel.getByRole('group', { name, exact: true })
  }

  /** A row's enable switch. */
  toggle(name: ComponentRowName): Locator {
    return this.row(name).getByRole('switch', { name: `Enable ${name}`, exact: true })
  }

  /** The inline Install action on a Component that is not on disk. */
  installButton(name: BackendDisplayName): Locator {
    return this.row(name).getByRole('button', { name: `Install ${name}`, exact: true })
  }

  /** The inline Repair action on a failed Component. */
  repairButton(name: BackendDisplayName): Locator {
    return this.row(name).getByRole('button', { name: 'Repair', exact: true })
  }

  /** The inline error-log action on a failed Component. */
  errorLogButton(name: BackendDisplayName): Locator {
    return this.row(name).getByRole('button', { name: 'View error log', exact: true })
  }

  /** The inline "Update to <version>" action, shown only when a newer version exists. */
  updateButton(name: BackendDisplayName): Locator {
    return this.row(name).getByRole('button', { name: `Update ${name}`, exact: true })
  }

  /** The inline Uninstall action on an optional installed Component. */
  uninstallButton(name: BackendDisplayName): Locator {
    return this.row(name).getByRole('button', { name: `Uninstall ${name}`, exact: true })
  }

  /** The uninstall confirmation dialog, named after the Component it removes. */
  uninstallDialog(name: BackendDisplayName): Locator {
    return this.page.getByRole('alertdialog', { name: `Uninstall ${name}?`, exact: true })
  }

  /** Cancel the uninstall confirmation, leaving the Component installed. */
  async cancelUninstall(name: BackendDisplayName): Promise<void> {
    await this.uninstallDialog(name).getByRole('button', { name: 'Cancel', exact: true }).click()
  }

  /** Inline install/start/stop progress text while the row is busy. */
  progressText(name: ComponentRowName): Locator {
    return this.row(name).getByText(
      /^(Installing|Downloading|Extracting|Preparing|Starting|Stopping)/,
    )
  }

  /** The row's existing options menu (reinstall, version change, settings, Channels setup). */
  optionsButton(name: BackendDisplayName): Locator {
    return this.row(name).getByRole('button', { name: `${name} options`, exact: true })
  }

  get reinstallMenuItem(): Locator {
    return this.page.getByRole('menuitem', { name: 'Reinstall Backend' })
  }

  get settingsMenuItem(): Locator {
    return this.page.getByRole('menuitem', { name: 'Settings' })
  }

  get versionChangeMenuItem(): Locator {
    return this.page.getByRole('menuitem', { name: /^(Update to|Downgrade to|Apply change to) / })
  }

  async closeOptions(): Promise<void> {
    await this.page.keyboard.press('Escape')
  }

  /** The Channels setup sub-view, shown in place of the list. */
  get channelsView(): Locator {
    return this.tabPanel.getByRole('heading', { name: 'Channel Setup', exact: true })
  }

  /** The Hybrid Cloud provider setup sub-view. */
  get cloudView(): Locator {
    return this.tabPanel.getByRole('heading', { name: 'Hybrid Cloud Setup', exact: true })
  }

  /** The sub-view footer's Back, returning to the Component list. */
  get backButton(): Locator {
    return this.tabPanel.getByRole('button', { name: '← Back', exact: true })
  }

  /** The title-bar Channels gear, the same entry point as the Permissions link. */
  get channelsGear(): Locator {
    return this.page.getByRole('button', { name: 'Revisit Channel setup', exact: true })
  }

  /** A Component's options menu, opened by its gear. */
  async openOptions(name: BackendDisplayName): Promise<void> {
    await this.row(name)
      .getByRole('button', { name: `Configure ${name} providers`, exact: true })
      .click()
  }

  /** Open the Channels setup from the title-bar gear. */
  async openChannelsFromGear(): Promise<void> {
    await this.close()
    await this.channelsGear.click()
    await expect(this.tabPanel).toBeVisible()
    await expect(this.channelsView).toBeVisible()
  }

  /** Open the Hybrid Cloud provider setup from its row's options menu. */
  async openCloudFromRow(): Promise<void> {
    await this.open()
    await this.row('Hybrid Cloud')
      .getByRole('button', { name: 'Configure Hybrid Cloud providers', exact: true })
      .click()
    await this.page.getByRole('menuitem', { name: 'Go to Setup', exact: true }).click()
    await expect(this.cloudView).toBeVisible()
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

  /** The current Hardware Mode and its Change action. */
  get hardwareModeRow(): Locator {
    return this.tabPanel.getByRole('group', { name: 'Hardware Mode', exact: true })
  }

  get changeHardwareModeButton(): Locator {
    return this.hardwareModeRow.getByRole('button', { name: 'Change', exact: true })
  }

  /** The Hardware Mode confirmation is portaled, so it is looked up on the page. */
  get hardwareModeDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Hardware Mode', exact: true })
  }

  /** One radio per mode, named "<title> <subtitle>" (e.g. "AI PLAYGROUND studio"). */
  hardwareModeOption(name: string): Locator {
    return this.hardwareModeDialog.getByRole('radio', { name, exact: true })
  }

  get applyHardwareModeButton(): Locator {
    return this.hardwareModeDialog.getByRole('button', { name: 'Apply', exact: true })
  }

  async openHardwareModeDialog(): Promise<void> {
    await this.changeHardwareModeButton.click()
    await expect(this.hardwareModeDialog).toBeVisible()
  }

  /** Choose a mode and confirm; leaves the dialog closed on the applied mode. */
  async applyHardwareMode(name: string): Promise<void> {
    await this.hardwareModeOption(name).click()
    await this.applyHardwareModeButton.click()
    await expect(this.hardwareModeDialog).toBeHidden()
  }

  /** The Default GPU row: the current default plus its Change button. Hidden with no GPU. */
  get defaultGpuRow(): Locator {
    return this.tabPanel.getByRole('group', { name: 'Default GPU', exact: true })
  }

  get changeDefaultGpuButton(): Locator {
    return this.defaultGpuRow.getByRole('button', { name: 'Change', exact: true })
  }

  /** The change dialog is portaled, so it is looked up on the page, not in the tab. */
  get defaultGpuDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Default GPU', exact: true })
  }

  /** One radio per detected GPU, named after the device. */
  get defaultGpuOptions(): Locator {
    return this.defaultGpuDialog.getByRole('radio')
  }

  get overrideDeviceSwitch(): Locator {
    return this.defaultGpuDialog.getByRole('switch', {
      name: 'Override existing preset device selections',
      exact: true,
    })
  }

  async openDefaultGpuDialog(): Promise<void> {
    await this.changeDefaultGpuButton.click()
    await expect(this.defaultGpuDialog).toBeVisible()
  }

  /** Switch a Component on or off, leaving it in the requested state. */
  async setEnabled(name: ComponentRowName, enabled: boolean): Promise<void> {
    const toggle = this.toggle(name)
    if ((await toggle.isChecked()) !== enabled) await toggle.click()
    await expect(toggle).toBeChecked({ checked: enabled })
  }
}
