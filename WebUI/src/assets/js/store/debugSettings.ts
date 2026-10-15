import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref } from 'vue'

// Machine-level debug controls. Their values live in settings.json (main reads
// them), but the *controls* only appear when that file also sets
// `showDebugSettingsInUI`, so a shipped build looks unchanged.
//
// The snapshot is fetched once, before the app mounts, because two non-Vue call
// sites need the answer synchronously: the dev-only test model and the dummy
// ComfyUI workflows are injected while a preset list is being built.

let snapshot: LocalSettings | null = null

/** Fetch the settings snapshot. Awaited in `main.ts` before the app mounts. */
export async function initDebugSettings(): Promise<void> {
  try {
    snapshot = await window.electronAPI.getLocalSettings()
  } catch (e) {
    console.error('initDebugSettings: getLocalSettings failed:', e)
    snapshot = null
  }
}

/**
 * Whether the debug controls are shown. Also what unlocks the dev-only test LLM
 * and the dummy media workflows in a packaged build, so the "Use dummy media
 * workflows" checkbox has something to switch to.
 */
export function debugSettingsVisible(): boolean {
  return snapshot?.showDebugSettingsInUI === true
}

export const useDebugSettings = defineStore('debugSettings', () => {
  const visible = ref(debugSettingsVisible())
  const oemVendorOverride = ref<string | null>(snapshot?.oemVendorOverride ?? null)
  const phisonSsdDetected = ref(snapshot?.PhisonSSDdetected === true)
  const remoteRepository = ref(snapshot?.remoteRepository ?? '')
  // Edited as a comma-separated list; stored as an array.
  const openvinoImageGenDevices = ref((snapshot?.openvinoImageGenDevices ?? []).join(', '))

  async function setOemVendorOverride(value: string | null) {
    oemVendorOverride.value = value
    await window.electronAPI.updateLocalSettings({ oemVendorOverride: value })
  }

  async function setPhisonSsdDetected(value: boolean) {
    phisonSsdDetected.value = value
    await window.electronAPI.updateLocalSettings({ PhisonSSDdetected: value })
  }

  async function saveRemoteRepository() {
    const value = remoteRepository.value.trim()
    if (!value) return
    await window.electronAPI.updateLocalSettings({ remoteRepository: value })
  }

  async function saveOpenvinoImageGenDevices() {
    const value = openvinoImageGenDevices.value
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
    if (value.length === 0) return
    await window.electronAPI.updateLocalSettings({ openvinoImageGenDevices: value })
  }

  return {
    visible,
    oemVendorOverride,
    phisonSsdDetected,
    remoteRepository,
    openvinoImageGenDevices,
    setOemVendorOverride,
    setPhisonSsdDetected,
    saveRemoteRepository,
    saveOpenvinoImageGenDevices,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDebugSettings, import.meta.hot))
}
