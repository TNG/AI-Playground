import type { DownloadChannelQuestion } from '@/assets/js/permissions/remoteTurnPort'

/**
 * One download question asked on several Channels: the first tap wins and `retireLoser` takes
 * the buttons away everywhere else; a desktop answer follows or retires it on every Channel.
 */
export function fanOutDownloadQuestion(
  questions: DownloadChannelQuestion[],
  retireLoser: (question: DownloadChannelQuestion) => void,
): DownloadChannelQuestion {
  if (questions.length === 1) return questions[0]
  let winner: DownloadChannelQuestion | null = null
  const answer =
    questions.length === 0
      ? new Promise<boolean>(() => {})
      : Promise.race(
          questions.map((question) => question.answer.then((tap) => ({ question, tap }))),
        ).then(({ question, tap }) => {
          winner = question
          for (const other of questions) if (other !== question) retireLoser(other)
          return tap
        })
  return {
    answer,
    follow: (downloadId, options) => {
      for (const question of winner ? [winner] : questions) question.follow(downloadId, options)
    },
    retire: (outcome) => {
      for (const question of questions) question.retire(outcome)
    },
  }
}
