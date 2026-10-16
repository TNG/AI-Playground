import { EventEmitter } from 'node:events'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type MenuItem = { label?: string; click?: () => void; type?: string }

const trays: FakeTray[] = []
const quit = vi.fn()

type FakeTray = EventEmitter & {
  destroyed: boolean
  tooltip: string
  menu: MenuItem[]
  destroy: () => void
  setToolTip: (t: string) => void
  setContextMenu: (m: MenuItem[]) => void
}

vi.mock('electron', () => ({
  app: { quit: () => quit() },
  Menu: { buildFromTemplate: (items: MenuItem[]) => items },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => false, resize: () => ({ isEmpty: () => false }) }),
  },
  Tray: function Tray(this: FakeTray) {
    const tray = Object.assign(new EventEmitter(), {
      destroyed: false,
      tooltip: '',
      menu: [] as MenuItem[],
      destroy: () => {
        tray.destroyed = true
      },
      setToolTip: (t: string) => {
        tray.tooltip = t
      },
      setContextMenu: (m: MenuItem[]) => {
        tray.menu = m
      },
    })
    trays.push(tray)
    return tray
  },
}))

vi.mock('../../observability/logger.ts', () => ({ appLoggerInstance: { warn: vi.fn() } }))

const { bindBackgroundTray, setBackgroundTrayLabels, trayIconPath } =
  await import('../../adapters/backgroundTray')

function fakeWindow() {
  const win = Object.assign(new EventEmitter(), {
    visible: true,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    focus: vi.fn(),
    show: () => {
      win.visible = true
      win.emit('show')
    },
    hide: () => {
      win.visible = false
      win.emit('hide')
    },
  })
  return win
}

describe('backgroundTray', () => {
  beforeEach(() => {
    trays.length = 0
    quit.mockReset()
  })

  it('exists only while the window is hidden', () => {
    const win = fakeWindow()
    bindBackgroundTray(win as never, '/icon.png')
    expect(trays).toHaveLength(0)
    win.hide()
    expect(trays).toHaveLength(1)
    expect(trays[0].destroyed).toBe(false)
    win.show()
    expect(trays[0].destroyed).toBe(true)
  })

  it('reopens the window from a click or the menu, and quits from the menu', () => {
    const win = fakeWindow()
    bindBackgroundTray(win as never, '/icon.png')
    win.hide()
    trays[0].emit('click')
    expect(win.visible).toBe(true)
    expect(win.focus).toHaveBeenCalled()

    win.hide()
    const [show, , quitItem] = trays[1].menu
    show.click?.()
    expect(win.visible).toBe(true)

    win.hide()
    trays[2].menu[2].click?.()
    expect(quit).toHaveBeenCalledOnce()
    expect(quitItem.label).toBe(trays[2].menu[2].label)
  })

  it('applies localized labels, including to a tray already shown', () => {
    const win = fakeWindow()
    bindBackgroundTray(win as never, '/icon.png')
    win.hide()
    setBackgroundTrayLabels({ show: 'Anzeigen', quit: 'Beenden', tooltip: 'Läuft im Hintergrund' })
    expect(trays[0].tooltip).toBe('Läuft im Hintergrund')
    expect(trays[0].menu.map((m) => m.label)).toEqual(['Anzeigen', undefined, 'Beenden'])
  })

  it('resolves the icon per platform and install layout', () => {
    expect(trayIconPath('win32', '/res', true)).toBe(path.join('/res', 'tray/app.ico'))
    expect(trayIconPath('win32', '/webui', false)).toBe(path.join('/webui', 'app.ico'))
    expect(trayIconPath('linux', '/res', true)).toBe(path.join('/res', 'tray/icon.png'))
    expect(trayIconPath('darwin', '/webui', false)).toBe(
      path.join('/webui', 'build/icons/icon.png'),
    )
  })
})
