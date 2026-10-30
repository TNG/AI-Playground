import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalSettingsSchema, type LocalSettings } from '../kernel/localSettings'

/** Validates and writes the settings file atomically; throws when it cannot. */
export function writeLocalSettingsFile(settingPath: string, settings: LocalSettings): void {
  const serialized = JSON.stringify(LocalSettingsSchema.parse(settings), null, 2)
  const tmpPath = `${settingPath}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(path.dirname(settingPath), { recursive: true })
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8' })
    fs.renameSync(tmpPath, settingPath)
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // ignore cleanup failure
    }
    throw e
  }
}
