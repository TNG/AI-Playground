import { test } from './fixtures'

// A stopped Turn reports Stopping until main releases it, then Send returns. The
// ten-second "Still stopping…" escalation is covered by the model test, not here.
test('Stopping a text Turn shows Stopping, then Send returns', async ({ app }) => {
  test.setTimeout(40 * 60_000)
  await app.installAllBackends()
  await app.runStopTextTurn()
})
