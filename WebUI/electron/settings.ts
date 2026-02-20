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

/**
 * Load local settings from the packaged or development settings file, validate them against the schema, and update the in-memory settings.
 *
 * @returns The loaded and validated `LocalSettings` object; if the settings file is missing or cannot be parsed, returns the current in-memory settings (initialized from the schema defaults).
 */
export async function loadSettings(): Promise<LocalSettings> {
  const settingPath = app.isPackaged
    ? path.join(process.resourcesPath, 'settings.json')
    : path.join(__dirname, '../../external/settings-dev.json')

  appLogger.info(`loading settings from ${settingPath}`, 'electron-backend')
  if (fs.existsSync(settingPath)) {
    try {
      settings = LocalSettingsSchema.parse(
        JSON.parse(await fs.promises.readFile(settingPath, { encoding: 'utf8' })),
      )
    } catch (e) {
      appLogger.error(`failed to load settings: ${e}`, 'electron-backend')
    }
  }
  appLogger.info(`settings loaded: ${JSON.stringify({ settings })}`, 'electron-backend')

  return settings
}

/**
 * Retrieve the current in-memory local settings.
 *
 * @returns The current cached `LocalSettings` object
 */
export function getSettings(): LocalSettings {
  return settings
}

/**
 * Applies partial updates to the in-memory local settings.
 *
 * NOTE: This function is runtime-only — changes are NOT persisted to disk (settings.json).
 * Callers should be aware that updates will be lost after the application restarts.
 *
 * Modifies the cached settings object in-place and logs the updated fields.
 *
 * @param updates - Partial LocalSettings whose properties will be merged into the current settings
 */
export function updateSettings(updates: Partial<LocalSettings>): void {
  Object.assign(settings, updates)
  appLogger.info(`Updated local settings: ${JSON.stringify(updates)}`, 'electron-backend')
}
