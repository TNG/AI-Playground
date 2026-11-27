import type { UIMessage } from 'ai'
import type { AipgMetadata } from '@/assets/js/store/openAiCompatibleChat'
import { messageHasVisibleContent, messageText } from '@/lib/chatMessageText'
import { isHarnessChatPreset } from '@/lib/harnessChatPreset'
import type { HarnessTurnRef, TurnFooter, TurnFooterAction, TurnMetrics } from '@/lib/turnTypes'
import type { AudioTurnData } from '@/types/sessionTimeline'

export function noFooter(): TurnFooter {
  return { actions: [], text: '' }
}

function answersText(answers: UIMessage[]): string {
  return answers.map(messageText).filter(Boolean).join('\n\n')
}

function answerMetrics(answer: UIMessage | undefined): TurnMetrics | undefined {
  const metadata = answer?.metadata as AipgMetadata | undefined
  if (!metadata?.timings) return undefined
  return {
    timings: metadata.timings,
    ...(metadata.compute ? { compute: metadata.compute } : {}),
    ...(metadata.energy ? { energy: metadata.energy } : {}),
  }
}

/** The harness turns an Assistant Turn's answers came from, as main stamped them. */
export function harnessTurnIds(answers: UIMessage[]): string[] {
  return answers.flatMap((answer) => {
    const id = (answer.metadata as { harnessTurnId?: unknown } | undefined)?.harnessTurnId
    return typeof id === 'string' ? [id] : []
  })
}

/**
 * An agent Turn's Copy takes its answer, not the text it wrote between tool
 * calls. Regenerate and Delete reach only the newest turn; Speak stays
 * with the chat-affordance presets. A turn that ran with the host shell
 * keeps only Copy and Speak: its workspace cannot be rolled back.
 */
export function agentFooter(
  answerText: string,
  assistant?: {
    answer: UIMessage | undefined
    harnessTurn?: HarnessTurnRef
    latest?: boolean
    canSpeak?: boolean
  },
): TurnFooter {
  if (!assistant) return { actions: answerText ? ['copy'] : [], text: answerText }
  const messageId = assistant.answer?.id
  const turn = assistant.harnessTurn
  const latest = !!assistant.latest
  const hostShell =
    (assistant.answer?.metadata as { hostShell?: unknown } | undefined)?.hostShell === true
  const regenerate = latest && !hostShell && !!turn?.promptId && turn.turnIds.length > 0
  // Without a turn marker the answer cannot be taken out of what the model sees.
  const deletable =
    latest && !hostShell && !!turn && (turn.turnIds.length > 0 || turn.messageIds.length <= 1)
  const actions: TurnFooterAction[] = [
    ...(answerText ? (['copy'] as const) : []),
    ...(answerText && messageId && assistant.canSpeak ? (['speak'] as const) : []),
    ...(regenerate ? (['regenerate'] as const) : []),
    ...(deletable ? (['delete'] as const) : []),
  ]
  // The affordance presets carry the answer's metrics too; the agent footer
  // of the games presets stays lean.
  const metrics = assistant.canSpeak ? answerMetrics(assistant.answer) : undefined
  return {
    actions,
    text: answerText,
    ...(messageId ? { messageId } : {}),
    ...(metrics ? { metrics } : {}),
    ...(assistant.harnessTurn ? { harnessTurn: assistant.harnessTurn } : {}),
  }
}

/** Regenerate and Delete only reach the newest answer of a conversation, so only `last` offers them. */
export function chatAnswerFooter(answers: UIMessage[], last = false): TurnFooter {
  const answer = answers.at(-1)
  if (!answer || !answers.some(messageHasVisibleContent)) return noFooter()
  const text = answersText(answers)
  // Assistant's chat-engine turns are replayed into its Harness Session, out of Delete's reach.
  const replayed = answers.some((message) =>
    isHarnessChatPreset((message.metadata as { preset?: string } | undefined)?.preset),
  )
  const actions: TurnFooterAction[] = [
    ...(text ? (['copy', 'speak'] as const) : []),
    ...(last ? (['regenerate'] as const) : []),
    ...(last && !replayed ? (['delete'] as const) : []),
  ]
  const metrics = answerMetrics(answer)
  return { actions, text, messageId: answer.id, ...(metrics ? { metrics } : {}) }
}

export function audioFooter(audio: AudioTurnData): TurnFooter {
  const text = audio.kind === 'stt' ? (audio.transcript ?? '') : ''
  return { actions: text ? ['copy'] : [], text }
}
