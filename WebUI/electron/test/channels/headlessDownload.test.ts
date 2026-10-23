import { afterEach, describe, expect, it, vi } from 'vitest'
import { runHeadlessDownload } from '../../../src/assets/js/store/channels/headlessDownload'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { ModelDownloadCallbacks } from '../../../src/lib/modelDownloader'
import type { CreateActivityInput } from '../../../src/assets/js/activities/activity'

function fakeChannel() {
  const drafts: string[] = []
  const finals: string[] = []
  const replies: string[] = []
  let cancelled = 0
  const adapter = {
    kind: 'local-web',
    formatRichSnippet: (html: string) => html,
    reply: async (text: string) => {
      replies.push(text)
      return { ok: true }
    },
    createDraftStream: () => ({
      update: (text: string) => drafts.push(text),
      finalize: async (text: string) => {
        finals.push(text)
      },
      cancel: () => {
        cancelled++
      },
    }),
  } as unknown as ChannelAdapter
  return { adapter, drafts, finals, replies, cancelled: () => cancelled }
}

function fakeActivities() {
  const labels: string[] = []
  const ended: string[] = []
  const scopes: unknown[] = []
  return {
    labels,
    ended,
    scopes,
    sink: {
      begin: (input: CreateActivityInput) => {
        scopes.push(input.scope)
        return 'act-1'
      },
      update: (_id: string, patch: { label?: string }) => {
        if (patch.label) labels.push(patch.label)
      },
      end: (id: string) => {
        ended.push(id)
      },
    },
  }
}

const list = [{ repo_id: 'org/model-a', type: 'llm' }] as DownloadModelParam[]
const progress = (percent: number, speed?: string) => ({
  repoId: 'org/model-a',
  percent,
  taskPercent: percent,
  completed: 0,
  total: 1,
  speed,
})
const at = (ms: number) => vi.setSystemTime(ms)

afterEach(() => vi.useRealTimers())

describe('headless model download', () => {
  it('drafts throttled progress, refreshes models per completed model and reports completion', async () => {
    const ch = fakeChannel()
    const acts = fakeActivities()
    let refreshed = 0
    vi.useFakeTimers()
    await runHeadlessDownload(
      { adapter: ch.adapter, list, scope: { kind: 'chat', conversationKey: 'c1' } },
      {
        download: async (_list, cb: ModelDownloadCallbacks) => {
          at(10_000)
          cb.onProgress?.(progress(10, '10 MB/s'))
          at(11_000)
          cb.onProgress?.(progress(20, '10 MB/s'))
          at(15_000)
          cb.onProgress?.(progress(50))
          at(20_000)
          cb.onProgress?.(progress(90, '10 MB/s'))
          cb.onModelCompleted?.('org/model-a')
        },
        activities: acts.sink,
        refreshModels: () => refreshed++,
      },
    )
    expect(ch.drafts).toEqual([
      '⬇️ Downloading `org/model-a` — 10% (0/1 models)',
      '⬇️ Downloading `org/model-a` — 90% (0/1 models)',
    ])
    expect(acts.scopes).toEqual([{ kind: 'chat', conversationKey: 'c1' }])
    expect(acts.labels).toEqual(Array(4).fill('Downloading org/model-a… (0/1)'))
    expect(refreshed).toBe(1)
    expect(ch.finals).toEqual(['✅ Download complete.'])
    expect(acts.ended).toEqual(['act-1'])
  })

  it('reports the failure reason in the channel and throws a silent download error', async () => {
    const ch = fakeChannel()
    const acts = fakeActivities()
    const run = runHeadlessDownload(
      { adapter: ch.adapter, list, scope: { kind: 'global' } },
      {
        download: async () => {
          throw new Error('disk <full>')
        },
        activities: acts.sink,
        refreshModels: () => {},
      },
    )
    await expect(run).rejects.toMatchObject({ code: 'model/download-failed', surface: 'silent' })
    expect(ch.replies).toEqual(['⚠️ The model download failed: disk &lt;full&gt;'])
    expect(ch.cancelled()).toBe(1)
    expect(ch.finals).toEqual([])
    expect(acts.ended).toEqual(['act-1'])
  })

  it('writes progress, completion and failure in the wording it is given', async () => {
    const text = {
      progress: (p: { repoId: string; percent: number }) => `⬇️ Lade ${p.repoId} — ${p.percent}%`,
      complete: '✅ Fertig. "Spiel" läuft weiter.',
      failed: (error: string) => `⚠️ Fehlgeschlagen: ${error}`,
    }
    const ok = fakeChannel()
    vi.useFakeTimers()
    await runHeadlessDownload(
      { adapter: ok.adapter, list, scope: { kind: 'global' }, text },
      {
        download: async (_list, cb: ModelDownloadCallbacks) => {
          at(10_000)
          cb.onProgress?.(progress(40, '10 MB/s'))
        },
        activities: fakeActivities().sink,
        refreshModels: () => {},
      },
    )
    expect(ok.drafts).toEqual(['⬇️ Lade org/model-a — 40%'])
    expect(ok.finals).toEqual(['✅ Fertig. "Spiel" läuft weiter.'])

    const failing = fakeChannel()
    const run = runHeadlessDownload(
      { adapter: failing.adapter, list, scope: { kind: 'global' }, text },
      {
        download: async () => {
          throw new Error('disk <full>')
        },
        activities: fakeActivities().sink,
        refreshModels: () => {},
      },
    )
    await expect(run).rejects.toMatchObject({ code: 'model/download-failed' })
    expect(failing.replies).toEqual(['⚠️ Fehlgeschlagen: disk &lt;full&gt;'])
  })
})
