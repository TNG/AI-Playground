import path from 'node:path'
import fs from 'node:fs'
import { UvPythonBackendService } from './uvPythonBackendService.ts'
import { app, net, safeStorage } from 'electron'

export class HomeAgentBackendService extends UvPythonBackendService {
  readonly serviceFolder = 'home-agent'
  readonly isRequired = false

  async setUpstreamUrl(url: string): Promise<void> {
    try {
      await net.fetch(`${this.baseUrl}/set-upstream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
    } catch (e) {
      this.appLogger.warn(`Failed to set upstream URL for home-agent: ${e}`, this.name)
    }
  }

  private readTelegramConfig(): { token: string; chatId: string } | null {
    try {
      const configPath = path.join(app.getPath('userData'), 'home-agent-config.json')
      const raw = fs.readFileSync(configPath, 'utf-8')
      const data = JSON.parse(raw) as { encryptedToken: { type: string; data: number[] }; chatId: string }
      const buf = Buffer.from(data.encryptedToken.data)
      const token = safeStorage.decryptString(buf)
      return { token, chatId: data.chatId ?? '' }
    } catch {
      return null
    }
  }

  protected override extraProcessEnv(): Record<string, string | undefined> {
    const telegramConfig = this.readTelegramConfig()
    if (!telegramConfig?.token) return {}
    return {
      TELEGRAM_BOT_TOKEN: telegramConfig.token,
      ...(telegramConfig.chatId ? { TELEGRAM_CHAT_ID: telegramConfig.chatId } : {}),
    }
  }
}
