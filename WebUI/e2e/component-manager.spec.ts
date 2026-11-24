import { expect, test } from './fixtures'

// One test: launching the app and installing backends costs minutes, so every
// Component Manager assertion rides the single installed state that
// `installAllBackends()` produces. Nothing here installs or uninstalls anything —
// it drives the live tab the way a user would and toggles one installed Component
// off and back on.
test('the Component Manager shows the machine as it is and toggles a Component', async ({
  app,
}) => {
  test.setTimeout(40 * 60_000)
  await app.installAllBackends()

  await test.step('the header server button opens App Settings on the Component Manager tab', async () => {
    await expect(app.components.openButton).toBeVisible()
    await expect(app.components.openButton).toHaveAttribute('aria-pressed', 'false')

    await app.components.open()

    await expect(app.shell.settingsTab('Component Manager')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(app.components.tabPanel).toBeVisible()
    await expect(app.components.tabPanel).not.toHaveText('Work in progress')
    await expect(app.components.openButton).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('the health line summarises the Components', async () => {
    await expect(app.components.healthLine).toHaveText(
      /\d+ running · \d+ with updates · \d+ needing attention/,
    )
  })

  await test.step('the rows keep the wizard groups and read the row vocabulary', async () => {
    await expect(
      app.components.tabPanel.getByRole('group', { name: 'AI Playground', exact: true }),
    ).toBeVisible()

    for (const name of ['Core Services', 'Channels', 'ComfyUI', 'Llama.cpp - GGUF']) {
      await expect(app.components.row(name)).toBeVisible()
    }

    await expect(app.components.row('Core Services')).toContainText('Running')

    await app.components.expandCoreServices()
    await expect(app.components.row('Speech To Text (Standalone Whisper)')).toContainText(
      'Installed',
    )
  })

  await test.step('a Component that is not on disk offers Install and keeps its switch off', async () => {
    const name = 'Channels'
    const rowText = await app.components.row(name).innerText()
    if (/Not Installed/i.test(rowText)) {
      await expect(app.components.installButton(name)).toBeVisible()
      const toggle = app.components.toggle(name)
      await expect(toggle).not.toBeChecked()
      await expect(toggle).toBeDisabled()
    } else {
      await expect(app.components.installButton(name)).toHaveCount(0)
    }
  })

  await test.step('only a failed Component offers Repair and its error log', async () => {
    for (const name of ['ComfyUI', 'Llama.cpp - GGUF']) {
      const failed = /Failed/i.test(await app.components.row(name).innerText())
      if (failed) {
        await expect(app.components.repairButton(name)).toBeVisible()
        await expect(app.components.errorLogButton(name)).toBeVisible()
      } else {
        await expect(app.components.repairButton(name)).toHaveCount(0)
        await expect(app.components.errorLogButton(name)).toHaveCount(0)
      }
    }
  })

  await test.step('a newer version is advertised on the row, not only in the menu', async () => {
    const name = 'Llama.cpp - GGUF'
    const update = app.components.updateButton(name)
    if ((await update.count()) > 0) {
      await expect(update).toBeVisible()
      await expect(update).toHaveText(/^Update to /)
      await expect(app.components.installButton(name)).toHaveCount(0)
    }
    // Nothing is installing on the installed fixture, so no row shows its progress.
    await expect(app.components.progressText(name)).toHaveCount(0)
  })

  await test.step('the options menu keeps reinstall, version change and per-backend settings', async () => {
    const name = 'Llama.cpp - GGUF'
    const hasUpdate = (await app.components.updateButton(name).count()) > 0
    await app.components.optionsButton(name).click()
    await expect(app.components.reinstallMenuItem).toBeVisible()
    await expect(app.components.settingsMenuItem).toBeVisible()
    await expect(app.components.versionChangeMenuItem).toHaveCount(hasUpdate ? 1 : 0)
    await app.components.closeOptions()
  })

  await test.step('switching a running Component off reads Disabled, and on starts it again', async () => {
    const name = 'Llama.cpp - GGUF'
    const toggle = app.components.toggle(name)

    await expect(toggle).toBeChecked()

    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect(app.components.row(name)).toContainText('Disabled')

    await toggle.click()
    await expect(toggle).toBeChecked()
    // Coming back up is progress text on the row, then the settled status.
    await expect(app.components.row(name)).toContainText(/Starting|Running|Installed/, {
      timeout: 120_000,
    })
    await expect(app.components.row(name)).toContainText(/Running|Installed/, {
      timeout: 120_000,
    })
  })

  await test.step('the header button toggles App Settings and is pressed only on this tab', async () => {
    await app.components.openButton.click()
    await expect(app.shell.settingsDialog).toBeHidden()
    await expect(app.components.openButton).toHaveAttribute('aria-pressed', 'false')

    await app.components.open()
    await app.shell.settingsTab('Model Library').click()
    await expect(app.components.openButton).toHaveAttribute('aria-pressed', 'false')

    await app.components.openButton.click()
    await expect(app.components.tabPanel).toBeVisible()

    await app.components.close()
  })
})
