import { describe, expect, it } from 'vitest'
import {
  usableNotificationChannels,
  canDeliverNotifications,
  resolveNotificationChannel,
} from '@/lib/notificationChannel'

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
    expect(resolveNotificationChannel({ telegram: off }, 'telegram')).toBeNull()
  })

  it('uses the chosen Channel while it is enabled and verified', () => {
    expect(resolveNotificationChannel({ telegram: ready, slack: ready }, 'slack')).toBe('slack')
    expect(resolveNotificationChannel({ telegram: ready, 'local-web': ready }, 'local-web')).toBe(
      'local-web',
    )
  })

  it('falls back to the default order when the chosen Channel is disabled or unverified', () => {
    expect(
      resolveNotificationChannel({ telegram: ready, slack: off, 'local-web': ready }, 'slack'),
    ).toBe('telegram')
    expect(
      resolveNotificationChannel({ telegram: off, slack: unverified, 'local-web': ready }, 'slack'),
    ).toBe('local-web')
  })

  it('never resolves a Channel Notifications do not support', () => {
    expect(resolveNotificationChannel({ discord: ready, slack: ready }, 'discord')).toBe('slack')
  })
})

describe('usableNotificationChannels', () => {
  it('lists only enabled and verified Channels, in default order', () => {
    expect(
      usableNotificationChannels({
        'local-web': ready,
        telegram: ready,
        slack: off,
        discord: ready,
      }),
    ).toEqual(['telegram', 'local-web'])
    expect(usableNotificationChannels({ telegram: unverified })).toEqual([])
  })
})

describe('canDeliverNotifications', () => {
  it('needs Home Agent on and a Notification Channel', () => {
    expect(canDeliverNotifications({ homeAgentEnabled: true, notificationChannel: 'slack' })).toBe(
      true,
    )
    expect(canDeliverNotifications({ homeAgentEnabled: false, notificationChannel: 'slack' })).toBe(
      false,
    )
    expect(canDeliverNotifications({ homeAgentEnabled: true, notificationChannel: null })).toBe(
      false,
    )
  })
})
