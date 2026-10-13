import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, app: { getPath: () => '' } }))
vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

const search = vi.fn()
const navigate = vi.fn()
vi.mock('../../adapters/webBrowserManager.ts', () => ({ search, navigate }))

const { webCapability, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } =
  await import('../../agent/capabilities/web.ts')

type Tool = {
  name: string
  execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>
}

async function tools(): Promise<Record<string, Tool>> {
  const built = (await webCapability.buildTools?.({} as never)) as unknown as Tool[]
  return Object.fromEntries(built.map((tool) => [tool.name, tool]))
}

const text = (result: { content: { text: string }[] }) => result.content[0].text

describe('the web capability', () => {
  it('searches through the shared web browser and lists the results', async () => {
    search.mockResolvedValueOnce({
      query: 'bbc news',
      results: [{ title: 'BBC News', url: 'https://www.bbc.com/news', snippet: 'Latest' }],
    })
    const result = await (await tools())[WEB_SEARCH_TOOL].execute('t1', { query: 'bbc news' })
    expect(search).toHaveBeenCalledWith('bbc news', undefined)
    expect(text(result)).toContain('[1] BBC News — https://www.bbc.com/news')
  })

  it('returns the readable text and links of a fetched page', async () => {
    navigate.mockResolvedValueOnce({
      title: 'Home - BBC News',
      url: 'https://www.bbc.com/news',
      text: 'Headline one',
      links: [{ index: 0, text: 'World', href: 'https://www.bbc.com/news/world' }],
    })
    const result = await (
      await tools()
    )[WEB_FETCH_TOOL].execute('t2', {
      url: 'https://www.bbc.com/news',
    })
    expect(text(result)).toContain('Headline one')
    expect(text(result)).toContain('- World — https://www.bbc.com/news/world')
  })

  it('reports a failed load to the model instead of throwing', async () => {
    navigate.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED'))
    const result = await (await tools())[WEB_FETCH_TOOL].execute('t3', { url: 'https://nope' })
    expect(text(result)).toBe('Error: ERR_NAME_NOT_RESOLVED')
  })

  it('runs calls one at a time on the shared window', async () => {
    const order: string[] = []
    let release!: () => void
    navigate.mockImplementationOnce(async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => (release = resolve))
      order.push('first:end')
      return { title: '', url: 'a', text: '', links: [] }
    })
    navigate.mockImplementationOnce(async () => {
      order.push('second')
      return { title: '', url: 'b', text: '', links: [] }
    })
    const fetchTool = (await tools())[WEB_FETCH_TOOL]
    const first = fetchTool.execute('a', { url: 'a' })
    const second = fetchTool.execute('b', { url: 'b' })
    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })
})
