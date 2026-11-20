import { computed } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useSessionAudio } from '@/assets/js/store/sessionAudio'
import { isCancellation } from '@/assets/js/errors/appError'
import type { TurnFooter } from '@/lib/turnTypes'

/** Which store re-runs and deletes a turn. */
export type TurnOwner = 'media' | 'audio' | 'harness' | 'chat'

export function turnOwnerOf(footer: TurnFooter): TurnOwner {
  if (footer.rerun || footer.deletion?.owner === 'media') return 'media'
  if (footer.audioRerun || footer.deletion?.owner === 'audio') return 'audio'
  if (footer.harnessTurn) return 'harness'
  return 'chat'
}

/** An edit re-runs the turn from new prompt text; a chat turn also needs its prompt message. */
export type PromptEdit = { text: string; promptMessageId: string }

/** Regenerate, Edit and Delete of one turn, each dispatched to the store that owns it. */
export function useTurnActions(footer: () => TurnFooter) {
  const agentMode = useAgentMode()
  const errors = useErrors()
  const imageGeneration = useImageGenerationPresets()
  const openAiCompatibleChat = useOpenAiCompatibleChat()
  const sessionAudio = useSessionAudio()
  const languages = useI18N().state

  const owner = computed(() => turnOwnerOf(footer()))

  const busyBy: Record<TurnOwner, () => boolean> = {
    media: () => imageGeneration.processing,
    audio: () => sessionAudio.processing,
    harness: () => agentMode.isSessionProcessing(footer().harnessTurn?.harnessSessionId ?? ''),
    chat: () => openAiCompatibleChat.processing,
  }
  /** The owning store is mid-run. */
  const busy = computed(() => busyBy[owner.value]())

  // A delete or redo mid-run would race the settle that records the turn it takes out.
  const blocked = computed(() => openAiCompatibleChat.processing || busy.value)

  function report(error: unknown, code: string, userMessage?: string): void {
    if (isCancellation(error)) return
    errors.report(error, {
      category: 'generation',
      code,
      surface: 'toast',
      ...(userMessage ? { userMessage } : {}),
    })
  }

  async function regenerate(edit?: PromptEdit): Promise<void> {
    const current = footer()
    try {
      switch (owner.value) {
        case 'media':
          if (current.rerun)
            await imageGeneration.regenerate(
              edit ? { ...current.rerun, prompt: edit.text } : current.rerun,
            )
          return
        case 'audio':
          if (current.audioRerun)
            await sessionAudio.regenerate(
              edit ? { ...current.audioRerun, prompt: edit.text } : current.audioRerun,
            )
          return
        case 'harness':
          if (!current.harnessTurn) return
          if (edit) await agentMode.regenerateTurnWithPrompt(current.harnessTurn, edit.text)
          else await agentMode.regenerateTurn(current.harnessTurn)
          return
        case 'chat':
          if (!current.messageId) return
          // A no-op splice (text unchanged) still re-runs: Send says re-run.
          if (edit) openAiCompatibleChat.editPrompt(edit.promptMessageId, edit.text)
          await openAiCompatibleChat.regenerate(current.messageId)
      }
    } catch (error) {
      report(
        error,
        'generation/submit-failed',
        owner.value === 'media' ? languages.SESSION_IMAGE_GENERATION_FAILED : undefined,
      )
    }
  }

  async function remove(): Promise<void> {
    const current = footer()
    try {
      switch (owner.value) {
        case 'media':
          if (current.deletion) await imageGeneration.deleteTurn(current.deletion)
          return
        case 'audio':
          if (current.deletion) await sessionAudio.deleteTurn(current.deletion)
          return
        case 'harness':
          if (current.harnessTurn) await agentMode.deleteTurns(current.harnessTurn)
          return
        case 'chat':
          if (current.messageId) await openAiCompatibleChat.removeMessage(current.messageId)
      }
    } catch (error) {
      report(error, 'generation/delete-turn-failed')
    }
  }

  return { busy, blocked, regenerate, remove }
}
