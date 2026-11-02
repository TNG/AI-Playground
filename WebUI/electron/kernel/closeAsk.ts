import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import { typedSend } from './typedIpc'
import type { CloseAnswer } from './closeCoordinator'
import type { CloseAnswerPayload, CloseQuestion } from '@/types/lifecycleIpc'

const CLOSE_QUESTION_REFRESH_MS = 1000

const pending = new Map<string, (answer: CloseAnswer) => void>()
let openQuestion: { webContents: WebContents; requestId: string; question: CloseQuestion } | null =
  null

/** Asks the app's own dialog; a crashed or vanished window answers `no-window`. */
export function askWindowToClose(
  win: BrowserWindow | null,
  question: CloseQuestion,
): Promise<CloseAnswer> {
  if (!win || win.isDestroyed() || win.webContents.isCrashed()) {
    return Promise.resolve('no-window')
  }
  const { webContents } = win
  const requestId = randomUUID()
  return new Promise<CloseAnswer>((resolve) => {
    const gone = () => settle('no-window')
    const settle = (answer: CloseAnswer) => {
      pending.delete(requestId)
      if (openQuestion?.requestId === requestId) openQuestion = null
      webContents.removeListener('render-process-gone', gone)
      webContents.removeListener('destroyed', gone)
      resolve(answer)
    }
    webContents.once('render-process-gone', gone)
    webContents.once('destroyed', gone)
    pending.set(requestId, settle)
    openQuestion = { webContents, requestId, question }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    typedSend(webContents, 'lifecycle:askClose', { ...question, requestId })
  })
}

export function handleCloseAnswer(payload: CloseAnswerPayload): void {
  if (payload?.answer !== 'keep' && payload?.answer !== 'quit') return
  pending.get(payload.requestId)?.(payload.answer)
}

/**
 * A reloaded window has lost the dialog and its Schedule hold; its close bridge announces itself
 * and gets the open question again, or every later close would join a question nobody can answer.
 */
export function handleCloseBridgeReady(sender: WebContents): void {
  if (!openQuestion || openQuestion.webContents !== sender || sender.isDestroyed()) return
  typedSend(sender, 'lifecycle:holdSchedules', true)
  typedSend(sender, 'lifecycle:askClose', {
    ...openQuestion.question,
    requestId: openQuestion.requestId,
  })
}

export function showRefreshedCloseQuestion(question: CloseQuestion): void {
  if (!openQuestion || openQuestion.webContents.isDestroyed()) return
  openQuestion.question = question
  typedSend(openQuestion.webContents, 'lifecycle:closeQuestionChanged', {
    ...question,
    requestId: openQuestion.requestId,
  })
}

/** Calls `refresh` every second until the returned stop function runs. */
export function refreshWhileAsking(refresh: () => Promise<void>): () => void {
  const timer = setInterval(() => void refresh(), CLOSE_QUESTION_REFRESH_MS)
  return () => clearInterval(timer)
}

export function holdSchedules(win: BrowserWindow | null, held: boolean): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  typedSend(win.webContents, 'lifecycle:holdSchedules', held)
}
