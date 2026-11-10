import { type Locator, type Page } from '@playwright/test'
import { sessionTabPanel, showSessionTab } from './uiControls'

/** Assistant's capabilities, by checklist label (each capability's `label` in electron/agent/capabilities). */
export type AssistantCapability =
  | 'Media generation'
  | 'Document search'
  | 'Web access'
  | 'Files and shell'
  | 'Persistent memory'
  | 'Channel notifications'
  | 'Web debugging'

/** What Assistant ships with switched on (DEFAULT_CAPABILITY_IDS: media, rag, web). */
export const ASSISTANT_DEFAULT_CAPABILITIES: readonly AssistantCapability[] = [
  'Media generation',
  'Document search',
  'Web access',
]

const ALL_CAPABILITIES: readonly AssistantCapability[] = [
  ...ASSISTANT_DEFAULT_CAPABILITIES,
  'Files and shell',
  'Persistent memory',
  'Channel notifications',
  'Web debugging',
]

/**
 * Page object for the Session Settings Assistant keeps in its Attributes tab
 * (SettingsAgentAttributes.vue): the capabilities checklist and the MCP server
 * checklist. Its Media tools slice is {@link ToolSettingsPage}'s.
 */
export class AssistantSettingsPage {
  constructor(private readonly page: Page) {}

  private get region(): Locator {
    return sessionTabPanel(this.page, 'Attributes')
  }

  /** A capability's checkbox; its name runs on into the summary, hence the prefix match. */
  private capability(label: AssistantCapability): Locator {
    return this.region
      .getByRole('group', { name: 'Capabilities', exact: true })
      .getByRole('checkbox', { name: new RegExp(`^${label}`) })
  }

  private get mcpServers(): Locator {
    return this.region
      .getByRole('group', { name: 'MCP servers', exact: true })
      .getByRole('checkbox')
  }

  /**
   * Switch on exactly `enabled` and every other capability off, then every MCP server
   * off. A capability the model cannot have is shown disabled and left as it is.
   */
  async enforceCapabilities(enabled: readonly AssistantCapability[]): Promise<void> {
    await showSessionTab(this.page, 'Attributes')
    for (const label of ALL_CAPABILITIES) {
      const box = this.capability(label)
      if (!(await box.isVisible().catch(() => false)) || (await box.isDisabled())) continue
      await box.setChecked(enabled.includes(label))
    }
    const servers = this.mcpServers
    const count = await servers.count()
    for (let i = 0; i < count; i++) {
      await servers.nth(i).setChecked(false)
    }
  }
}
