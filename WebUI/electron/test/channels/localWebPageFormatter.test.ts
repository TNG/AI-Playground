import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, it, expect } from 'vitest'

const PAGE_PY = path.resolve(__dirname, '../../../../home-agent/channels/local_web_app_html.py')

// Answers every property read, call and `new` with itself, so the page's DOM wiring and
// startup fetch run without a browser; an awaited stub never settles.
function universalStub(): unknown {
  const stub: unknown = new Proxy(function () {}, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => '' : stub),
    apply: () => stub,
    construct: () => stub as object,
  })
  return stub
}

function loadFormatBotText(): (raw: string) => string {
  const source = readFileSync(PAGE_PY, 'utf-8')
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('no inline <script> in the served page')
  const stub = universalStub()
  const context = vm.createContext({
    document: stub,
    window: stub,
    localStorage: stub,
    navigator: stub,
    location: stub,
    fetch: stub,
    EventSource: stub,
    FileReader: stub,
    setTimeout: () => 0,
    clearTimeout: () => {},
  })
  vm.runInContext(script, context, { filename: 'local_web_app_html.js' })
  return context.formatBotText
}

const formatBotText = loadFormatBotText()
const think = (label: string, body: string) =>
  `${String.fromCharCode(1)}${label}${String.fromCharCode(2)}${body}${String.fromCharCode(3)}`

describe('LAN chat page formatter', () => {
  it('keeps bold, inline code, emphasis sentinels and line breaks', () => {
    expect(formatBotText('a **b** `c`\nd')).toBe('a <strong>b</strong> <code>c</code><br>d')
    expect(formatBotText(`x ${String.fromCharCode(5)}prompt${String.fromCharCode(6)}`)).toBe(
      'x <em>prompt</em>',
    )
  })

  it('escapes HTML in plain text', () => {
    expect(formatBotText('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('renders a fenced code block with escaped, unformatted contents', () => {
    expect(formatBotText('Run:\n```js\nif (a < b) **x**\n```\ndone')).toBe(
      'Run:<pre><code>if (a &lt; b) **x**</code></pre>done',
    )
  })

  it('keeps an inline code span literal: no link, no bold inside it', () => {
    expect(formatBotText('see `[x](https://a.b)` and `**y**`')).toBe(
      'see <code>[x](https://a.b)</code> and <code>**y**</code>',
    )
  })

  it('keeps emphasis sentinels literal inside a fenced code block', () => {
    const em = `${String.fromCharCode(5)}p${String.fromCharCode(6)}`
    expect(formatBotText(`\`\`\`\nx ${em}\n\`\`\`\n${em}`)).toBe(
      `<pre><code>x ${em}</code></pre><em>p</em>`,
    )
  })

  it('applies emphasis that spans lines of one paragraph', () => {
    const em = `${String.fromCharCode(5)}a\nb${String.fromCharCode(6)}`
    expect(formatBotText(`x ${em}`)).toBe('x <em>a<br>b</em>')
  })

  it('renders an unclosed fence (a streaming draft) as a code block to the end', () => {
    expect(formatBotText('```\nconst a = 1\n<b>')).toBe(
      '<pre><code>const a = 1\n&lt;b&gt;</code></pre>',
    )
  })

  it('renders headings with inline formatting', () => {
    expect(formatBotText('# Title\n### Sub **bold**\ntext')).toBe(
      '<h1>Title</h1><h3>Sub <strong>bold</strong></h3>text',
    )
  })

  it('renders bullet and numbered lists', () => {
    expect(formatBotText('Steps:\n\n- one\n* `two`\n\n3. three\n4. four\n\nEnd')).toBe(
      'Steps:<ul><li>one</li><li><code>two</code></li></ul>' +
        '<ol start="3"><li>three</li><li>four</li></ol>End',
    )
  })

  it('ends a list at the first line that is not an item, and keeps that line', () => {
    expect(formatBotText('- a\n- b\nafter\n1. c\n```\nx\n```')).toBe(
      '<ul><li>a</li><li>b</li></ul>after<ol><li>c</li></ol><pre><code>x</code></pre>',
    )
  })

  it('renders links with safe schemes as anchors', () => {
    expect(formatBotText('see [docs](https://example.com/a?b=1&c=2)')).toBe(
      'see <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a>',
    )
    expect(formatBotText('[mail](mailto:a@b.c)')).toContain('<a href="mailto:a@b.c"')
  })

  it('leaves links with other schemes as text', () => {
    expect(formatBotText('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))')
    expect(formatBotText('[x](data:text/html,hi)')).toBe('[x](data:text/html,hi)')
    expect(formatBotText('[x](JavaScript:alert(1))')).not.toContain('<a')
  })

  it('cannot break out of a link attribute', () => {
    expect(formatBotText('[x](https://a"onmouseover="alert(1))')).not.toContain('"onmouseover')
  })

  it('renders reasoning as a collapsed block whose body is formatted too', () => {
    expect(formatBotText(`${think('Thought for 1.0 seconds', 'a **b**\n- c')}\n\nAnswer`)).toBe(
      '<details class="reasoning"><summary>💭 Thought for 1.0 seconds</summary>' +
        '<div class="reasoning-body">a <strong>b</strong><ul><li>c</li></ul></div></details>Answer',
    )
    expect(formatBotText(think('', 'hmm'))).toContain('<summary>💭 Thinking…</summary>')
  })
})
