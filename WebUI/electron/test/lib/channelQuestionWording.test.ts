import { afterEach, describe, expect, it } from 'vitest'
import {
  channelQuestionTemplates,
  registerChannelQuestionTemplates,
  type ChannelQuestionTemplates,
} from '../../../src/lib/channelQuestionWording'
import enUS from '../../../src/assets/i18n/en-US.json'

afterEach(() => registerChannelQuestionTemplates(null))

describe('channel question wording', () => {
  it('uses the registered locale wording and falls back to English for a missing line', () => {
    const english = channelQuestionTemplates()
    registerChannelQuestionTemplates(
      () =>
        ({
          ...english,
          askOne: '{label} muss ein Modell herunterladen, bevor es weitergehen kann:',
          stale: '',
        }) satisfies ChannelQuestionTemplates,
    )
    const text = channelQuestionTemplates()
    expect(text.askOne).toBe('{label} muss ein Modell herunterladen, bevor es weitergehen kann:')
    expect(text.stale).toBe(english.stale)
  })

  it('keeps its English fallback identical to the English locale', () => {
    const english = channelQuestionTemplates()
    const keys: Record<keyof ChannelQuestionTemplates, keyof typeof enUS> = {
      askOne: 'CHANNEL_QUESTION_DOWNLOAD_ONE',
      askMany: 'CHANNEL_QUESTION_DOWNLOAD_MANY',
      lookupFailed: 'CHANNEL_QUESTION_LOOKUP_FAILED',
      gated: 'CHANNEL_QUESTION_GATED',
      confirm: 'CHANNEL_QUESTION_CONFIRM',
      cancel: 'CHANNEL_QUESTION_CANCEL',
      confirmed: 'CHANNEL_QUESTION_CONFIRMED',
      cancelled: 'CHANNEL_QUESTION_CANCELLED',
      progress: 'CHANNEL_QUESTION_PROGRESS',
      complete: 'CHANNEL_QUESTION_COMPLETE',
      failed: 'CHANNEL_QUESTION_FAILED',
      answeredInApp: 'CHANNEL_QUESTION_ANSWERED_IN_APP',
      declinedInApp: 'CHANNEL_QUESTION_DECLINED_IN_APP',
      closed: 'CHANNEL_QUESTION_CLOSED',
      unavailable: 'CHANNEL_QUESTION_UNAVAILABLE',
      stale: 'CHANNEL_QUESTION_STALE',
      alreadyDownloading: 'CHANNEL_QUESTION_ALREADY_DOWNLOADING',
      alreadyDownloadingFor: 'CHANNEL_QUESTION_ALREADY_DOWNLOADING_FOR',
      cancelledInApp: 'CHANNEL_QUESTION_CANCELLED_IN_APP',
      appClosed: 'CHANNEL_QUESTION_APP_CLOSED',
      forChat: 'MODEL_DOWNLOAD_FOR_CHAT',
      forOther: 'MODEL_DOWNLOAD_FOR_OTHER',
      forHomeAgent: 'MODEL_DOWNLOAD_FOR_HOME_AGENT',
    }
    for (const [field, key] of Object.entries(keys)) {
      expect(english[field as keyof ChannelQuestionTemplates]).toBe(enUS[key])
    }
  })
})
