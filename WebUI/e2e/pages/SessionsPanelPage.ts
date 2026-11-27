import type { Locator, Page } from '@playwright/test'

const UNTITLED = 'Untitled Session'

export class SessionsPanelPage {
  constructor(private readonly page: Page) {}

  get region(): Locator {
    return this.page.getByRole('region', { name: 'Sessions' })
  }

  get newSessionButton(): Locator {
    return this.region.getByRole('button', { name: 'New Session', exact: true })
  }

  get newSessionMenuButton(): Locator {
    return this.region.getByRole('button', { name: 'More ways to start a Session', exact: true })
  }

  get newSessionWithOpenSettingsItem(): Locator {
    return this.page.getByRole('menuitem', {
      name: "New Session with the open Session's settings",
      exact: true,
    })
  }

  /** Rows of Sessions that have no Name yet, which every new Session is. */
  get untitledRows(): Locator {
    return this.region.getByRole('button', { name: UNTITLED, exact: true })
  }

  rowMenuButton(title: string): Locator {
    return this.region.getByRole('button', { name: `${title} options`, exact: true })
  }

  get newSessionWithTheseSettingsItem(): Locator {
    return this.page.getByRole('menuitem', { name: 'New Session with these settings', exact: true })
  }

  async startNewSession(): Promise<void> {
    await this.newSessionButton.click()
  }

  async startNewSessionWithOpenSettings(): Promise<void> {
    await this.newSessionMenuButton.click()
    await this.newSessionWithOpenSettingsItem.click()
  }

  /** Starts a Session from the first untitled row's settings, through that row's ⋯ menu. */
  async startNewSessionFromUntitledRow(): Promise<void> {
    await this.rowMenuButton(UNTITLED).first().click()
    await this.newSessionWithTheseSettingsItem.click()
  }
}
