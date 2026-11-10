import { test, expect } from './fixtures'

// Asserts the DateTime MCP tool was called and completed, not just that the model
// answered from memory. Skips when Assistant or the server is not offered here.

const DATETIME_SERVER = 'DateTime MCP'
const DATETIME_TOOLS = ['get_current_time', 'convert_time']

const PROMPT =
  'Use your MCP tools to tell me the current date and time in the UTC timezone. ' +
  'Call the tool to get it — do not guess.'

test.describe('MCP tools: DateTime', () => {
  test('gives Assistant the DateTime MCP server and answers using its tool', async ({ app }) => {
    test.setTimeout(30 * 60_000)

    await app.installAllBackends()

    const enabled = await app.enableMcpServer(DATETIME_SERVER)
    test.skip(!enabled, `${DATETIME_SERVER} is not offered in this environment`)

    await test.step('Ask for the time → expect a completed DateTime MCP tool call', async () => {
      await app.main.sendPrompt(PROMPT)
      await app.resolveModelDownloadOrSkip('the agentic chat model')
      await app.main.waitUntilIdle()
      await app.main.assertNoGenerationError()

      await app.main.openLastTurnDetails()
      const call = app.main.toolCallCards(DATETIME_TOOLS).first()
      await expect(call, 'Assistant should call a DateTime MCP tool').toBeVisible()
      await expect(
        call.getByText('Completed', { exact: true }),
        'the DateTime MCP tool call should complete successfully',
      ).toBeVisible()
      await app.main.assertWellFormedResponse()
      expect(await app.main.lastAssistantText()).not.toEqual('')
    })
  })
})
