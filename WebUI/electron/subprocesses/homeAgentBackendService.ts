import path from 'node:path'
import fs from 'node:fs'
import { app, ipcMain, net, safeStorage } from 'electron'
import { UvPythonBackendService } from './uvPythonBackendService.ts'
import { getMediaDir } from '../util.ts'

type EncryptedTokenData = { type: string; data: number[] }
type HomeAgentConfigFile = { encryptedToken: EncryptedTokenData; chatId: string }

export class HomeAgentBackendService extends UvPythonBackendService {
  readonly serviceFolder = 'home-agent'
  readonly isRequired = false

  // ── Config path ──────────────────────────────────────────────────────────

  private configPath(): string {
    return path.join(app.getPath('userData'), 'home-agent-config.json')
  }

  // ── Config persistence ───────────────────────────────────────────────────

  saveConfig(token: string, chatId: string): { success: boolean; error?: string } {
    try {
      const cleanToken = token.trim().replace(/\s+/g, '')
      const cleanChatId = chatId.trim()
      const encrypted = safeStorage.encryptString(cleanToken)
      const data: HomeAgentConfigFile = { encryptedToken: encrypted.toJSON(), chatId: cleanChatId }
      fs.writeFileSync(this.configPath(), JSON.stringify(data), 'utf-8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  loadConfig(): { token: string; chatId: string } | null {
    try {
      const raw = fs.readFileSync(this.configPath(), 'utf-8')
      const data = JSON.parse(raw) as HomeAgentConfigFile
      const buf = Buffer.from(data.encryptedToken.data)
      const token = safeStorage.decryptString(buf)
      return { token, chatId: data.chatId ?? '' }
    } catch {
      return null
    }
  }

  clearConfig(): void {
    try {
      fs.unlinkSync(this.configPath())
    } catch {
      // ignore if not found
    }
  }

  // ── Telegram helpers ─────────────────────────────────────────────────────

  async testTelegram(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.loadConfig()
      if (!config) return { success: false, error: 'No config saved' }
      const { token, chatId } = config
      const res = await net.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          parse_mode: 'HTML',
          text:
            '✅ <b>Home Agent is connected!</b>\n\n' +
            'Send me any message — the AI will decide whether to reply with text or generate an image.\n' +
            'Use /help to see all explicit command overrides.',
        }),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async injectToken(token: string, chatId?: string | number): Promise<{ status: string }> {
    if (this.currentStatus !== 'running') return { status: 'not_running' }
    try {
      const clean = token.trim().replace(/\s+/g, '')
      const cleanedChatId = chatId !== undefined ? String(chatId).trim() : undefined
      const res = await net.fetch(`${this.baseUrl}/set-telegram-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: clean, ...(cleanedChatId ? { chatId: cleanedChatId } : {}) }),
      })
      const body = (await res.json()) as { status?: string }
      return { status: body.status ?? 'ok' }
    } catch (e) {
      return { status: `error: ${e}` }
    }
  }

  async flushPending(): Promise<void> {
    if (this.currentStatus !== 'running') return
    try {
      await net.fetch(`${this.baseUrl}/flush-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    } catch {
      // ignore
    }
  }

  async pollTelegram(): Promise<Array<{ text: string; chat_id: string }>> {
    if (this.currentStatus !== 'running') return []
    try {
      const res = await net.fetch(`${this.baseUrl}/poll-telegram`)
      return (await res.json()) as Array<{ text: string; chat_id: string }>
    } catch {
      return []
    }
  }

  async sendTelegramPhoto(
    imageBase64: string,
    caption?: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/send-telegram-photo`
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo: imageBase64, caption: caption ?? '' }),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      this.appLogger.error(`sendTelegramPhoto error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  async sendTelegramReply(
    text: string,
    parseMode?: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/send-telegram-reply`
      this.appLogger.info(`sendTelegramReply posting to ${url}: "${text.slice(0, 80)}"`, this.name)
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
      })
      this.appLogger.info(`sendTelegramReply response: status=${res.status}`, this.name)
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      this.appLogger.error(`sendTelegramReply error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  // ── Chat ID detection ────────────────────────────────────────────────────

  private async detectChatIdWithToken(
    token: string,
  ): Promise<{ chatId: string } | { error: string }> {
    try {
      const cleanToken = token.trim().replace(/\s+/g, '')
      this.appLogger.info(
        `detectChatId token length=${cleanToken.length} preview="${cleanToken.slice(0, 10)}..."`,
        this.name,
      )
      const meRes = await net.fetch(`https://api.telegram.org/bot${cleanToken}/getMe`)
      const meBody = await meRes.text()
      this.appLogger.info(
        `detectChatId getMe status=${meRes.status} body=${meBody.slice(0, 200)}`,
        this.name,
      )
      if (!meRes.ok) {
        let msg = 'Invalid bot token. Copy it again from BotFather.'
        try {
          const parsed = JSON.parse(meBody) as { description?: string }
          if (parsed.description) msg = `Telegram error: ${parsed.description}`
        } catch {
          /* ignore */
        }
        return { error: `${msg} (token length: ${cleanToken.length})` }
      }
      if (this.currentStatus === 'running') {
        try {
          const chatRes = await net.fetch(`${this.baseUrl}/get-chat-id`)
          const data = (await chatRes.json()) as { chatId?: string; error?: string }
          this.appLogger.info(`detectChatId /get-chat-id returned chatId=${data.chatId}`, this.name)
          if (data.chatId) return { chatId: data.chatId }
        } catch {
          /* fall through */
        }
      }
      return { error: 'No messages received yet. Send any message to your bot, then try again.' }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async detectChatId(token: string): Promise<{ chatId: string } | { error: string }> {
    if (this.currentStatus === 'running') {
      try {
        const res = await net.fetch(`${this.baseUrl}/get-chat-id`)
        const data = (await res.json()) as { chatId?: string; error?: string }
        if (data.chatId) return { chatId: data.chatId }
      } catch {
        /* fall through */
      }
    }
    return this.detectChatIdWithToken(token)
  }

  async detectChatIdFromSaved(): Promise<{ chatId: string } | { error: string }> {
    if (this.currentStatus === 'running') {
      try {
        const res = await net.fetch(`${this.baseUrl}/get-chat-id`)
        const data = (await res.json()) as { chatId?: string; error?: string }
        if (data.chatId) return { chatId: data.chatId }
      } catch {
        /* fall through */
      }
    }
    const config = this.loadConfig()
    if (!config) return { error: 'Could not read saved config' }
    return this.detectChatIdWithToken(config.token)
  }

  // ── Upstream URL ─────────────────────────────────────────────────────────

  async setUpstreamUrl(url: string): Promise<void> {
    try {
      const res = await net.fetch(`${this.baseUrl}/set-upstream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`set-upstream returned ${res.status}: ${body}`)
      }
    } catch (e) {
      this.appLogger.warn(`Failed to set upstream URL for home-agent: ${e}`, this.name)
    }
  }

  notifyUpstreamReady(baseUrl: string): void {
    if (this.currentStatus === 'running') {
      void this.setUpstreamUrl(baseUrl)
    }
  }

  // ── Process env (used on spawn) ──────────────────────────────────────────

  protected override extraProcessEnv(): Record<string, string | undefined> {
    // Never pass TELEGRAM_* into the subprocess: web_api.py would start polling from env while
    // the renderer also POSTs /set-telegram-token → two concurrent getUpdates → Telegram 409 Conflict.
    // The token is injected via the /set-telegram-token endpoint after startup.
    return {}
  }


  async readImageAsBase64(imageUrl: string): Promise<string> {
    const mediaDir = getMediaDir()
    let filePath: string
    if (imageUrl.startsWith('aipg-media://')) {
      const decoded = decodeURIComponent(imageUrl.replace(/^aipg-media:\/\//i, ''))
      filePath = path.normalize(path.join(mediaDir, decoded).replace(/(\/|\\)$/, ''))
    } else {
      // HTTP URL from ComfyUI — extract filename/subfolder from query params
      const parsed = new URL(imageUrl)
      const subfolder = parsed.searchParams.get('subfolder') ?? ''
      const filename = parsed.searchParams.get('filename') ?? ''
      filePath = path.join(mediaDir, subfolder, filename)
    }
    const buf = await fs.promises.readFile(filePath)
    return buf.toString('base64')
  }

  async sendTelegramKeyboard(opts: {
    text: string
    parseMode?: string
    buttons: Array<Array<{ text: string; callbackData: string }>>
  }): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/send-telegram-keyboard`
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      this.appLogger.error(`sendTelegramKeyboard error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  // ── IPC registration ─────────────────────────────────────────────────────

  registerIpcHandlers(): void {
    ipcMain.handle('homeAgent:saveConfig', (_event, token: string, chatId: string) =>
      this.saveConfig(token, chatId),
    )
    ipcMain.handle('homeAgent:loadConfig', () => this.loadConfig())
    ipcMain.handle('homeAgent:clearConfig', () => this.clearConfig())
    ipcMain.handle('homeAgent:testTelegram', () => this.testTelegram())
    ipcMain.handle('homeAgent:injectToken', (_event, token: string, chatId?: string) =>
      this.injectToken(token, chatId),
    )
    ipcMain.handle('homeAgent:detectChatId', (_event, token: string) => this.detectChatId(token))
    ipcMain.handle('homeAgent:detectChatIdFromSaved', () => this.detectChatIdFromSaved())
    ipcMain.handle('homeAgent:pollTelegram', () => this.pollTelegram())
    ipcMain.handle('homeAgent:flushPending', () => this.flushPending())
    ipcMain.handle('homeAgent:sendTelegramReply', (_event, text: string, parseMode?: string) =>
      this.sendTelegramReply(text, parseMode),
    )
    ipcMain.handle('homeAgent:sendTelegramPhoto', (_event, imageBase64: string, caption?: string) =>
      this.sendTelegramPhoto(imageBase64, caption),
    )
    ipcMain.handle(
      'homeAgent:sendTelegramKeyboard',
      (
        _event,
        opts: {
          text: string
          parseMode?: string
          buttons: Array<Array<{ text: string; callbackData: string }>>
        },
      ) => this.sendTelegramKeyboard(opts),
    )
    ipcMain.handle('homeAgent:readImageAsBase64', (_event, imageUrl: string) =>
      this.readImageAsBase64(imageUrl),
    )
  }
}
