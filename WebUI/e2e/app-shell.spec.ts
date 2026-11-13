import { expect, test } from './fixtures'

test.describe('App shell', () => {
  test('app chrome is compact', async ({ app, window }) => {
    test.setTimeout(40 * 60_000)
    await app.installAllBackends()

    await test.step('the footer is one line ending in the version', async () => {
      const footer = app.shell.footer
      await expect(footer).toBeVisible()
      await expect(footer).toHaveText(
        /^\s*User Guide\s*Notices & Disclaimers\s*Licenses\s*v\S+\s*$/,
      )

      const items = [
        footer.getByRole('link', { name: 'User Guide' }),
        footer.getByRole('link', { name: 'Notices & Disclaimers' }),
        footer.getByRole('link', { name: 'Licenses' }),
        footer.getByText(/^v\S+$/),
      ]
      const boxes = await Promise.all(items.map((item) => item.boundingBox()))
      const middles = boxes.map((box) => box!.y + box!.height / 2)
      for (const middle of middles) expect(Math.abs(middle - middles[0])).toBeLessThanOrEqual(2)
      const lefts = boxes.map((box) => box!.x)
      expect(lefts).toEqual([...lefts].sort((a, b) => a - b))

      await expect(footer.getByRole('img')).toHaveCount(0)
      await expect(window.getByRole('button', { name: /(hide|show) footer/i })).toHaveCount(0)
    })

    await test.step('App Settings opens from the header and holds the developer console', async () => {
      const shell = app.shell
      await expect(shell.header.getByRole('button', { name: 'App Settings' })).toBeVisible()
      await expect(shell.sessionsPanel.getByRole('button', { name: 'App Settings' })).toHaveCount(0)
      await expect(
        shell.sessionsPanel.getByRole('button', { name: 'Developer Tools' }),
      ).toHaveCount(0)

      await shell.openAppSettings()
      await expect(shell.openDeveloperConsoleButton).toBeVisible()
      await shell.ensureSettingsClosed()
    })

    await test.step('App Settings is a dialog with three vertical tabs', async () => {
      const shell = app.shell
      await shell.openAppSettings()
      const tablist = shell.settingsDialog.getByRole('tablist')
      await expect(tablist).toHaveAttribute('aria-orientation', 'vertical')
      await expect(tablist.getByRole('tab')).toHaveText([
        'App Settings',
        'Component Manager',
        'Model Library',
      ])
      await expect(shell.settingsTab('App Settings')).toHaveAttribute('aria-selected', 'true')
      await expect(shell.settingsPanel('App Settings')).toBeVisible()
      await expect(
        shell.settingsDialog.getByRole('heading', { name: 'App Settings', exact: true }),
      ).toBeVisible()

      for (const tab of ['Component Manager', 'Model Library'] as const) {
        await shell.settingsTab(tab).click()
        await expect(shell.settingsPanel(tab)).toHaveText('Work in progress')
        await expect(
          shell.settingsDialog.getByRole('heading', { name: tab, exact: true }),
        ).toBeVisible()
      }

      await shell.ensureSettingsClosed()
      await shell.openAppSettings()
      await expect(shell.settingsTab('App Settings')).toHaveAttribute('aria-selected', 'true')
      await shell.ensureSettingsClosed()
    })

    await test.step('App Settings holds its seven sections in order', async () => {
      const shell = app.shell
      await shell.openAppSettings()
      const panel = shell.settingsPanel('App Settings')
      const sections = [
        'Language',
        'Theme',
        'Prompt bar style',
        'HuggingFace Settings',
        'Speech',
        'Permissions',
        'Advanced',
      ].map((name) => panel.getByRole('region', { name, exact: true }))
      const tops: number[] = []
      for (const section of sections) {
        await expect(section).toHaveCount(1)
        tops.push((await section.boundingBox())!.y)
      }
      expect(tops).toEqual([...tops].sort((a, b) => a - b))

      const speech = panel.getByRole('region', { name: 'Speech', exact: true })
      await expect(speech.getByText('Enable Text-to-Speech endpoint in Chat')).toBeVisible()
      await expect(speech.getByText('Enable Speech-to-Text endpoint in Chat')).toBeVisible()

      const advanced = panel.getByRole('region', { name: 'Advanced', exact: true })
      await expect(advanced.getByRole('button', { name: 'Setup Wizard' })).toBeVisible()
      await expect(advanced.getByRole('button', { name: 'Edit Settings JSON' })).toBeVisible()
      await expect(advanced.getByRole('button', { name: 'Restart', exact: true })).toBeVisible()
      await shell.ensureSettingsClosed()
    })

    await test.step('App Settings on/off settings are switches, not checkboxes', async () => {
      const shell = app.shell
      await shell.openAppSettings()
      const panel = shell.settingsPanel('App Settings')
      const switches = {
        Language: ['Chat Aware'],
        Speech: [
          'Enable Text-to-Speech endpoint in Chat',
          'Enable Speech-to-Text endpoint in Chat',
        ],
        Advanced: ['Open Developer Console on Startup', 'Keep Models Loaded'],
      }
      for (const [section, names] of Object.entries(switches)) {
        const region = panel.getByRole('region', { name: section, exact: true })
        for (const name of names) {
          await expect(region.getByRole('switch', { name, exact: true })).toBeVisible()
        }
      }
      await expect(panel.getByRole('checkbox')).toHaveCount(0)
      await shell.ensureSettingsClosed()
    })

    await test.step('Without a demo passcode the Demo Mode switch is disabled', async () => {
      const shell = app.shell
      await shell.openAppSettings()
      const advanced = shell
        .settingsPanel('App Settings')
        .getByRole('region', { name: 'Advanced', exact: true })
      await expect(advanced.getByRole('switch', { name: 'Demo Mode', exact: true })).toBeDisabled()
      await expect(
        advanced.getByText('Set a demo passcode first to turn demo mode on.'),
      ).toBeVisible()
      await expect(advanced.getByRole('button', { name: 'Set passcode…' })).toBeVisible()
      await shell.ensureSettingsClosed()
    })

    await test.step('Only the dialog Close button dismisses App Settings', async () => {
      const shell = app.shell
      await shell.openAppSettings()
      await window.keyboard.press('Escape')
      await expect(shell.settingsDialog).toBeVisible()
      await shell.settingsCloseButton.click()
      await expect(shell.settingsDialog).toBeHidden()
    })

    await test.step('App Settings opens over a Library and returns to it', async () => {
      const shell = app.shell
      const modelLibrary = shell.header.getByRole('button', { name: 'Model management' })
      await shell.openAppSettings()
      await expect(shell.appSettingsButton).toHaveAttribute('aria-pressed', 'true')

      await modelLibrary.click()
      await expect(shell.settingsDialog).toBeHidden()
      await expect(shell.appSettingsButton).toHaveAttribute('aria-pressed', 'false')
      await expect(modelLibrary).toHaveAttribute('aria-pressed', 'true')

      await shell.appSettingsButton.click()
      await expect(shell.settingsDialog).toBeVisible()
      await expect(modelLibrary).toHaveAttribute('aria-pressed', 'false')

      await shell.appSettingsButton.click()
      await expect(shell.settingsDialog).toBeHidden()
      await expect(modelLibrary).toHaveAttribute('aria-pressed', 'true')

      await modelLibrary.click()
      await expect(modelLibrary).toHaveAttribute('aria-pressed', 'false')
    })

    await test.step('Unsaved theme colors are guarded on tab switch and close', async () => {
      const shell = app.shell
      await shell.customizeTheme()
      const panel = shell.settingsPanel('App Settings')
      const unsaved = panel.getByRole('region', { name: 'Unsaved theme changes' })
      await expect(unsaved).toBeHidden()
      await panel.getByLabel('App background', { exact: true }).fill('#123456')
      await expect(unsaved).toBeInViewport()
      await expect(unsaved.getByRole('button', { name: 'Save' })).toBeVisible()
      await expect(unsaved.getByRole('button', { name: 'Discard' })).toBeVisible()
      const discard = window.getByRole('alertdialog', { name: 'Discard unsaved changes?' })

      await shell.settingsTab('Component Manager').click()
      await expect(discard).toBeVisible()
      await discard.getByRole('button', { name: 'Cancel' }).click()
      await expect(discard).toBeHidden()
      await expect(shell.settingsTab('App Settings')).toHaveAttribute('aria-selected', 'true')

      await shell.settingsCloseButton.click()
      await expect(discard).toBeVisible()
      await discard.getByRole('button', { name: 'Discard' }).click()
      await expect(shell.settingsDialog).toBeHidden()
    })

    await test.step('Theme switches from the header and is a section of App Settings', async () => {
      const shell = app.shell
      await shell.themeButton.click()
      await expect(shell.themeOptions).toHaveText([
        'Default',
        'Intel® Core™ Ultra',
        'Intel® Arc™',
        'Light',
      ])
      await shell.closeThemeMenu()

      const original = await shell.activeTheme()
      const other = original === 'Light' ? 'Default' : 'Light'
      try {
        await shell.chooseTheme(other)
      } finally {
        await shell.chooseTheme(original)
      }

      await shell.openAppSettings()
      const themeSection = shell
        .settingsPanel('App Settings')
        .getByRole('region', { name: 'Theme', exact: true })
      await expect(themeSection).toBeVisible()
      await expect(themeSection.getByRole('region', { name: 'Colors' })).toHaveCount(0)
      await shell.ensureSettingsClosed()

      await shell.customizeTheme()
      await expect(themeSection).toBeInViewport()
      await expect(themeSection.getByRole('region', { name: 'Colors' })).toBeVisible()
      await shell.ensureSettingsClosed()
    })
  })
})
