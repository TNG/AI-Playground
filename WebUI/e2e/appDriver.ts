import { type Page, test, expect } from '@playwright/test'
import path from 'path'
import { SetupWizardPage } from './pages/SetupWizardPage'
import { AppShellPage } from './pages/AppShellPage'
import { MainPage, type ChatMode } from './pages/MainPage'
import { SpecificSettingsPage } from './pages/SpecificSettingsPage'
import { DownloadDialogPage } from './pages/DownloadDialogPage'
import { BACKENDS, BACKEND_DISPLAY_NAMES } from './backends'

const FIXTURES_DIR = path.join(__dirname, 'fixtures')
/** A real 768x512 PNG used as the input for edit / image-to-video / reference presets. */
export const FIXTURE_IMAGE = path.join(FIXTURES_DIR, 'input.png')
/** A small text document used as the RAG source for the "Chat with RAG" preset. */
export const FIXTURE_DOC = path.join(FIXTURES_DIR, 'sample.txt')
/** Same fact as {@link FIXTURE_DOC} but as a PDF, to cover the PDF ingestion path. */
export const FIXTURE_DOC_PDF = path.join(FIXTURES_DIR, 'sample.pdf')

/** What kind of media a ComfyUI preset is expected to produce. */
export type ComfyOutput = 'image' | 'video' | 'model3d'

/**
 * High-level entry point for the e2e suite. Every test starts with
 * `await app.installAllBackends()`, which brings the app to a running state with
 * all backends installed and up to date, whether starting fresh (Setup Wizard
 * shown) or from a previous run (app already running).
 */
export class AppDriver {
  readonly wizard: SetupWizardPage
  readonly shell: AppShellPage
  readonly main: MainPage
  readonly settings: SpecificSettingsPage
  readonly downloads: DownloadDialogPage

  constructor(private readonly window: Page) {
    this.wizard = new SetupWizardPage(window)
    this.shell = new AppShellPage(window)
    this.main = new MainPage(window)
    this.settings = new SpecificSettingsPage(window)
    this.downloads = new DownloadDialogPage(window)
  }

  /**
   * Install every backend (no Home Agent), then verify via the settings menu that
   * each is at its pinned version — updating any that are not. Idempotent: on a
   * machine where backends are already installed the wizard is skipped and only
   * the verification runs.
   */
  async installAllBackends(): Promise<void> {
    await test.step('Install all backends and reach the running app', async () => {
      const startedOnWizard = await this.waitForWizardOrRunning()

      if (startedOnWizard) {
        await test.step('Enable all backends in the Setup Wizard (no Home Agent)', async () => {
          await this.wizard.expectVisible()
          await this.wizard.disableBackend('Home Agent')
          await this.wizard.enableAll(BACKENDS.map((b) => b.displayName))
        })

        await test.step('Install and continue to the running app', async () => {
          await this.wizard.installAndContinue()
        })
      }

      await this.shell.expectRunning()

      await test.step('Verify each backend is up to date, updating to the pinned version if not', async () => {
        await this.shell.openSetupWizard()
        await this.wizard.expectVisible()
        // Re-opening the wizard reseeds install selection and re-enables any
        // installed backend, so deactivate Home Agent again before continuing.
        await this.wizard.disableBackend('Home Agent')

        for (const backend of BACKENDS.filter((b) => b.hasVersionAction)) {
          await test.step(`Check ${backend.displayName} version`, async () => {
            // Skip backends unavailable in the current product mode (e.g. OpenVINO
            // is disabled in NVIDIA mode) — they are neither installed nor updated.
            if (!(await this.wizard.isAvailable(backend.displayName))) return
            if (await this.wizard.hasUpdateAvailable(backend.displayName)) {
              await this.wizard.updateToLatest(backend.displayName)
            }
            expect(await this.wizard.hasUpdateAvailable(backend.displayName)).toBe(false)
          })
        }

        // Re-point every preset at the default GPU so tests run on a consistent
        // device regardless of any device selections persisted from earlier runs.
        // Applied on commit (continueOut) below; no-op where no GPU section is shown.
        await test.step('Override all preset device selections to the default GPU', () =>
          this.wizard.overrideDeviceSelections())

        await this.wizard.continueOut()
        await this.shell.expectRunning()
        // Leave a clean main view (the settings sidebar re-opens on return and
        // would otherwise occlude the prompt area for follow-up steps).
        await this.shell.ensureSettingsClosed()
      })
    })
  }

