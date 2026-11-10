import { modelLabel, readableModelName } from '@/assets/js/models/library'
import { artifactPhaseLabel, type ArtifactPhaseLabels } from '@/lib/artifactRunProjection'
import type { ArtifactKind, TurnDetails, TurnLiveStatus, TurnSummary } from '@/lib/turnTypes'

/** The model picker's name, whether the model was stamped as a repo path or a served `---` id. */
export function modelDisplayName(model: string): string {
  return modelLabel(readableModelName(model))
}

/** Words for the Turn Details summary; `{count}`, `{duration}` and `{seed}` are filled in. */
export type TurnSummaryLabels = {
  reasoned: string
  reasonedUntimed: string
  tool: string
  tools: string
  image: string
  images: string
  video: string
  videos: string
  model3d: string
  models3d: string
  audio: string
  audios: string
  seed: string
  agentRunStep: string
  agentRunSteps: string
}

export function formatTurnDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds - minutes * 60}s`
}

const ARTIFACT_LABELS: Record<ArtifactKind, [keyof TurnSummaryLabels, keyof TurnSummaryLabels]> = {
  image: ['image', 'images'],
  video: ['video', 'videos'],
  model3d: ['model3d', 'models3d'],
  audio: ['audio', 'audios'],
}

export function counted(count: number, [one, many]: [string, string]): string {
  return count === 1 ? one : many.replace('{count}', String(count))
}

function hasSummary(summary: TurnSummary): boolean {
  if (summary.kind !== 'activity') return !!summary.preset
  return (
    !!summary.steps ||
    summary.reasoningMs !== undefined ||
    !!summary.tools ||
    Object.values(summary.artifacts ?? {}).some((count) => !!count)
  )
}

export function turnDetailsShown(details: TurnDetails): boolean {
  return (
    details.parts.length > 0 || !!details.error || !!details.live || hasSummary(details.summary)
  )
}

export function turnDetailsSummaryText(summary: TurnSummary, labels: TurnSummaryLabels): string {
  const clauses: string[] = []
  if (summary.kind === 'activity') {
    if (summary.steps) {
      clauses.push(counted(summary.steps, [labels.agentRunStep, labels.agentRunSteps]))
    }
    if (summary.reasoningMs !== undefined) {
      clauses.push(
        summary.reasoningMs > 0
          ? labels.reasoned.replace('{duration}', formatTurnDuration(summary.reasoningMs))
          : labels.reasonedUntimed,
      )
    }
    if (summary.tools) clauses.push(counted(summary.tools, [labels.tool, labels.tools]))
    for (const [kind, keys] of Object.entries(ARTIFACT_LABELS) as [
      ArtifactKind,
      [keyof TurnSummaryLabels, keyof TurnSummaryLabels],
    ][]) {
      const count = summary.artifacts?.[kind]
      if (count) clauses.push(counted(count, [labels[keys[0]], labels[keys[1]]]))
    }
  } else if (summary.kind === 'workflow') {
    clauses.push(summary.preset)
    if (summary.width && summary.height) clauses.push(`${summary.width}×${summary.height}`)
    if (summary.seed !== undefined)
      clauses.push(labels.seed.replace('{seed}', String(summary.seed)))
    if (summary.durationMs !== undefined) clauses.push(formatTurnDuration(summary.durationMs))
  } else {
    clauses.push(summary.preset)
    if (summary.engine) clauses.push(summary.engine)
  }
  return clauses.join(' · ')
}

/** Words for the live status line; `{tool}` is filled in. */
export type TurnLiveLabels = {
  reasoning: string
  writing: string
  working: string
  runningTool: string
  queued: string
  audioLoading: string
  audioGenerating: string
  audioTranscribing: string
  artifact: ArtifactPhaseLabels
}

export function turnLiveText(live: TurnLiveStatus, labels: TurnLiveLabels): string {
  switch (live.kind) {
    case 'reasoning':
      return labels.reasoning
    case 'writing':
      return labels.writing
    case 'working':
      return labels.working
    case 'queued':
      return labels.queued
    case 'tool':
      return live.label ?? labels.runningTool.replace('{tool}', live.name)
    case 'activity':
      return live.label
    case 'artifact':
      return artifactPhaseLabel(live.phase, live.progress, labels.artifact) ?? labels.working
    case 'audio':
      if (live.phase === 'loading-model') return labels.audioLoading
      return live.phase === 'transcribing' ? labels.audioTranscribing : labels.audioGenerating
  }
}
