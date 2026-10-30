import { z } from 'zod'
import { demoAwareStorage } from '../../demoAwareStorage'
import type { HeldAnswerJournal } from './answerRouter'
import { ChannelKindSchema } from './types'

const KEY = 'aipg.heldAnswerNotes'

const NotesSchema = z.array(
  z.object({
    channel: ChannelKindSchema,
    title: z.string(),
    meta: z
      .object({
        channel: z.string().optional(),
        ts: z.string().optional(),
        chatId: z.string().optional(),
        threadTs: z.string().optional(),
      })
      .optional(),
  }),
)

/**
 * Only the note that a Held Answer was lost: like the Turn Queue, which is not persisted so the
 * app never starts work by itself at launch (ADR 0002), the Answer itself is never kept.
 */
export const heldAnswerJournal: HeldAnswerJournal = {
  load: () => {
    const raw = demoAwareStorage.getItem(KEY)
    if (!raw) return []
    const parsed = NotesSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  },
  save: (notes) => {
    if (notes.length === 0) demoAwareStorage.removeItem(KEY)
    else demoAwareStorage.setItem(KEY, JSON.stringify(notes))
  },
}
