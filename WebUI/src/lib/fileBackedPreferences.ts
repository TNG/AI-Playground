import { ref, watch, type Ref } from 'vue'
import { demoAwareStorage } from '../assets/js/demoAwareStorage'
import { useErrors } from '@/assets/js/store/errors'

/**
 * The renderer half of the kernel-owned preferences file
 * (architecture-target §6.1, step 8): a store hands over the refs it used
 * to pinia-persist and gets back hydration + write-through against its
 * section of `AI-Playground/preferences.json`.
 *
 * `init()` (once, pre-mount): read the file, hydrate the section, and when
 * the section is absent upload the legacy Pinia payload once — then drop the
 * legacy key so it can never dual-write again (kept when the upload fails, so
 * the next boot retries). Write-through is a debounced deep watch over the
 * refs — the faithful port of the persist plugin's per-mutation
 * subscription — diffed against a JSON snapshot so unchanged state never
 * hits the file, a rejected write retries on the next flush, and the
 * flush fires immediately on `beforeunload` so a quit does not drop the
 * debounce window. Nothing writes before hydration; on a failed read the
 * defaults boot and the first user change writes them through, which is the
 * recovery path for a store that did not answer.
 */

export type FileBackedPreferenceRefs = Record<string, Ref>

export type FileBackedPreference = {
  init: () => Promise<void>
  hydrated: Ref<boolean>
  dispose: () => void
}

const FLUSH_DEBOUNCE_MS = 300

