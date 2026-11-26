import { describe, expect, it } from 'vitest'
import {
  foldOverviewWorkCounts,
  OVERVIEW_WORK_COUNT_ORDER,
  type OverviewWorkCounts,
} from '../../session/overviewCounts'
import type { ArtifactMediaType, HistoryEntry } from '@/types/sessionIpc'

// The card's work counts are folded by code from the Session's whole History,
// never written by the model and never stored beside the summary.

let counter = 0

function historyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  counter += 1
  return {
    id: `entry-${counter}`,
    timestamp: counter,
    preset: 'Assistant',
    kind: 'chat',
    prompt: `prompt ${counter}`,
    status: 'completed',
    artifacts: [],
    ...overrides,
  }
}

function artifact(path: string, mediaType: ArtifactMediaType) {
  return { path, mediaType }
}

function withArtifacts(
  mediaType: ArtifactMediaType,
  count: number,
  overrides: Partial<HistoryEntry> = {},
): HistoryEntry {
  return historyEntry({
    artifacts: Array.from({ length: count }, (_value, index) =>
      artifact(`${mediaType}-${index}.bin`, mediaType),
    ),
    ...overrides,
  })
}

function countsOf(entries: HistoryEntry[]): OverviewWorkCounts {
  return foldOverviewWorkCounts(entries)
}

describe('counting what a Session produced', () => {
  it('counts each recorded Artifact once, so a batch of four is four pictures', () => {
    expect(countsOf([withArtifacts('image', 4)]).images).toBe(4)
    expect(countsOf([withArtifacts('video', 2)]).videos).toBe(2)
    expect(countsOf([withArtifacts('model3d', 3)]).models3d).toBe(3)
    expect(countsOf([withArtifacts('audio', 5)]).audio).toBe(5)
  })

  it('never counts a video’s adopted poster as a second picture', () => {
    const video = withArtifacts('video', 1)

    expect(countsOf([video])).toMatchObject({ videos: 1, images: 0 })
  })

  it('counts a transcription for each speech-to-text entry', () => {
    const entries = [
      historyEntry({ kind: 'stt' }),
      historyEntry({ kind: 'stt' }),
      historyEntry({ kind: 'tts' }),
    ]

    expect(countsOf(entries).transcriptions).toBe(2)
  })

  it('counts audio clips from recorded Artifacts, so an stt turn adds its own audio too', () => {
    const entries = [withArtifacts('audio', 1, { kind: 'stt' })]

    expect(countsOf(entries)).toMatchObject({ transcriptions: 1, audio: 1 })
  })

  it('counts Agent Runs by Harness Session, folding a Follow-up into its run', () => {
    const run = { taskName: 'Digest', harnessSessionId: 'run-1' }
    const followUp = { agentId: 'agent-1', agentName: 'Digest', followUp: true }

    const entries = [
      historyEntry({ ...run }),
      historyEntry({ ...run, ...followUp }),
      historyEntry({ ...run, ...followUp }),
    ]

    expect(countsOf(entries).agentRuns).toBe(1)
  })

  it('counts an Agent Run with no Harness Session one each, and ignores plain chat', () => {
    const entries = [
      historyEntry({ agentId: 'agent-1', agentName: 'Digest', followUp: true }),
      historyEntry({ agentId: 'agent-1', agentName: 'Digest', followUp: true }),
      historyEntry({ kind: 'chat' }),
    ]

    expect(countsOf(entries).agentRuns).toBe(2)
  })

  it('counts every failed or cancelled turn, and keeps only the media it recorded', () => {
    const entries = [
      historyEntry({ status: 'failed', artifacts: [artifact('kept.png', 'image')] }),
      historyEntry({ status: 'cancelled' }),
      historyEntry({ status: 'completed', artifacts: [artifact('done.png', 'image')] }),
    ]

    expect(countsOf(entries)).toMatchObject({ failedTurns: 2, images: 2 })
  })

  it('leaves absent categories at zero', () => {
    expect(countsOf([historyEntry()])).toEqual({
      images: 0,
      videos: 0,
      models3d: 0,
      audio: 0,
      transcriptions: 0,
      agentRuns: 0,
      failedTurns: 0,
    })
  })

  it('keeps a stable category order', () => {
    expect(OVERVIEW_WORK_COUNT_ORDER).toEqual([
      'images',
      'videos',
      'models3d',
      'audio',
      'transcriptions',
      'agentRuns',
      'failedTurns',
    ])
  })
})
