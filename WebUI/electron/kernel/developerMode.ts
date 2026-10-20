import { app } from 'electron'

let showDebugSettingsInUI: () => boolean = () => false

export function setDeveloperModeSettings(read: () => boolean): void {
  showDebugSettingsInUI = read
}

/** Running from source, or settings.json opts this machine into the debug controls. */
export function isDeveloperMode(): boolean {
  return !app.isPackaged || showDebugSettingsInUI()
}
