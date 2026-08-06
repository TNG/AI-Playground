import { test, expect } from './fixtures'

// Model management, exercised against the real app. Deliberately cheap: nothing
// here downloads a model or runs inference, so it adds seconds to a suite whose
// other specs take minutes. What it covers is the behaviour that spans surfaces
// and is easy to break from a distance — hiding a model in the library has to
// remove it from the chat picker, and the batch selection has to reach the
// download dialog with the right models.

/** A model that exists in models.json for every product mode, so the rows are stable. */
const CATALOG_MODEL = 'Llama-3.2-3B-Instruct-Q4_K_S.gguf'

test.describe('Model management', () => {
  test('lists models and filters them by use case, name and status', async ({ app }) => {
    await app.installAllBackends()

    await test.step('Open the model library', async () => {
      await app.models.open()
    })

    await test.step('The library lists the model catalog', async () => {
      // The bundled catalog alone is dozens of models, so any sane threshold
      // proves the list was derived rather than left empty.
      expect(await app.models.rows.count()).toBeGreaterThan(10)
    })

    await test.step('Filtering by name narrows to the matching model', async () => {
      await app.models.search(CATALOG_MODEL)
      await app.models.expectRowVisible(CATALOG_MODEL)
      expect(await app.models.rows.count()).toBe(1)
      await app.models.search('')
    })

    await test.step('The use-case sidebar filters to one kind of model', async () => {
      await app.models.selectUseCase('Embedding')
      const labels = await app.models.visibleLabels()
      expect(labels.length).toBeGreaterThan(0)
      // The chat catalog's LLMs must not leak into the embedding list.
      expect(labels).not.toContain(CATALOG_MODEL)
      await app.models.selectUseCase('All')
    })

    await test.step('Speech models are listed even though no picker offers them', async () => {
      await app.models.selectUseCase('Speech')
      // STT/TTS load fixed repos with no picker, so the library is the only place
      // they can be seen or pre-fetched.
      expect(await app.models.rows.count()).toBeGreaterThan(0)
      await app.models.selectUseCase('All')
    })

    await app.models.close()
  })

  test('hiding a model removes it from the chat model picker', async ({ app }) => {
    await app.installAllBackends()

    await app.settings.open('Chat')

    const before = await test.step('Read the chat model picker', () =>
      app.settings.availableModels('Chat'))
    test.skip(
      !before.includes(CATALOG_MODEL),
      `${CATALOG_MODEL} is not offered by the chat picker in this product mode`,
    )

    // Hiding the *selected* model deliberately keeps it listed (it would strand the
    // selection otherwise), so this must act on a model that is not selected.
    test.skip(
      before[0] === CATALOG_MODEL && before.length === 1,
      'Only one model is offered, so it is necessarily the selection',
    )

    await test.step('Hide the model in the library', async () => {
      await app.models.open()
      await app.models.search(CATALOG_MODEL)
      await app.models.rowAction(CATALOG_MODEL, 'Hide from model picker')
      // It leaves the library's own table too, unless "Show hidden" is on.
      await app.models.expectRowHidden(CATALOG_MODEL)
      await app.models.close()
    })

    await test.step('The chat picker no longer offers it', async () => {
      const after = await app.settings.availableModels('Chat')
      expect(after).not.toContain(CATALOG_MODEL)
      expect(after.length).toBe(before.length - 1)
    })

    await test.step('Unhiding puts it back', async () => {
      await app.models.open()
      await app.models.setShowHidden(true)
      await app.models.search(CATALOG_MODEL)
      await app.models.rowAction(CATALOG_MODEL, 'Show in model picker')
      await app.models.setShowHidden(false)
      await app.models.close()

      expect(await app.settings.availableModels('Chat')).toContain(CATALOG_MODEL)
    })

    await app.settings.close('Chat')
  })

  test('favoriting a model sorts it to the top of the library', async ({ app }) => {
    await app.installAllBackends()
    await app.models.open()

    const first = (await app.models.visibleLabels())[0]
    const target = (await app.models.visibleLabels()).find((label) => label !== first)
    test.skip(!target, 'Need at least two models to test ordering')

    await app.models.toggleFavorite(target!)
    expect((await app.models.visibleLabels())[0]).toBe(target)

    // Leave the library as it was found: preferences persist across tests.
    await app.models.toggleFavorite(target!)
    await app.models.close()
  })

  test('batch selection offers every selected model for download', async ({ app }) => {
    await app.installAllBackends()
    await app.models.open()

    // Only not-downloaded models can be batch-downloaded.
    await app.models.selectUseCase('LLM')
    await app.models.search('Qwen3-4B')

    const labels = await app.models.visibleLabels()
    const candidates = labels.slice(0, 2)
    test.skip(candidates.length < 2, 'Need two Qwen3-4B models to select')

    for (const label of candidates) await app.models.select(label)

    await test.step('The batch button counts the selection', async () => {
      await expect(app.models.downloadSelectedButton).toBeVisible()
      await expect(app.models.downloadSelectedButton).toContainText('2')
    })

    await test.step('The download dialog lists both, then is cancelled', async () => {
      await app.models.downloadSelectedButton.click()
      const listed = await app.downloads.listedModels()
      // The dialog keys rows on the full repo id, of which the label is the tail.
      for (const label of candidates) {
        expect(listed.some((id) => id.endsWith(label))).toBe(true)
      }
      // Nothing is actually downloaded: these are multi-GB models and the point
      // here is that the selection reached the dialog intact.
      await app.downloads.cancel()
    })

    await app.models.close()
  })

  test('the model folders dialog shows the configured directories', async ({ app }) => {
    await app.installAllBackends()
    await app.models.open()

    const dialog = await app.models.openFolders()
    // Every install has a GGUF directory; its field is named after the path key.
    const ggufField = dialog.getByRole('textbox', { name: 'ggufLLM' })
    await expect(ggufField).toBeVisible()
    expect((await ggufField.inputValue()).length).toBeGreaterThan(0)

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await app.models.close()
  })
})
