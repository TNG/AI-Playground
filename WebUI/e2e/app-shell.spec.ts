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

    await test.step('Theme switches from the header and is gone from App Settings', async () => {
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
      const sidebar = window.getByRole('region', { name: 'App Settings' })
      await expect(sidebar.getByText('Theme', { exact: true })).toHaveCount(0)
      await expect(sidebar.getByText('Intel® Arc™')).toHaveCount(0)
      await shell.ensureSettingsClosed()
    })
  })
})
