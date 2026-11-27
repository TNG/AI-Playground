import { describe, expect, it } from 'vitest'
import { fanOutDownloadQuestion } from '@/assets/js/store/channels/downloadQuestionFanOut'
import type {
  ChannelQuestionOutcome,
  DownloadChannelQuestion,
} from '@/assets/js/permissions/remoteTurnPort'

type FakeQuestion = DownloadChannelQuestion & {
  name: string
  tap: (answer: boolean) => void
  retired: ChannelQuestionOutcome[]
  followed: Array<{ downloadId: string; answeredInApp?: boolean }>
}

function fakeQuestion(name: string): FakeQuestion {
  let tap: (answer: boolean) => void = () => {}
  const question: FakeQuestion = {
    name,
    answer: new Promise<boolean>((resolve) => (tap = resolve)),
    tap: (answer) => tap(answer),
    retired: [],
    followed: [],
    follow: (downloadId, options) => question.followed.push({ downloadId, ...options }),
    retire: (outcome) => question.retired.push(outcome),
  }
  return question
}

function askedOnEvery() {
  const telegram = fakeQuestion('telegram')
  const slack = fakeQuestion('slack')
  const question = fanOutDownloadQuestion([telegram, slack], (loser) =>
    loser.retire('answered-elsewhere'),
  )
  return { telegram, slack, question }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a download question asked on several Channels', () => {
  it('takes the first answer and retires it on the other Channels', async () => {
    const { telegram, slack, question } = askedOnEvery()
    slack.tap(true)
    telegram.tap(false)
    expect(await question.answer).toBe(true)
    expect(telegram.retired).toEqual(['answered-elsewhere'])
    expect(slack.retired).toEqual([])
  })

  it('retires the other Channels on a no as well', async () => {
    const { telegram, slack, question } = askedOnEvery()
    telegram.tap(false)
    expect(await question.answer).toBe(false)
    expect(slack.retired).toEqual(['answered-elsewhere'])
  })

  it('follows the download only on the Channel that answered', async () => {
    const { telegram, slack, question } = askedOnEvery()
    telegram.tap(true)
    await question.answer
    question.follow('dl-1')
    expect(telegram.followed).toEqual([{ downloadId: 'dl-1' }])
    expect(slack.followed).toEqual([])
  })

  it('follows a yes from the desktop on every Channel', async () => {
    const { telegram, slack, question } = askedOnEvery()
    question.follow('dl-2', { answeredInApp: true })
    expect(telegram.followed).toEqual([{ downloadId: 'dl-2', answeredInApp: true }])
    expect(slack.followed).toEqual([{ downloadId: 'dl-2', answeredInApp: true }])
  })

  it('retires every Channel when the desktop declines', async () => {
    const { telegram, slack, question } = askedOnEvery()
    question.retire('declined-in-app')
    expect(telegram.retired).toEqual(['declined-in-app'])
    expect(slack.retired).toEqual(['declined-in-app'])
  })

  it('never answers when asked on no Channel', async () => {
    const question = fanOutDownloadQuestion([], () => {})
    let answered = false
    void question.answer.then(() => (answered = true))
    await tick()
    expect(answered).toBe(false)
    question.follow('dl-3')
    question.retire('closed')
  })

  it('is the one Channel’s question when asked on one', () => {
    const telegram = fakeQuestion('telegram')
    expect(fanOutDownloadQuestion([telegram], () => {})).toBe(telegram)
  })
})
