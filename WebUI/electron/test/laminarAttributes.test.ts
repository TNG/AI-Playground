import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
    getAppPath: () => '/tmp',
  },
}))

const { stampSpanStart, setChatTraceContext } = await import('../laminarAttributes.ts')

const HOST = 'lmnr.association.properties.metadata.hostname'
const DEVICE = 'lmnr.association.properties.metadata.device'
const DEVICE_NAME = 'lmnr.association.properties.metadata.deviceName'

describe('stampSpanStart', () => {
  afterEach(() => setChatTraceContext(null))

  it('stamps hostname even without a turn context', () => {
    const span = { attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.attributes[HOST]).toBe(os.hostname())
  })

  it('stamps device id and name from the chat context', () => {
    setChatTraceContext({
      backend: 'llamaCPP',
      device: 'GPU.0',
      deviceName: 'Intel Arc B580',
    })
    const span = { name: 'ai.streamText', attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.attributes[HOST]).toBe(os.hostname())
    expect(span.attributes[DEVICE]).toBe('GPU.0')
    expect(span.attributes[DEVICE_NAME]).toBe('Intel Arc B580')
  })
})
