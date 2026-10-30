import { describe, expect, it } from 'vitest'
import { hashDemoPasscode, verifyDemoPasscode } from '@/lib/demoPasscode'

describe('demo passcode', () => {
  it('verifies the passcode it hashed', async () => {
    const stored = await hashDemoPasscode('open sesame')
    expect(stored).toMatch(/^pbkdf2\$\d+\$[^$]+\$[^$]+$/)
    expect(stored).not.toContain('open sesame')
    expect(await verifyDemoPasscode('open sesame', stored)).toBe(true)
  })

  it('rejects a wrong passcode against a hashed value', async () => {
    const stored = await hashDemoPasscode('open sesame')
    expect(await verifyDemoPasscode('open sesam', stored)).toBe(false)
    expect(await verifyDemoPasscode('', stored)).toBe(false)
  })

  it('verifies a hand-written PBKDF2-SHA256 value', async () => {
    const stored =
      'pbkdf2$1000$MDEyMzQ1Njc4OWFiY2RlZg==$lthrw4diKhMqjsP6Pb8Ut8JakDM53i2wZ0MKCGR8gn4='
    expect(await verifyDemoPasscode('1234', stored)).toBe(true)
    expect(await verifyDemoPasscode('12345', stored)).toBe(false)
  })

  it('salts each hash differently', async () => {
    expect(await hashDemoPasscode('1234')).not.toBe(await hashDemoPasscode('1234'))
  })

  it('compares a legacy plain-text value as plain text', async () => {
    expect(await verifyDemoPasscode('1234', '1234')).toBe(true)
    expect(await verifyDemoPasscode('12345', '1234')).toBe(false)
  })

  it.each([
    'pbkdf2$',
    'pbkdf2$1000$MDEyMzQ1Njc4OWFiY2RlZg==',
    'pbkdf2$abc$MDEyMzQ1Njc4OWFiY2RlZg==$lthrw4diKhMqjsP6Pb8Ut8JakDM53i2wZ0MKCGR8gn4=',
    'pbkdf2$0$MDEyMzQ1Njc4OWFiY2RlZg==$lthrw4diKhMqjsP6Pb8Ut8JakDM53i2wZ0MKCGR8gn4=',
    'pbkdf2$1000$not base64!$lthrw4diKhMqjsP6Pb8Ut8JakDM53i2wZ0MKCGR8gn4=',
    'pbkdf2$1000$MDEyMzQ1Njc4OWFiY2RlZg==$c2hvcnQ=',
    'pbkdf2$1000$MDEyMzQ1Njc4OWFiY2RlZg==$lthrw4diKhMqjsP6Pb8Ut8JakDM53i2wZ0MKCGR8gn4=$extra',
  ])('fails closed on malformed hashed value %s', async (stored) => {
    expect(await verifyDemoPasscode('1234', stored)).toBe(false)
    expect(await verifyDemoPasscode(stored, stored)).toBe(false)
  })
})
