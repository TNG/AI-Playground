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

  await test.step('switching a running Component off reads Disabled, and on starts it again', async () => {
    const name = 'Llama.cpp - GGUF'
    const toggle = app.components.toggle(name)

    await expect(toggle).toBeChecked()

    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect(app.components.row(name)).toContainText('Disabled')

    await toggle.click()
    await expect(toggle).toBeChecked()
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
