import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useI18N } from '@/assets/js/store/i18n'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useModeSettingsLabel } from '@/assets/js/modeSettingsLabel'

const agentMode = reactive<{ activeAgentPreset: { name: string } | null }>({
  activeAgentPreset: null,
})

vi.mock('@/assets/js/store/agentMode', () => ({ useAgentMode: () => agentMode }))

describe('useModeSettingsLabel', () => {
  beforeEach(() => {
    globalThis.window = {
      electronAPI: { getLocaleSettings: async () => ({ languageOverride: null }) },
    } as unknown as Window & typeof globalThis
    setActivePinia(createPinia())
    useI18N().state.MODE_CHAT = 'Chat'
    agentMode.activeAgentPreset = null
  })

  it('names a mode with a mode button after the mode', () => {
    agentMode.activeAgentPreset = { name: 'Agent' }
    expect(useModeSettingsLabel('chat').value).toBe('Chat Settings')
  })

  it('names Agent mode after the agent preset, as the preset list shows it', () => {
    agentMode.activeAgentPreset = { name: 'Agent' }
    expect(useModeSettingsLabel('agent').value).toBe('Agent Maker Settings')
  })

  it('follows the agent preset and its OEM branding', () => {
    const label = useModeSettingsLabel('agent')
    agentMode.activeAgentPreset = { name: 'Game Agent' }
    expect(label.value).toBe('Game Agent Settings')
    useOemBranding().vendor = 'acer'
    expect(label.value).toBe('Acer Game Agent Settings')
  })

  it('falls back to the mode name before an agent preset is known', () => {
    expect(useModeSettingsLabel('agent').value).toBe('Agent Settings')
  })
})
