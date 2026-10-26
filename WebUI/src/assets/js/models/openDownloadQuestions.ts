import {
  modelDownloads,
  onModelDownloadStart,
  type ModelDownloadWaiter,
} from './modelDownloadQueue'

/** An unanswered Download Question, so a yes elsewhere that covers it can close it. */
export type OpenDownloadQuestion = {
  waiter: ModelDownloadWaiter
  models: DownloadModelParam[]
  join: (label: string) => void
}

const open = new Set<OpenDownloadQuestion>()

/** Keeps `question` closable while it is asked; returns the call that stops that. */
export function holdOpenDownloadQuestion(question: OpenDownloadQuestion): () => void {
  open.add(question)
  return () => open.delete(question)
}

/** Closes every other open Download Question the Model Downloads now queued fully cover. */
function closeCoveredQuestions(label: string, startedBy: string): void {
  for (const question of [...open]) {
    if (question.waiter.id === startedBy) continue
    if (modelDownloads().split(question.models).uncovered.length > 0) continue
    // Attached before the question hears it, so the download cannot end unseen in between.
    question.waiter.attach(question.models)
    open.delete(question)
    question.join(label)
  }
}

onModelDownloadStart(closeCoveredQuestions)

export function resetOpenDownloadQuestionsForTest(): void {
  open.clear()
}
