import { generatedMediaOf, toolPartNameOf } from '@/lib/agentTranscript'
import { sessionMediaPathOf } from '@/lib/comfyWorkflow'
import type { AudioPhase } from '@/lib/sessionTimeline'
import type { ArtifactAction } from '@/lib/turnArtifacts'
import type { ArtifactPhase } from '@/types/kernelEvents'
import type { AudioTurnData } from '@/types/sessionTimeline'

/** One generated speech clip a Turn shows, with what its card offers to do with it. */
export type AudioArtifact = {
  id: string
  mediaType: 'audio'
  state: AudioArtifactState
  /** The Session-Folder file the player streams. */
  url?: string
  /** An older clip outside the Session Folder: its file in the app's audio folder. */
  filePath?: string
  /** Where an agent's clip sits in its workspace. */
  workspacePath?: string
  actions: ArtifactAction[]
  /** Where a running clip's generation is, in the phases every artifact card shows. */
  phase?: ArtifactPhase
  /** Why a failed clip was not made. */
  reason?: string
}

export type AudioArtifactState = 'running' | 'done' | 'deleted' | 'failed' | 'cancelled'

function clip(
  id: string,
  state: AudioArtifactState,
  extra: Partial<Omit<AudioArtifact, 'id' | 'state' | 'mediaType'>> = {},
): AudioArtifact {
  return { id, mediaType: 'audio', state, actions: [], ...extra }
}

function savedClip(id: string, url: string, deletedUrls: readonly string[]): AudioArtifact {
  if (deletedUrls.includes(url)) return clip(id, 'deleted', { url })
  return clip(id, 'done', { url, actions: actionsFor(url) })
}

function actionsFor(url: string): ArtifactAction[] {
  return ['download', 'openFolder', ...(sessionMediaPathOf(url) ? (['delete'] as const) : [])]
}

/** A Text-to-Speech Turn's clip; a Speech-to-Text Turn's Result is its transcript. */
export function audioTurnArtifacts(
  id: string,
  audio: AudioTurnData,
  deletedUrls: readonly string[],
): AudioArtifact[] {
  if (audio.kind !== 'tts') return []
  if (audio.status === 'failed') {
    return [clip(id, 'failed', audio.error ? { reason: audio.error } : {})]
  }
  if (audio.status === 'cancelled') return [clip(id, 'cancelled')]
  return audio.audioUrl ? [savedClip(id, audio.audioUrl, deletedUrls)] : []
}

/** The clip a Text-to-Speech Turn still running is making. */
export function pendingAudioArtifacts(
  id: string,
  kind: AudioTurnData['kind'],
  phase: AudioPhase | undefined,
): AudioArtifact[] {
  if (kind !== 'tts') return []
  return [clip(id, 'running', { phase: phase === 'loading-model' ? 'loading-model' : 'running' })]
}

const TTS_TOOL = 'synthesizeTextToSpeech'

type ToolPart = {
  toolCallId?: unknown
  state?: unknown
  output?: unknown
  errorText?: unknown
}

type ChatTtsOutput = {
  ok?: boolean
  message?: string
  savedFilePath?: string
  audioUrl?: string
}

/** Pi reports a tool's result as JSON text; a failed synthesis says why there. */
function agentFailure(output: unknown): string | undefined {
  const content = (output as { content?: { type?: string; text?: string }[] } | null)?.content
  const text = Array.isArray(content) ? content.find((item) => item.type === 'text')?.text : null
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; message?: unknown }
    return parsed.ok === false ? String(parsed.message ?? '') : undefined
  } catch {
    return undefined
  }
}

function settledToolClip(
  id: string,
  part: ToolPart,
  deletedUrls: readonly string[],
): AudioArtifact[] {
  const agentClip = generatedMediaOf(part)?.audio
  if (agentClip) {
    if (agentClip.url) return [savedClip(id, agentClip.url, deletedUrls)]
    return [
      clip(id, 'done', {
        filePath: agentClip.savedFilePath,
        workspacePath: agentClip.workspacePath,
        actions: ['download', 'openFolder'],
      }),
    ]
  }
  const output = (part.output ?? {}) as ChatTtsOutput
  const failure = output.ok === false ? (output.message ?? '') : agentFailure(part.output)
  if (failure !== undefined) return [clip(id, 'failed', failure ? { reason: failure } : {})]
  if (output.audioUrl) return [savedClip(id, output.audioUrl, deletedUrls)]
  if (output.savedFilePath) {
    return [
      clip(id, 'done', { filePath: output.savedFilePath, actions: ['download', 'openFolder'] }),
    ]
  }
  return []
}

/** A chat or agent Text-to-Speech tool call's clip, running, settled or failed. */
export function ttsToolArtifacts(part: unknown, deletedUrls: readonly string[]): AudioArtifact[] {
  if (toolPartNameOf(part) !== TTS_TOOL && !generatedMediaOf(part)?.audio) return []
  const tool = part as ToolPart
  const id = typeof tool.toolCallId === 'string' ? tool.toolCallId : TTS_TOOL
  if (tool.state === 'input-streaming' || tool.state === 'input-available') {
    return [clip(id, 'running', { phase: 'running' })]
  }
  if (tool.state === 'output-error') {
    return [
      clip(id, 'failed', typeof tool.errorText === 'string' ? { reason: tool.errorText } : {}),
    ]
  }
  return tool.state === 'output-available' ? settledToolClip(id, tool, deletedUrls) : []
}
