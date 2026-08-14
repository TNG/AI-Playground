import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'

// ── OEM co-branding ──────────────────────────────────────────────────────────
//
// On an Acer system the Game Maker feature is presented as "Acer Game Maker" and
// gains a link to the generated Acer Game Hub page. This store is the only place
// that decides such a thing, so the rest of the app asks for a label instead of
// testing for a vendor.
//
// Renaming is presentation only: the preset keeps its identity as "Game Maker"
// (that name keys `activePresetName`, last-used state and the preset files), so a
// machine that stops reporting Acer does not lose its selection.

/** Presets whose displayed name is prefixed with the OEM's brand. */
const CO_BRANDED_PRESETS = new Set(['Game Maker'])

export const useOemBranding = defineStore('oemBranding', () => {
  const vendor = ref<string>('unknown')
  const manufacturer = ref<string>('')
  let detecting: Promise<void> | null = null

  const isAcer = computed(() => vendor.value === 'acer')

  /** Brand prefix for co-branded features, empty when there is nothing to add. */
  const brand = computed(() => (isAcer.value ? 'Acer' : ''))

  /**
   * Detect once per app run. The answer comes from the firmware (cached in the
   * main process), so repeat calls are cheap but pointless.
   */
  async function initialize(): Promise<void> {
    if (detecting) return detecting
    detecting = window.electronAPI
      .detectOem()
      .then((info) => {
        vendor.value = info.vendor
        manufacturer.value = info.manufacturer
      })
      .catch(() => {
        // Branding is cosmetic: an unavailable probe means the neutral wording.
      })
    return detecting
  }

  /** The name to show for a preset — its own, unless the OEM co-brands it. */
  function presetLabel(presetName: string): string {
    return brand.value && CO_BRANDED_PRESETS.has(presetName)
      ? `${brand.value} ${presetName}`
      : presetName
  }

  /**
   * The generated gallery page is an Acer deliverable, so only Acer links to it —
   * and only Acer publishes to it. Everyone else keeps their games as the files
   * the agent wrote, reachable through the folder button.
   */
  const showsGameHub = computed(() => isAcer.value)
  const gameHubLabel = computed(() => `${brand.value || 'My'} Game Hub`)
  /** The hub named as a destination, for the action that puts a game in it. */
  const gameHubTarget = computed(() => `${brand.value || 'My'} Hub`)

  return {
    vendor,
    manufacturer,
    isAcer,
    brand,
    showsGameHub,
    gameHubLabel,
    gameHubTarget,
    initialize,
    presetLabel,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useOemBranding, import.meta.hot))
}
