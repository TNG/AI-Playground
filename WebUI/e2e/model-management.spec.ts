import { test, expect } from './fixtures'

// Model management, exercised against the real app. Deliberately cheap: nothing
// here downloads a model or runs inference, so it adds seconds to a suite whose
// other specs take minutes. What it covers is the behaviour that spans surfaces
// and is easy to break from a distance — the batch selection has to reach the
// download dialog with the right models, and the toolbar's batch actions have to
// enable and disable with the selection instead of appearing and vanishing.

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
    })

    await test.step('A search that matches nothing empties the table', async () => {
      await app.models.search('no-such-model-anywhere')
      await app.models.expectRowAbsent(CATALOG_MODEL)
      expect(await app.models.rows.count()).toBe(0)
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
    })

    await test.step('A filter with one possible value is stuck on it', async () => {
      // The speech models all run on one backend, so "Backend" has no choice to
      // offer and locks onto it.
      await expect(app.models.backendFilter).toBeDisabled()
      await app.models.selectUseCase('All')
      // Back in a mixed category it opens up again.
      await expect(app.models.backendFilter).toContainText('All backends')
      await expect(app.models.backendFilter).toBeEnabled()
    })

    await app.models.close()
  })

  test('favoriting a model sorts it to the top of the library', async ({ app }) => {
    await app.installAllBackends()
    await app.models.open()

    const first = (await app.models.visibleLabels())[0]
    const target = (await app.models.visibleLabels()).find((label) => label !== first)
    test.skip(!target, 'Need at least two models to test ordering')

    await app.models.toggleFavorite(target!)
    expect((await app.models.visibleLabels())[0]).toBe(target)

    await test.step('The Favorites category lists exactly what was starred', async () => {
      await app.models.selectUseCase('Favorites')
      expect(await app.models.visibleLabels()).toEqual([target])
      await app.models.selectUseCase('All')
    })

    // Leave the library as it was found: preferences persist across tests.
    await app.models.toggleFavorite(target!)
    await app.models.close()
  })

  test('batch selection offers every selected model for download', async ({ app }) => {
    await app.installAllBackends()
    await app.models.open()

    await test.step('With nothing selected both batch actions are disabled', async () => {
      // They stay in the toolbar rather than being hidden, so the layout does not
      // reflow as rows are ticked.
      await expect(app.models.downloadSelectedButton).toBeVisible()
      await expect(app.models.downloadSelectedButton).toBeDisabled()
      await expect(app.models.deleteSelectedButton).toBeVisible()
      await expect(app.models.deleteSelectedButton).toBeDisabled()
    })

    // Only not-downloaded models can be batch-downloaded.
    await app.models.selectUseCase('LLM')
    await app.models.search('Qwen3-4B')

    const labels = await app.models.visibleLabels()
    const candidates = labels.slice(0, 2)
    test.skip(candidates.length < 2, 'Need two Qwen3-4B models to select')

    for (const label of candidates) await app.models.select(label)

    await test.step('Selecting downloadable models enables only the download action', async () => {
      await expect(app.models.downloadSelectedButton).toBeEnabled()
      // Nothing selected is on disk, so deletion stays unavailable.
      await expect(app.models.deleteSelectedButton).toBeDisabled()
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
})
