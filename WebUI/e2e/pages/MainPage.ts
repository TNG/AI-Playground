import { type Locator, type Page, expect } from '@playwright/test'

/** Prompt-area mode labels (accessible names of the mode buttons). */
export type ChatMode = 'Chat' | 'Image Gen' | 'Image Edit' | 'Video'

/**
 * Page object for the running main view: the prompt area (mode switch, prompt
 * input, send) and the chat/agentic result panel (text replies, generated
 * images/videos).
 */
export class MainPage {
  constructor(private readonly page: Page) {}

  // A chat text turn is quick; image/video generation runs for minutes.
  static readonly TEXT_TIMEOUT = 2 * 60_000
  static readonly IMAGE_TIMEOUT = 4 * 60_000
  static readonly VIDEO_TIMEOUT = 5 * 60_000

  get promptInput(): Locator {
    return this.page.getByRole('textbox', { name: 'Prompt' })
  }

  /** Visible only when idle; replaced by a Stop button while a turn is running. */
  get sendButton(): Locator {
    return this.page.getByRole('button', { name: 'Send' })
  }

  /** Main display image of each completed image/edit tool result. */
  get generatedImages(): Locator {
    return this.page.getByRole('img', { name: 'Generated result' })
  }

  /** Generated video result(s) in the chat panel. */
  get generatedVideos(): Locator {
    return this.page.locator('video')
  }

  get assistantResponses(): Locator {
    return this.page.getByRole('article', { name: 'Assistant response' })
  }

  /** Error surfaced by the app when a generation/tool turn fails. */
  get generationError(): Locator {
    return this.page.getByText(/Generation failed|An error occurred/i)
  }

  /** Throw with the app's error text if a generation error is on screen. */
  async assertNoGenerationError(): Promise<void> {
    if (
      await this.generationError
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      const message = (
        await this.generationError
          .first()
          .innerText()
          .catch(() => '')
      ).trim()
      throw new Error(`App reported a generation error: "${message || 'unknown error'}"`)
    }
  }

  modeButton(label: ChatMode): Locator {
    return this.page.getByRole('button', { name: label, exact: true })
  }

  async selectMode(label: ChatMode): Promise<void> {
    await this.modeButton(label).click()
  }

  async sendPrompt(text: string): Promise<void> {
    await expect(this.sendButton).toBeVisible()
    await this.promptInput.fill(text)
    await this.sendButton.click()
  }

  /**
   * Wait for the current turn (text + any tool/generation work) to finish. The
   * Send button is removed while processing and returns when the turn completes,
   * so we wait for it to disappear and then reappear.
   */
  async waitUntilIdle(timeout: number = MainPage.TEXT_TIMEOUT): Promise<void> {
    try {
      await expect(this.sendButton).toBeHidden({ timeout: 20_000 })
    } catch {
      // A very fast turn may finish before the processing state is observed.
    }
    await expect(this.sendButton).toBeVisible({ timeout })
  }

  async lastAssistantText(): Promise<string> {
    return (await this.assistantResponses.last().innerText()).trim()
  }
}
