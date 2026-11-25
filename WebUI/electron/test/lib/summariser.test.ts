import { describe, expect, it } from 'vitest'
import { summaryModelConfig } from '@/lib/summariser'
import type { ChatModelConfig } from '@/types/chatIpc'

// The summary is a short extraction, not a problem to reason through: the model
// config it runs with must not carry the chat's thinking switch or effort.

const MODEL: ChatModelConfig = {
  backend: 'llamaCPP',
  modelId: 'qwen-test',
  readiness: { serviceName: 'llamacpp-backend', llmModelName: 'qwen-test' },
  chatTemplateKwargs: {
    enable_thinking: true,
    reasoning_effort: 'medium',
    keep: 'this',
  },
  temperature: 0.7,
}

describe('summaryModelConfig', () => {
  it('turns thinking off and drops the reasoning effort', () => {
    const summary = summaryModelConfig(MODEL)

    expect(summary.chatTemplateKwargs).toEqual({ enable_thinking: false, keep: 'this' })
    expect(summary.temperature).toBe(0.7)
  })

  it('leaves the chat model it was given untouched', () => {
    summaryModelConfig(MODEL)

    expect(MODEL.chatTemplateKwargs).toEqual({
      enable_thinking: true,
      reasoning_effort: 'medium',
      keep: 'this',
    })
  })

  it('turns thinking off when the model carried only a reasoning effort', () => {
    const withoutSwitch: ChatModelConfig = {
      ...MODEL,
      chatTemplateKwargs: { reasoning_effort: 'high', keep: 'this' },
    }

    expect(summaryModelConfig(withoutSwitch).chatTemplateKwargs).toEqual({
      enable_thinking: false,
      keep: 'this',
    })
  })

  it('explicitly turns thinking off when the turn carried no thinking kwargs', () => {
    const plain: ChatModelConfig = { ...MODEL, chatTemplateKwargs: undefined }

    expect(summaryModelConfig(plain).chatTemplateKwargs).toEqual({ enable_thinking: false })
    expect(plain.chatTemplateKwargs).toBeUndefined()
  })
})