export function makeFileBackedPreference(options: {
  section: string
  refs: FileBackedPreferenceRefs
  /** The pre-step-8 Pinia key; its own keys are slimmed out after the one-shot
   * upload succeeds (or dropped entirely when `legacySlim` is not set). */
  legacyKey?: string
  /** The Pinia key is shared with another section's migrator or still persists
   * other fields: remove only this section's keys and drop the key when it
   * runs empty, instead of removing it outright. */
  legacySlim?: boolean
  /** Shape the section for the file — e.g. scrub data URIs the way the old
   * pinia serializer did. Applied to the write payload and the diff base,
   * never to hydration. */
  toFile?: (section: Record<string, unknown>) => Record<string, unknown>
}): FileBackedPreference {
  const { section, refs, legacyKey, legacySlim, toFile } = options
  const hydrated = ref(false)
  let initPromise: Promise<void> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushInFlight = false
  let lastFlushedJson: string | null = null
  let legacyKeyDropped = false

  function snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(refs)) out[key] = value.value
    return toFile ? toFile(out) : out
  }

  function applySection(sectionValue: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(refs)) {
      if (key in sectionValue) value.value = sectionValue[key]
    }
  }

  function legacyPick(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null
    const out: Record<string, unknown> = {}
    let any = false
    for (const key of Object.keys(refs)) {
      if (key in raw) {
        out[key] = (raw as Record<string, unknown>)[key]
        any = true
      }
    }
    return any ? out : null
  }

  function dropLegacyKey(): void {
    if (!legacyKey || legacyKeyDropped) return
    legacyKeyDropped = true
    if (legacySlim) {
      // Remove only this section's keys; the key may hold other consumers'
      // data (another section's migrator, or fields the store still persists).
      const raw = demoAwareStorage.getItem(legacyKey)
      if (!raw) return
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (!parsed || typeof parsed !== 'object') return
        let any = false
        for (const key of Object.keys(parsed)) {
          if (key in refs) {
            delete parsed[key]
            any = true
          }
        }
        if (any && Object.keys(parsed).length === 0) {
          demoAwareStorage.removeItem(legacyKey)
        } else if (any) {
          demoAwareStorage.setItem(legacyKey, JSON.stringify(parsed))
        }
      } catch {
        // An unparsable payload is best left alone.
      }
      return
    }
    demoAwareStorage.removeItem(legacyKey)
  }

  function scheduleFlush(): void {
    if (!hydrated.value) return
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
  }

  async function flush(): Promise<void> {
    if (!hydrated.value) return
    if (flushInFlight) {
      // Re-arm instead of overlapping: this flush must diff against the
      // post-IPC state the in-flight one is about to confirm.
      scheduleFlush()
      return
    }
    const current = snapshot()
    const json = JSON.stringify(current)
    if (json === lastFlushedJson) return
    flushInFlight = true
    const errorsStore = useErrors()
    try {
      const result = await window.electronAPI.preferences.write(section, current)
      if (result.success) {
        lastFlushedJson = json
        // The write-through is also the rescue for a failed one-shot upload:
        // with the section in the file, the legacy key can never matter again.
        dropLegacyKey()
      } else {
        errorsStore.report(new Error(result.error), {
          category: 'backend',
          code: 'preferences/write-failed',
          severity: 'warning',
          surface: 'silent',
          technicalMessage: `the preferences file store rejected the '${section}' write`,
        })
      }
    } finally {
      flushInFlight = false
    }
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      const errorsStore = useErrors()
      let sections: Record<string, unknown> | null = null
      try {
        const read = await window.electronAPI.preferences.read()
        sections = read.success ? read.sections : null
      } catch {
        sections = null
      }
      if (sections === null) {
        // The file store did not answer: defaults boot, and the first user
        // change writes the section through — the recovery path. The legacy
        // key is NOT migrated here: with the file unreadable, nothing proves
        // the legacy payload is newer than what the file may already hold.
        errorsStore.report(new Error('preferences read failed'), {
          category: 'backend',
          code: 'preferences/read-failed',
          severity: 'warning',
          surface: 'silent',
          technicalMessage:
            'the preferences file store did not answer; defaults apply this session',
        })
      } else {
        const fileSection = sections[section]
        if (fileSection && typeof fileSection === 'object') {
          applySection(fileSection as Record<string, unknown>)
        } else if (legacyKey) {
          // One-shot legacy upload (§6.1: "localStorage migrates once").
          let legacySection: Record<string, unknown> | null = null
          const raw = demoAwareStorage.getItem(legacyKey)
          if (raw) {
            try {
              legacySection = legacyPick(JSON.parse(raw))
            } catch {
              legacySection = null
            }
          }
          if (legacySection) {
            // Hydrate from the in-memory payload either way — the value is
            // right even when the upload has to wait for the next boot.
            applySection(legacySection)
            try {
              const migrated = await window.electronAPI.preferences.migrate(section, legacySection)
              if (migrated.success) dropLegacyKey()
              else {
                // The file store answered but refused: retry next boot.
                errorsStore.report(new Error(migrated.error), {
                  category: 'backend',
                  code: 'preferences/migrate-failed',
                  severity: 'warning',
                  surface: 'silent',
                  technicalMessage: `the '${section}' legacy upload failed; keeping the key to retry`,
                })
              }
            } catch (error) {
              // Read succeeded; a thrown migrate is a different failure and
              // must not stay silent — the leftover key is kept to retry.
              errorsStore.report(error, {
                category: 'backend',
                code: 'preferences/migrate-failed',
                severity: 'warning',
                surface: 'silent',
                technicalMessage: `the '${section}' legacy upload failed; keeping the key to retry`,
              })
            }
          } else {
            // No payload worth keeping: the key is stale, and it can never
            // migrate — drop it so it cannot linger forever.
            dropLegacyKey()
          }
        }
      }
      lastFlushedJson = JSON.stringify(snapshot())
      hydrated.value = true
    })()
    return initPromise
  }

  const stopWatch = watch(() => Object.values(refs).map((value) => value.value), scheduleFlush, {
    deep: true,
  })

  const flushNow = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    void flush()
  }
  // Store tests instantiate stores in a bare Node env; beforeunload only
  // exists in a real window.
  const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (hasWindow) {
    window.addEventListener('beforeunload', flushNow)
  }

  return {
    init,
    hydrated,
    dispose: () => {
      stopWatch()
      if (flushTimer) clearTimeout(flushTimer)
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('beforeunload', flushNow)
      }
    },
  }
}
