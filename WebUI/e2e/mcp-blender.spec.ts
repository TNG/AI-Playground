import { test, expect } from './fixtures'

// Blender need not be running: blender-mcp still advertises its tools over stdio, so the
// call may complete or fail. Only that Assistant calls a Blender tool is asserted.
// Skips when Assistant or the server is not offered here.

const BLENDER_SERVER = 'Blender MCP'
const BLENDER_TOOLS = [
  'get_scene_info',
  'get_object_info',
  'get_viewport_screenshot',
  'execute_blender_code',
]

const PROMPT =
  'Use your Blender MCP tools to fetch the current Blender scene information. ' +
  'Call the tool to do it.'

test.describe('MCP tools: Blender', () => {
  test('gives Assistant the Blender MCP server and invokes one of its tools', async ({ app }) => {
    test.setTimeout(30 * 60_000)

    await app.installAllBackends()

    const enabled = await app.enableMcpServer(BLENDER_SERVER)
    test.skip(!enabled, `${BLENDER_SERVER} is not offered in this environment`)

    await test.step('Ask to use Blender → expect a Blender MCP tool call', async () => {
      await app.main.sendPrompt(PROMPT)
      await app.resolveModelDownloadOrSkip('the agentic chat model')
      await app.main.waitUntilIdle()

      await app.main.openLastTurnDetails()
      await expect(
        app.main.toolCallCards(BLENDER_TOOLS).first(),
        'Assistant should call a Blender MCP tool',
      ).toBeVisible()
    })
  })
})
