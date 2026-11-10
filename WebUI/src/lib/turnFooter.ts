import type { UIMessage } from 'ai'
import type { AipgMetadata } from '@/assets/js/store/openAiCompatibleChat'
import { messageHasVisibleContent, messageText } from '@/lib/chatMessageText'
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

/** An agent Turn's Copy takes its answer, not the text it wrote between tool calls. */
export function agentFooter(
  answerText: string,
  assistant?: { answer: UIMessage | undefined; harnessTurn?: HarnessTurnRef; latest?: boolean },
): TurnFooter {
  if (!assistant) return { actions: answerText ? ['copy'] : [], text: answerText }
  const messageId = assistant.answer?.id
  const turn = assistant.harnessTurn
  const regenerate = !!assistant.latest && !!turn?.promptId && turn.turnIds.length > 0
  const actions: TurnFooterAction[] = [
    ...(answerText ? (['copy'] as const) : []),
    ...(answerText && messageId ? (['speak'] as const) : []),
    ...(regenerate ? (['regenerate'] as const) : []),
    ...(assistant.harnessTurn ? (['delete'] as const) : []),
  ]
  const metrics = answerMetrics(assistant.answer)
  return {
    actions,
    text: answerText,
    ...(messageId ? { messageId } : {}),
    ...(metrics ? { metrics } : {}),
    ...(assistant.harnessTurn ? { harnessTurn: assistant.harnessTurn } : {}),
  }
}

/** Regenerate redoes only the newest answer of a conversation, so only `last` offers it. */
export function chatAnswerFooter(answers: UIMessage[], last = false): TurnFooter {
  const answer = answers.at(-1)
  if (!answer || !answers.some(messageHasVisibleContent)) return noFooter()
  const text = answersText(answers)
  const actions: TurnFooterAction[] = [
    ...(text ? (['copy', 'speak'] as const) : []),
    ...(last ? (['regenerate'] as const) : []),
    'delete',
  ]
  const metrics = answerMetrics(answer)
  return { actions, text, messageId: answer.id, ...(metrics ? { metrics } : {}) }
}

export function audioFooter(audio: AudioTurnData): TurnFooter {
  const text = audio.kind === 'stt' ? (audio.transcript ?? '') : ''
  return { actions: text ? ['copy'] : [], text }
}
