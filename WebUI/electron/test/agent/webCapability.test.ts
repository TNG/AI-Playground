import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, app: { getPath: () => '' } }))
vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

const search = vi.fn()
const navigate = vi.fn()
const interact = vi.fn()
vi.mock('../../adapters/webBrowserManager.ts', () => ({ search, navigate, interact }))

const { webCapability, WEB_FETCH_TOOL, WEB_INTERACT_TOOL, WEB_SEARCH_TOOL } =
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
    expect(text(result)).toContain('[0] World — https://www.bbc.com/news/world')
  })

  it('reports a failed load to the model instead of throwing', async () => {
    navigate.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED'))
    const result = await (await tools())[WEB_FETCH_TOOL].execute('t3', { url: 'https://nope' })
    expect(text(result)).toBe('Error: ERR_NAME_NOT_RESOLVED')
  })

  it('hands each fetch to the shared browser, which serializes the window', async () => {
    navigate.mockClear()
    navigate.mockResolvedValue({ title: '', url: 'https://example.com', text: '', links: [] })
    const fetchTool = (await tools())[WEB_FETCH_TOOL]
    await Promise.all([
      fetchTool.execute('a', { url: 'https://a.example' }),
      fetchTool.execute('b', { url: 'https://b.example' }),
    ])
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(navigate).toHaveBeenCalledWith('https://a.example')
    expect(navigate).toHaveBeenCalledWith('https://b.example')
  })

  it('clicks a link of the open page by its number and returns the page it led to', async () => {
    interact.mockResolvedValueOnce({
      title: 'World - BBC News',
      url: 'https://www.bbc.com/news/world',
      text: 'World headlines',
      links: [],
    })
    const result = await (
      await tools()
    )[WEB_INTERACT_TOOL].execute('t4', { action: 'click', linkIndex: 0 })
    expect(interact).toHaveBeenCalledWith({ action: 'click', linkIndex: 0 })
    expect(text(result)).toContain('URL: https://www.bbc.com/news/world')
    expect(text(result)).toContain('World headlines')
  })

  it('types into a field of the open page and can submit it', async () => {
    interact.mockResolvedValueOnce({
      title: 'Results',
      url: 'https://example.com/search?q=intel',
      text: 'Intel results',
      links: [],
    })
    const result = await (
      await tools()
    )[WEB_INTERACT_TOOL].execute('t5', {
      action: 'type',
      selector: 'input[name=q]',
      text: 'intel',
      submit: true,
    })
    expect(interact).toHaveBeenCalledWith({
      action: 'type',
      selector: 'input[name=q]',
      text: 'intel',
      submit: true,
    })
    expect(text(result)).toContain('Intel results')
  })

  it('lists the fields of a page with the selector to type into them', async () => {
    navigate.mockResolvedValueOnce({
      title: 'Search',
      url: 'https://example.com',
      text: '',
      links: [],
      fields: [{ selector: '#q', label: 'Search the site' }],
    })
    const result = await (await tools())[WEB_FETCH_TOOL].execute('t7', { url: 'example.com' })
    expect(text(result)).toContain('#q — Search the site')
  })

  it('tells the model when a page element cannot be found', async () => {
    interact.mockRejectedValueOnce(new Error('No element matched selector: #missing'))
    const result = await (
      await tools()
    )[WEB_INTERACT_TOOL].execute('t6', { action: 'click', selector: '#missing' })
    expect(text(result)).toBe('Error: No element matched selector: #missing')
  })
})
