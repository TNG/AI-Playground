import path from 'node:path'
import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { appLoggerInstance as appLogger } from '../observability/logger.ts'

export type BackgroundTrayLabels = {
  show: string
  quit: string
  tooltip: string
}

const DEFAULT_LABELS: BackgroundTrayLabels = {
  show: 'Show AI Playground',
  quit: 'Quit',
  tooltip: 'AI Playground is running in the background',
}

let labels: BackgroundTrayLabels = DEFAULT_LABELS
const shownTrays = new Set<() => void>()

export function trayIconPath(platform: NodeJS.Platform, root: string, packaged: boolean): string {
  if (platform === 'win32') return path.join(root, packaged ? 'tray/app.ico' : 'app.ico')
  return path.join(root, packaged ? 'tray/icon.png' : 'build/icons/icon.png')
}

function loadIcon(iconPath: string) {
  const image = nativeImage.createFromPath(iconPath)
  // ICO carries its own small sizes; the 512px PNG would render at full size in a macOS menu bar.
  if (process.platform === 'win32' || image.isEmpty()) return image
  return image.resize({ width: process.platform === 'darwin' ? 18 : 24 })
}

export function setBackgroundTrayLabels(next: BackgroundTrayLabels) {
  labels = { ...DEFAULT_LABELS, ...next }
  for (const refresh of shownTrays) refresh()
}

/** Shows a tray icon only while the main window is hidden, so a backgrounded app can be reopened. */
export function bindBackgroundTray(win: BrowserWindow, iconPath: string) {
  let tray: Tray | null = null
  const reveal = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  const refresh = () => {
    if (!tray) return
    tray.setToolTip(labels.tooltip)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: labels.show, click: reveal },
        { type: 'separator' },
        { label: labels.quit, click: () => app.quit() },
      ]),
    )
  }
  const destroy = () => {
    shownTrays.delete(refresh)
    tray?.destroy()
    tray = null
  }
  const create = () => {
    if (tray) return
    try {
      tray = new Tray(loadIcon(iconPath))
    } catch (e) {
      appLogger.warn(`Background tray unavailable: ${e}`, 'electron-backend')
      return
    }
    tray.on('click', reveal)
    shownTrays.add(refresh)
    refresh()
  }
  win.on('hide', create)
  win.on('show', destroy)
  win.on('closed', destroy)
}
