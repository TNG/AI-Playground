import { z } from 'zod'
import { demoAwareStorage } from '../../demoAwareStorage'
import type { HeldAnswerJournal } from './answerRouter'

const KEY = 'aipg.heldAnswerNotes'

const NotesSchema = z.array(
  z.object({
    channel: z.enum(['telegram', 'slack', 'discord', 'local-web']),
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

/** Held Answers themselves are never kept (ADR 0002); only the note that one was lost. */
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