  /**
   * Switch to `mode` and select `preset`. Returns false (leaving the settings
   * sidebar closed) when the preset isn't offered in the current product mode —
   * either the whole mode has no presets (its prompt-area button is absent) or the
   * preset card isn't in the grid. On success the sidebar is left open so callers
   * can set preset-specific inputs (e.g. reference images) before closing it.
   */
  private async selectModeAndPreset(mode: ChatMode, preset: string): Promise<boolean> {
    if (
      !(await this.main
        .modeButton(mode)
        .isVisible()
        .catch(() => false))
    ) {
      return false
    }
    // Preset selection lives in the prompt-area quick picker (the mode button is
    // its popover trigger), not the settings sidebar. Returns false when the
    // preset isn't offered for this mode so the caller can skip.
    if (!(await this.main.selectPreset(mode, preset))) {
      return false
    }
    // Leave the mode-settings sidebar open so callers can set preset-specific
    // inputs (e.g. reference images) before closing it.
    await this.settings.open(mode)
    return true
  }

  /**
   * Drive one chat preset: select it, optionally attach a fixture (image for a
   * vision preset, document for a RAG preset), send a prompt and assert a non-empty,
   * well-formed text reply. Skips the test if the preset isn't available in the
   * current product mode.
   */
  async runChatPreset(opts: {
    preset: string
    prompt: string
    attach?: 'image' | 'document'
    /** Which RAG document format to attach when `attach === 'document'`. Defaults to txt. */
    doc?: 'txt' | 'pdf'
  }): Promise<void> {
    const available = await test.step(`Select Chat preset "${opts.preset}"`, () =>
      this.selectModeAndPreset('Chat', opts.preset))
    test.skip(!available, `Preset "${opts.preset}" is not available in this product mode`)

    // Randomly run on llama.cpp or OpenVINO when the preset offers both. OpenVINO is
    // only offered on Intel/OpenVINO product modes — in NVIDIA mode the app filters it
    // out (SettingsChat.vue), so this is a clean no-op there and the default backend
    // (llama.cpp) is used. Done while the settings sidebar is still open.
    let chosenBackend = 'default'
    const offered = await test.step('Read chat backends', () =>
      this.settings.availableBackends('Chat'))
    if (offered.includes('OpenVINO')) {
      chosenBackend = Math.random() < 0.5 ? 'OpenVINO' : 'llamaCPP - GGUF'
      await test.step(`Switch chat backend to ${chosenBackend}`, () =>
        this.settings.selectBackend(chosenBackend, 'Chat'))
    }
    test.info().annotations.push({ type: 'chat-backend', description: chosenBackend })

    await this.settings.close('Chat')

    if (opts.attach === 'image') await this.main.attachChatFile(FIXTURE_IMAGE)
    if (opts.attach === 'document') {
      await this.main.attachChatFile(opts.doc === 'pdf' ? FIXTURE_DOC_PDF : FIXTURE_DOC)
      // A RAG doc is indexed with an embedding model that may need downloading first.
      await this.resolveDownloadsOrSkip('the embedding model')
    }

    await test.step('Send prompt and expect a text reply', async () => {
      await this.main.sendPrompt(opts.prompt)
      // First use of a chat model downloads it via the same dialog.
      await this.resolveDownloadsOrSkip(`the "${opts.preset}" model`)
      // waitForAssistantAnswer waits for the turn to go idle, then asserts a reply.
      await this.main.waitForAssistantAnswer()
      expect(await this.main.lastAssistantText()).not.toEqual('')
      await this.main.assertWellFormedResponse()
    })
  }

  /**
   * Ensure the (feature-flagged, audio-only) Qwen3-TTS backend is installed. Kept
   * out of {@link installAllBackends} on purpose: it pulls a heavy TTS model that
   * only the Text-to-Speech test needs, so the other specs shouldn't pay for it.
   * Opens the wizard, enables the backend if it's offered in this product mode, and
   * installs it. Returns false (leaving the app running) when TTS isn't available —
   * the feature flag is off or the mode doesn't offer it — so the caller can skip.
   */
  async ensureTtsBackendInstalled(): Promise<boolean> {
    return test.step('Ensure the Text-to-Speech backend is installed', async () => {
      await this.shell.openSetupWizard()
      await this.wizard.expectVisible()
      // Re-opening the wizard re-enables installed backends; keep Home Agent off so
      // it doesn't divert to its setup page after install.
      await this.wizard.disableBackend('Home Agent')

      const ttsRow = BACKEND_DISPLAY_NAMES['qwen3-tts-backend']
      const available = await this.wizard.isAvailable(ttsRow)
      if (available) await this.wizard.enable(ttsRow)

      // "Install & Continue" when TTS is pending, otherwise a no-op "Continue".
      await this.wizard.installAndContinue()
      await this.shell.expectRunning()
      await this.shell.ensureSettingsClosed()
      return available
    })
  }

