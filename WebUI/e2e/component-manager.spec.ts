import { expect, test } from './fixtures'
import type { BackendDisplayName } from './backends'
import { ChannelsPage } from './pages/ChannelsPage'

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

  await test.step('the default GPU row opens a change dialog when a GPU is detected', async () => {
    if ((await app.components.defaultGpuRow.count()) === 0) return

    await expect(app.components.defaultGpuRow).toBeVisible()
    await app.components.openDefaultGpuDialog()

    await expect(app.components.defaultGpuOptions.first()).toBeVisible()
    await expect(app.components.overrideDeviceSwitch).toBeVisible()
    await expect(app.components.defaultGpuDialog).toContainText(
      'Existing Sessions keep the device they were set up with',
    )

    await app.components.defaultGpuDialog
      .getByRole('button', { name: 'Cancel', exact: true })
      .click()
    await expect(app.components.defaultGpuDialog).toBeHidden()
  })

  await test.step('the Hardware Mode row changes the mode through a confirmation, without a restart', async () => {
    await expect(app.components.hardwareModeRow).toBeVisible()

    const original = modeOptionNameFor(await app.components.hardwareModeRow.innerText())
    const target =
      original === 'AI PLAYGROUND studio' ? 'AI PLAYGROUND essentials' : 'AI PLAYGROUND studio'

    await app.components.openHardwareModeDialog()

    await expect(app.components.hardwareModeOption('AI PLAYGROUND essentials')).toBeVisible()
    await expect(app.components.hardwareModeOption('AI PLAYGROUND studio')).toBeVisible()
    await expect(app.components.hardwareModeDialog).toContainText('Supported hardware')
    await expect(app.components.hardwareModeDialog).toContainText(/Recommended|Experimental/)
    // Re-picking the current mode is not a change.
    await expect(app.components.applyHardwareModeButton).toBeDisabled()

    await app.components.applyHardwareMode(target)
    await expect(app.components.hardwareModeRow).toContainText(modeLabelFor(target))
    // The picker is gone: the app is still running and the tab is still open.
    await expect(app.shell.header).toBeVisible()
    await expect(app.components.tabPanel).toBeVisible()

    await app.components.openHardwareModeDialog()
    await app.components.applyHardwareMode(original)
    await expect(app.components.hardwareModeRow).toContainText(modeLabelFor(original))
  })

  await test.step('the rows keep the wizard groups and read the row vocabulary', async () => {
    await expect(
      app.components.tabPanel.getByRole('group', { name: 'AI Playground', exact: true }),
    ).toBeVisible()

    for (const name of [
      'Core Services',
      'Channels',
      'ComfyUI',
      'Llama.cpp - GGUF',
    ] as BackendDisplayName[]) {
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

  await test.step('an optional Component offers Uninstall in its options menu behind a confirmation; a required one never does', async () => {
    await app.components.optionsButton('Core Services').click()
    await expect(app.components.uninstallMenuItem('Core Services')).toHaveCount(0)
    await app.components.closeOptions()

    for (const name of ['ComfyUI', 'Llama.cpp - GGUF'] as BackendDisplayName[]) {
      if (/Not Installed/i.test(await app.components.row(name).innerText())) continue

      await app.components.optionsButton(name).click()
      const uninstall = app.components.uninstallMenuItem(name)
      if ((await uninstall.count()) === 0) {
        await app.components.closeOptions()
        continue
      }

      await expect(uninstall).toBeEnabled()
      await uninstall.click()

      const dialog = app.components.uninstallDialog(name)
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText(/stops? working/i)
      await expect(dialog).toContainText('Model weights are kept')

      // Cancel: this spec never performs a real uninstall.
      await app.components.cancelUninstall(name)
      await expect(dialog).toBeHidden()
      break
    }
  })

  await test.step('only a failed Component offers Repair and its error log', async () => {
    for (const name of ['ComfyUI', 'Llama.cpp - GGUF'] as BackendDisplayName[]) {
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

// The two setup screens that used to replace the app with the first-run wizard
// now render inside the tab, with Back returning to the Component list. Their
// entry points (the title-bar Channels gear and the Permissions link) land on the
// same Channels sub-view.
test('Channels and Hybrid Cloud setup open inside the Component Manager tab', async ({
  app,
  window,
}) => {
  test.setTimeout(40 * 60_000)
  await app.installAllBackends()

  const channelsAvailable = await app.ensureChannelsBackendInstalled()
  // Installing Channels can divert the wizard to its setup page; leave it cleanly
  // so the steps below start from the running app.
  await new ChannelsPage(window).finishSetup()

  await test.step('the Hybrid Cloud provider setup opens inside the tab, and Back returns to the list', async () => {
    await app.components.open()
    await app.components.setEnabled('Hybrid Cloud', true)

    await app.components.openCloudFromRow()
    await expect(app.components.cloudView).toBeVisible()

    await app.components.backButton.click()
    await expect(app.components.cloudView).toBeHidden()
    await expect(app.components.healthLine).toBeVisible()
  })

  await test.step('the title-bar Channels gear opens the Channels setup inside the tab', async () => {
    if (!channelsAvailable) return

    await app.components.openChannelsFromGear()
    await expect(app.components.channelsView).toBeVisible()

    await app.components.backButton.click()
    await expect(app.components.channelsView).toBeHidden()
    await expect(app.components.healthLine).toBeVisible()
  })

  await test.step('the Permissions "Set up Channels" link lands on the same sub-view', async () => {
    if (!channelsAvailable) return

    await app.shell.openAppSettings()
    await app.shell.settingsTab('App Settings').click()

    // The link only shows while no Channel is configured; a previous run may have
    // configured one (that config outlives the app window), in which case the gear
    // above is the entry point this test already covered.
    const link = app.shell
      .settingsPanel('App Settings')
      .getByRole('button', { name: 'Set up Channels', exact: true })
    if (!(await link.isVisible().catch(() => false))) return

    await link.click()
    await expect(app.components.tabPanel).toBeVisible()
    await expect(app.components.channelsView).toBeVisible()

    await app.components.close()
  })
})

/** The mode option name that matches the Hardware Mode row's current text. */
function modeOptionNameFor(rowText: string): string {
  if (/NVIDIA|CUDA/i.test(rowText)) return 'AI PLAYGROUND studio for NVIDIA CUDA'
  if (/essentials/i.test(rowText)) return 'AI PLAYGROUND essentials'
  return 'AI PLAYGROUND studio'
}

function modeLabelFor(optionName: string): RegExp {
  if (/essentials/.test(optionName)) return /essentials/i
  if (/NVIDIA/.test(optionName)) return /NVIDIA|CUDA/i
  return /\bstudio\b/i
}
