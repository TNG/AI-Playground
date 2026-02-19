import { app } from 'electron'
import fs from 'fs'
import path from 'node:path'
import z from 'zod'
import { appLoggerInstance } from './logging/logger.ts'

const appLogger = appLoggerInstance

const ThemeSchema = z.enum(['dark', 'lnl', 'bmg', 'light'])
const LocalSettingsSchema = z.object({
  debug: z.boolean().default(false),
  deviceArchOverride: z.enum(['bmg', 'acm', 'arl_h', 'lnl', 'mtl']).nullable().default(null),
  enablePreviewFeatures: z.boolean().default(false),
  isAdminExec: z.boolean().default(false),
  availableThemes: z.array(ThemeSchema).default(['dark', 'lnl', 'bmg', 'light']),
  currentTheme: ThemeSchema.default('bmg'),
  isDemoModeEnabled: z.boolean().default(false),
  demoModeResetInSeconds: z.number().min(1).nullable().default(null),
  languageOverride: z.string().nullable().default(null),
  remoteRepository: z.string().default('intel/ai-playground'),
  huggingfaceEndpoint: z.string().default('https://huggingface.co'),
})

export type LocalSettings = z.infer<typeof LocalSettingsSchema>

let settings = LocalSettingsSchema.parse({})

export async function loadSettings(): Promise<LocalSettings> {
  const settingPath = app.isPackaged
    ? path.join(process.resourcesPath, 'settings.json')
    : path.join(__dirname, '../../external/settings-dev.json')

  appLogger.info(`loading settings from ${settingPath}`, 'electron-backend')
  if (fs.existsSync(settingPath)) {
    try {
      settings = LocalSettingsSchema.parse(
        JSON.parse(fs.readFileSync(settingPath, { encoding: 'utf8' })),
      )
    } catch (e) {
      appLogger.error(`failed to load settings: ${e}`, 'electron-backend')
    }
  }
  appLogger.info(`settings loaded: ${JSON.stringify({ settings })}`, 'electron-backend')

  return settings
}

export function getSettings(): LocalSettings {
  return settings
}

export function updateSettings(updates: Partial<LocalSettings>): void {
  Object.assign(settings, updates)
  appLogger.info(`Updated local settings: ${JSON.stringify(updates)}`, 'electron-backend')
}

