import { describe, expect, it } from 'vitest'
import { resolveNotificationChannel } from '@/lib/notificationChannel'

const ready = { enabled: true, verified: true }
const off = { enabled: false, verified: true }
const unverified = { enabled: true, verified: false }

describe('resolveNotificationChannel', () => {
  it('picks the first enabled and verified Channel in the order Telegram, Slack, LAN chat', () => {
    expect(resolveNotificationChannel({ telegram: ready, slack: ready, 'local-web': ready })).toBe(
      'telegram',
    )
    expect(resolveNotificationChannel({ telegram: off, slack: ready, 'local-web': ready })).toBe(
      'slack',
    )
    expect(resolveNotificationChannel({ telegram: unverified, 'local-web': ready })).toBe(
      'local-web',
    )
  })

  it('resolves nothing when no Channel is enabled and verified', () => {
    expect(resolveNotificationChannel({ telegram: off, slack: unverified })).toBeNull()
  })
})