  /**
   * Drive the "Text to Speech" preset: select it, type text, synthesize and assert a
   * playable audio result is produced (no text reply — TTS answers with an audio
   * bubble). Skips the test if the preset isn't offered in the current product mode.
   */
  async runTtsPreset(opts: { text: string }): Promise<void> {
    const available = await test.step('Select Chat preset "Text to Speech"', () =>
      this.selectModeAndPreset('Chat', 'Text to Speech'))
    test.skip(!available, 'Preset "Text to Speech" is not available in this product mode')

    await this.settings.close('Chat')

    await test.step('Synthesize speech and expect an audio result', async () => {
      await this.main.sendPrompt(opts.text)
      // First synthesis may download the TTS model via the same dialog.
      await this.resolveDownloadsOrSkip('the Text-to-Speech model')
      await this.main.waitForTtsAudio()
    })
  }

  /**
   * Clear the model-download dialog if it popped up for the current turn, skipping
   * the test when the required models are gated/unavailable in this environment
   * (nothing to download without Hugging Face access). No-op when no dialog shows.
   */
  private async resolveDownloadsOrSkip(what: string): Promise<void> {
    const outcome = await this.downloads.resolve()
    test.skip(
      outcome === 'blocked',
      `Skipping: ${what} is gated / unavailable without Hugging Face access in this environment`,
    )
  }

  /**
   * Wait for an agentic media turn (image/video) to finish, confirming the model-
   * download dialog each time the agent opens it mid-turn. Up-front resolution can't
   * work here: unlike the direct ComfyUI flows (submit → resolve → wait), the agent
   * only opens the dialog *after* it finishes reasoning and decides to generate —
   * which can outlast the dialog's appearance window — and may open it more than
   * once in a turn (e.g. a video step pulls several models). Skips the test when a
   * required model is gated/unavailable rather than hanging on an unconfirmable
   * dialog. Throws if the turn hasn't gone idle within `timeout`.
   */
  async waitForAgenticMediaTurn(timeout: number): Promise<void> {
    const deadline = Date.now() + timeout
    // Make sure the turn started before we start polling for idle, so we don't
    // return before the agent has even begun working.
    await this.main.expectTurnStarted()
    while (Date.now() < deadline) {
      if (await this.downloads.isOpen()) {
        const outcome = await this.downloads.resolve(deadline - Date.now())
        test.skip(
          outcome === 'blocked',
          'Skipping: a model needed for this generation is gated / unavailable without Hugging Face access',
        )
        continue
      }
      if (!(await this.main.isBusy())) return
      await this.main.pause()
    }
    throw new Error(`Agentic media turn did not finish within ${timeout}ms`)
  }

  /**
   * Drive one ComfyUI preset (Image Gen / Image Edit / Video): select it, load the
   * fixture image into every reference-image slot when the preset needs one, submit,
   * and assert the expected media (image / video / 3D model) is produced without a
   * generation error. Skips the test if the preset isn't available in the current
   * product mode.
   *
   * Note: for Image Edit presets the loaded input image is itself surfaced as a
   * "Generated result", so the image-count assertion there is a liveness check (the
   * workflow ran to completion without error) rather than a strict new-output count.
   */
  async runComfyPreset(opts: {
    mode: ChatMode
    preset: string
    output: ComfyOutput
    prompt?: string
    needsImage?: boolean
    timeout: number
  }): Promise<void> {
    const available = await test.step(`Select ${opts.mode} preset "${opts.preset}"`, () =>
      this.selectModeAndPreset(opts.mode, opts.preset))
    test.skip(!available, `Preset "${opts.preset}" is not available in this product mode`)

    if (opts.needsImage) {
      await test.step('Load the fixture image into the reference-image slot(s)', async () => {
        const filled = await this.settings.attachReferenceImages(opts.mode, FIXTURE_IMAGE)
        expect(
          filled,
          'preset should expose at least one reference-image input',
        ).toBeGreaterThanOrEqual(1)
      })
    }

    await this.settings.close(opts.mode)

    await test.step(`Generate and expect ${opts.output} output`, async () => {
      await this.main.submitGeneration(opts.prompt)
      // First use of a preset downloads its models via the download dialog.
      await this.resolveDownloadsOrSkip(`the models for "${opts.preset}"`)
      await this.main.waitUntilIdle(opts.timeout)
      await this.main.assertNoGenerationError()

      const result =
        opts.output === 'image'
          ? this.main.generatedImages
          : opts.output === 'video'
            ? this.main.generatedVideos
            : this.main.generatedModels
      await expect(result.first()).toBeVisible({ timeout: 30_000 })
      expect(await result.count()).toBeGreaterThanOrEqual(1)
    })
  }

  /** Resolve once either the wizard or the running shell is on screen. */
  private async waitForWizardOrRunning(): Promise<boolean> {
    await expect(this.wizard.heading.or(this.shell.appSettingsButton)).toBeVisible({
      timeout: 120_000,
    })
    return this.wizard.isVisible()
  }
}
