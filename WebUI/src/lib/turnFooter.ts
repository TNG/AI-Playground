import type { UIMessage } from 'ai'
import type { AipgMetadata } from '@/assets/js/store/openAiCompatibleChat'
import { messageHasVisibleContent, messageText } from '@/lib/chatMessageText'
import type { TurnFooter, TurnFooterAction } from '@/lib/turnTypes'
import type { AudioTurnData } from '@/types/sessionTimeline'

export function noFooter(): TurnFooter {
  return { actions: [], text: '' }
}

function answersText(answers: UIMessage[]): string {
  return answers.map(messageText).filter(Boolean).join('\n\n')
}

/** An agent Turn's Copy takes its answer, not the text it wrote between tool calls. */
export function agentFooter(answerText: string): TurnFooter {
  return { actions: answerText ? ['copy'] : [], text: answerText }
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
  const metadata = answer.metadata as AipgMetadata | undefined
  const metrics = metadata?.timings
    ? {
        timings: metadata.timings,
        ...(metadata.compute ? { compute: metadata.compute } : {}),
        ...(metadata.energy ? { energy: metadata.energy } : {}),
      }
    : undefined
  return { actions, text, messageId: answer.id, ...(metrics ? { metrics } : {}) }
}

export function audioFooter(audio: AudioTurnData): TurnFooter {
  const text = audio.kind === 'stt' ? (audio.transcript ?? '') : ''
  return { actions: text ? ['copy'] : [], text }
}
