import { type Locator, type Page } from '@playwright/test'
import { sessionTabPanel, setRekaToggle, showSessionTab } from './uiControls'

/** Built-in tool rows, by accessible name (SettingsBuiltinTools.vue `allBuiltinTools`). */
const BUILTIN_TOOLS = [
  'Generate media',
  'Transform image',
  'Visualize detections',
  'Capture screenshot',
  'Browse the web',
] as const

/** Preset-backed tools that expose per-workflow switches inside a collapsible. */
const WORKFLOW_TOOLS = ['Generate media', 'Transform image'] as const

/**
 * The two speech tools are children of a collapsible "Speech" group, not top-level
 * rows. reka unmounts collapsed content, so their switches only exist once the group
 * is expanded.
 */
const SPEECH_TOOLS = ['Text To Speech', 'Speech To Text'] as const

/**
 * The Attributes tab's tool selection: Home Agent's "Built-in tools" panel, or the Media
 * tools slice under Assistant's Media generation capability, which has no master switch.
 * Settings outlive a run, so the selection is enforced, not assumed.
 */
export class ToolSettingsPage {
  constructor(private readonly page: Page) {}

  private get region(): Locator {
    return sessionTabPanel(this.page, 'Attributes')
  }

  /** The chat presets' "Built-in tools" master switch (absent in the Media tools slice). */
  private get builtinMasterToggle(): Locator {
    return this.region.getByRole('checkbox', { name: 'Built-in tools', exact: true })
  }

  /** The chat presets' "MCP tools" master switch. */
  private get mcpMasterToggle(): Locator {
    return this.region.getByRole('checkbox', { name: 'MCP tools', exact: true })
  }

  private toolToggle(name: string): Locator {
    return this.region.getByRole('checkbox', { name, exact: true })
  }

  private workflowGroup(toolName: string): Locator {
    return this.region.getByRole('group', { name: `${toolName} workflows`, exact: true })
  }

  /** True when a tool selection is shown (on chat presets, only for a tool-calling model). */
  async isAvailable(): Promise<boolean> {
    await showSessionTab(this.page, 'Attributes')
    return this.toolToggle('Generate media')
      .isVisible()
      .catch(() => false)
  }

  /** Expand a collapsible (reka unmounts its content while closed). */
  private async expand(trigger: Locator, content: Locator): Promise<void> {
    if (await content.isVisible().catch(() => false)) return
    if (!(await trigger.isVisible().catch(() => false))) return
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
    await content.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  }

  private async setSpeechTools(enabled: boolean): Promise<void> {
    await this.expand(
      this.region.getByRole('button', { name: 'Speech tools', exact: true }),
      this.region.getByRole('switch', { name: SPEECH_TOOLS[0], exact: true }),
    )
    for (const name of SPEECH_TOOLS) {
      const toggle = this.region.getByRole('switch', { name, exact: true })
      if (!(await toggle.isVisible().catch(() => false))) continue
      await setRekaToggle(toggle, enabled)
    }
  }

  /** Re-enable every workflow of a tool (undo any prior trimming). */
  private async enableAllWorkflows(toolName: string): Promise<void> {
    const group = this.workflowGroup(toolName)
    await this.expand(
      this.region.getByRole('button', { name: `${toolName} workflows`, exact: true }),
      group,
    )
    const switches = group.getByRole('switch')
    const count = await switches.count()
    for (let i = 0; i < count; i++) {
      await setRekaToggle(switches.nth(i), true)
    }
  }

  /**
   * App defaults: every shown tool on except Capture screenshot, MCP on where the
   * preset has the switch, and every workflow re-enabled. Returns false when no tool
   * selection is shown.
   */
  async applyDefaultTools(): Promise<boolean> {
    if (!(await this.isAvailable())) return false
    if (await this.builtinMasterToggle.isVisible().catch(() => false)) {
      await setRekaToggle(this.builtinMasterToggle, true)
    }
    if (await this.mcpMasterToggle.isVisible().catch(() => false)) {
      await setRekaToggle(this.mcpMasterToggle, true)
    }
    for (const name of BUILTIN_TOOLS) {
      const toggle = this.toolToggle(name)
      if (!(await toggle.isVisible().catch(() => false))) continue
      await setRekaToggle(toggle, name !== 'Capture screenshot')
    }
    await this.setSpeechTools(true)
    for (const toolName of WORKFLOW_TOOLS) {
      await this.enableAllWorkflows(toolName)
    }
    return true
  }
}
