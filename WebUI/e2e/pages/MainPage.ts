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

  /**
   * The busy control shown in place of Send while a turn runs. It stays up for
   * the WHOLE turn — backend/model load, "Processing prompt…", reasoning, tool
   * calls and generation — and is the app's single source of truth for "busy",
   * so tests gate on it rather than guessing from partial signals (reasoning
   * done, first text token, etc.). Matches both the active "Stop generating"
   * button and the transient disabled "Stopping" button.
   */
  get busyButton(): Locator {
    return this.page
      .getByRole('button', { name: 'Stop generating' })
      .or(this.page.getByRole('button', { name: 'Stopping' }))
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

  /**
   * The rendered final text answer(s) of the last assistant turn. Scoped to the
   * "Assistant reply" region(s) so it excludes the collapsible reasoning trace —
   * whose "Reasoned for …" / "Done Reasoning …" status line otherwise leaks into
   * the article's text and makes a bare non-empty check pass on reasoning alone,
   * before the model has actually replied.
   */
  get assistantAnswer(): Locator {
    return this.assistantResponses.last().getByRole('region', { name: 'Assistant reply' })
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

  /** The collapsible "reasoning" trace toggle(s) in the last assistant turn. */
  get reasoningBlocks(): Locator {
    return this.assistantResponses
      .last()
      .getByRole('button', { name: /Reasoned for|Done Reasoning/i })
  }

  /**
   * Assert the last assistant turn rendered cleanly, not in the malformed shapes
   * we've hit: the reasoning trace duplicated into several "Reasoned for…" pills,
   * or a tool card that never resolved its preset and shows the "unknown"
   * fallback. A malformed turn can still "pass" the image/video count checks, so
   * these are asserted explicitly.
   */
  async assertWellFormedResponse(): Promise<void> {
    const reasoningCount = await this.reasoningBlocks.count()
    expect(
      reasoningCount,
      'the reasoning trace should render as a single aggregated block, not be duplicated',
    ).toBeLessThanOrEqual(1)

    const text = await this.assistantResponses.last().innerText()
    expect(
      text,
      'a tool card should resolve to a real preset, never the "unknown" fallback',
    ).not.toMatch(/using the preset\s+unknown/i)
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
   * Wait for the current turn (backend/model load, "Processing prompt…",
   * reasoning, tool calls and generation) to fully finish. The busy (Stop)
   * control is up for the entire turn and only gives way to Send once everything
   * is done, so we first confirm the turn actually started (busy control shown),
   * then wait for it to clear. Gating on the busy control — not on partial
   * signals like reasoning finishing or the first token — is what keeps this from
   * returning early.
   */
  async waitUntilIdle(timeout: number = MainPage.TEXT_TIMEOUT): Promise<void> {
    try {
      await expect(this.busyButton).toBeVisible({ timeout: 20_000 })
    } catch {
      // A very fast turn may finish before the busy state is observed.
    }
    await expect(this.busyButton).toBeHidden({ timeout })
    await expect(this.sendButton).toBeVisible({ timeout: 20_000 })
  }

  /**
   * Wait until the last assistant turn has rendered a non-empty text answer, i.e.
   * the model has moved past reasoning/tool steps and actually replied. Prefer
   * this over relying on {@link waitUntilIdle} alone for text turns: the idle
   * (Send button) signal fires when the turn ends, but the assertion of interest
   * is that a *reply* — not just a reasoning trace — is on screen.
   */
  async waitForAssistantAnswer(timeout: number = MainPage.TEXT_TIMEOUT): Promise<void> {
    await expect(this.assistantAnswer.filter({ hasText: /\S/ }).first()).toBeVisible({ timeout })
  }

  async lastAssistantText(): Promise<string> {
    const answers = this.assistantAnswer
    const count = await answers.count()
    const texts: string[] = []
    for (let i = 0; i < count; i++) {
      texts.push((await answers.nth(i).innerText()).trim())
    }
    return texts.filter((t) => t.length > 0).join('\n\n')
  }
}
