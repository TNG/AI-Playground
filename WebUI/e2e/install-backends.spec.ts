import { test } from './fixtures'

test.describe('Backend installation', () => {
  test('installs all backends (no Home Agent) and reaches the running app', async ({ app }) => {
    // The single entry point every future test will start with: installs all
    // available backends, verifies each is at its pinned version (updating if
    // not), and leaves the app running. Home Agent is deactivated via its toggle;
    // backends unavailable in the current product mode (e.g. OpenVINO in NVIDIA
    // mode) are skipped.
    await app.installAllBackends()

    await app.shell.expectRunning()
  })
})
