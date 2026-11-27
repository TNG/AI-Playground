import { describe, expect, it } from 'vitest'
import { markdownToTelegramHtml } from '@/lib/telegramMarkdown'
import { markdownToSlackMrkdwn } from '@/lib/slackMrkdwn'

describe('markdownToTelegramHtml', () => {
  it('turns bold, code and links into Telegram HTML and escapes the rest', () => {
    expect(markdownToTelegramHtml('**hi** `x` [a](https://e.com) <b>')).toBe(
      '<b>hi</b> <code>x</code> <a href="https://e.com">a</a> &lt;b&gt;',
    )
  })
})

describe('markdownToSlackMrkdwn', () => {
  it('turns bold and links into Slack mrkdwn', () => {
    expect(markdownToSlackMrkdwn('**hi** [a](https://e.com)')).toBe('*hi* <https://e.com|a>')
  })
})
