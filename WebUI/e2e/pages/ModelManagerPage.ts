import { type Locator, type Page, expect } from '@playwright/test'

/**
 * Page object for the Model Management view (`views/ModelManager.vue`) — the
 * full-screen model library opened from the title bar or from "Manage Models" in
 * the Chat settings sidebar.
 *
 * Everything is located by role + accessible name, so the ARIA the app carries is
 * what this drives: the overlay is a `dialog` named "Models", each row's action
 * menu is `<label> actions`, and the row checkboxes are `Select <label>`.
 */
export class ModelManagerPage {
  constructor(private readonly page: Page) {}

  private get overlay(): Locator {
    return this.page.getByRole('dialog', { name: 'Models' })
  }

  private get openButton(): Locator {
    return this.page.getByRole('button', { name: 'Model management' })
  }

  get searchBox(): Locator {
    return this.overlay.getByRole('searchbox', { name: 'Search models' })
  }

  get showHiddenCheckbox(): Locator {
    return this.overlay.getByRole('checkbox', { name: 'Show hidden' })
  }

  /** A row, matched by the model's visible label (its file name). */
  row(label: string): Locator {
    return this.overlay.getByRole('row').filter({ hasText: label })
  }

  /**
   * Model rows currently rendered. Filtered on having a `cell`, which excludes the
   * header row — its cells are `columnheader`s, and it carries a select-all
   * checkbox of its own, so filtering on the checkbox would count it as a model.
   */
  get rows(): Locator {
    return this.overlay.getByRole('row').filter({ has: this.page.getByRole('cell') })
  }

  /** Open the library. Idempotent — a second call with it already open is a no-op. */
  async open(): Promise<void> {
    if (await this.isOpen()) return
    await this.openButton.click()
    await expect(this.overlay).toBeVisible()
  }

  async close(): Promise<void> {
    if (!(await this.isOpen())) return
    // Scoped to the overlay: the header's window-close control is also a "Close"
    // button and clicking it would quit the app.
    await this.overlay.getByRole('button', { name: 'Close model management' }).click()
    await expect(this.overlay).toBeHidden()
  }

  isOpen(): Promise<boolean> {
    return this.overlay.isVisible().catch(() => false)
  }

  /** Narrow the table to models whose file name contains `text`. */
  async search(text: string): Promise<void> {
    await this.searchBox.fill(text)
  }

  /** Pick a use case in the left sidebar ("All", "LLM", "Embedding", …). */
  async selectUseCase(useCase: string): Promise<void> {
    await this.overlay
      .getByRole('navigation', { name: 'Model use cases' })
      .getByText(useCase, { exact: true })
      .click()
  }

  async setShowHidden(enabled: boolean): Promise<void> {
    const checkbox = this.showHiddenCheckbox
    const checked = (await checkbox.getAttribute('data-state')) === 'checked'
    if (checked !== enabled) await checkbox.click()
  }

  /** Run one item from a row's "…" menu, e.g. "Hide from model picker". */
  async rowAction(label: string, action: string | RegExp): Promise<void> {
    await this.overlay.getByRole('button', { name: `${label} actions` }).click()
    await this.page.getByRole('menuitem', { name: action }).click()
  }

  /** Whether a row's action menu offers an item (icon-only actions are menu items). */
  async hasRowAction(label: string, action: string | RegExp): Promise<boolean> {
    await this.overlay.getByRole('button', { name: `${label} actions` }).click()
    const item = this.page.getByRole('menuitem', { name: action })
    const present = await item.isVisible().catch(() => false)
    await this.page.keyboard.press('Escape')
    return present
  }

  async toggleFavorite(label: string): Promise<void> {
    await this.row(label)
      .getByRole('button', { name: new RegExp(`favorites ${escapeRegExp(label)}$`) })
      .click()
  }

  async select(label: string): Promise<void> {
    await this.row(label)
      .getByRole('checkbox', { name: `Select ${label}` })
      .click()
  }

  /** The batch download button, which only appears once something downloadable is selected. */
  get downloadSelectedButton(): Locator {
    return this.overlay.getByRole('button', { name: /^Download selected/ })
  }

  /**
   * The label of every row currently listed, top to bottom. Read per row rather
   * than as one flattened cell list, which would collapse to a single match.
   * The model cell also carries the repository and "Used by" lines, so only its
   * first line is the label.
   */
  async visibleLabels(): Promise<string[]> {
    const count = await this.rows.count()
    const labels: string[] = []
    for (let index = 0; index < count; index++) {
      const cell = this.rows.nth(index).getByRole('cell').nth(2)
      labels.push((await cell.innerText()).split('\n')[0]!.trim())
    }
    return labels
  }

  async expectRowVisible(label: string): Promise<void> {
    await expect(this.row(label)).toBeVisible()
  }

  async expectRowHidden(label: string): Promise<void> {
    await expect(this.row(label)).toHaveCount(0)
  }

  /** Open the "Model folders" dialog from the toolbar. */
  async openFolders(): Promise<Locator> {
    await this.overlay.getByRole('button', { name: 'Model folders' }).click()
    const dialog = this.page.getByRole('dialog', { name: 'Model folders' })
    await expect(dialog).toBeVisible()
    return dialog
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
