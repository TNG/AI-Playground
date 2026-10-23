import type { CreateActivityInput } from '@/assets/js/activities/activity'
import type { ActivityScope } from '@/assets/js/activities/types'
import { createAppError, extractMessage, isAppError } from '@/assets/js/errors/appError'
import type { ModelDownloadCallbacks } from '@/lib/modelDownloader'
import type { ChannelAdapter } from './adapter'
import { escapeHtml } from './adapterHelpers'
import type { InboundMeta } from './types'

const DRAFT_THROTTLE_MS = 3000

/** The channel lines of a download; the Home Agent chat path keeps the English defaults. */
export type HeadlessDownloadText = {
  progress: (p: { repoId: string; percent: number; completed: number; total: number }) => string
  complete: string
  /** Receives the failure reason already HTML-escaped. */
  failed: (escapedMessage: string) => string
}

const ENGLISH_TEXT: HeadlessDownloadText = {
  progress: (p) =>
    `⬇️ Downloading \`${p.repoId}\` — ${p.percent}% (${p.completed}/${p.total} models)`,
  complete: '✅ Download complete.',
  failed: (message) => `⚠️ The model download failed: ${message}`,
}

export type HeadlessDownloadDeps = {
  download: (list: DownloadModelParam[], callbacks: ModelDownloadCallbacks) => Promise<void>
  activities: {
    begin: (input: CreateActivityInput) => string
    update: (id: string, patch: { label?: string; progress?: number }) => void
    end: (id: string) => void
  }
  refreshModels: () => void
}

/** Runs an already-approved download, with progress in the channel and on the desktop activity sink. */
export async function runHeadlessDownload(
  args: {
    adapter: ChannelAdapter
    meta?: InboundMeta
    list: DownloadModelParam[]
    scope: ActivityScope
    text?: HeadlessDownloadText
  },
  deps: HeadlessDownloadDeps,
): Promise<void> {
  const { adapter, meta, list, scope } = args
  const text = args.text ?? ENGLISH_TEXT
  const { activities } = deps
  const activityId = activities.begin({
    category: 'backend',
    label: 'Downloading model…',
    scope,
    progress: 0,
  })
  const draft = adapter.createDraftStream(meta)
  let lastChannelUpdate = 0
  try {
    await deps.download(list, {
      onProgress: (p) => {
        activities.update(activityId, {
          label: `Downloading ${p.repoId}… (${p.completed}/${p.total})`,
          progress: Math.max(0, Math.min(1, p.percent / 100)),
        })
        const now = Date.now()
        if (p.speed !== undefined && now - lastChannelUpdate > DRAFT_THROTTLE_MS) {
          lastChannelUpdate = now
          draft.update(text.progress(p))
        }
      },
      onModelCompleted: () => deps.refreshModels(),
    })
    await draft.finalize(text.complete)
  } catch (e) {
    draft.cancel()
    const message = isAppError(e) ? e.userMessage : extractMessage(e)
    await adapter.reply(adapter.formatRichSnippet(text.failed(escapeHtml(message))), meta)
    throw createAppError({
      category: 'inference',
      code: 'model/download-failed',
      userMessage: 'The model download failed.',
      surface: 'silent',
      cause: e,
    })
  } finally {
    activities.end(activityId)
  }
}
