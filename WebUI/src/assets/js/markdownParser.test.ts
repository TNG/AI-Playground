import { describe, expect, it } from 'vitest'
import { parse } from './markdownParser'

const render = (markdown: string) => parse(markdown) as string

describe('markdownParser link rendering', () => {
  it('marks explicit web links with the external-link icon', () => {
    const html = render('[Intel](https://intel.com)')

    expect(html).toContain('<a href="https://intel.com"')
    expect(html).toContain('>Intel <span class="svg-icon i-external-link external-link-icon"')
    expect(html).toContain('class="svg-icon i-external-link external-link-icon"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('marks GFM-autolinked bare URLs with the external-link icon', () => {
    const html = render('see https://intel.com now')

    expect(html).toContain('<a href="https://intel.com">https://intel.com')
    expect(html).toContain('i-external-link')
  })

  it('autolinks scheme-less www URLs to http and marks them with the icon', () => {
    const html = render('see www.intel.com now')

    expect(html).toContain('<a href="http://www.intel.com">www.intel.com')
    expect(html).toContain('i-external-link')
  })

  it('styles mailto links but adds no external-link icon', () => {
    const html = render('[contact](mailto:a@b.c)')

    expect(html).toContain('<a href="mailto:a@b.c">contact</a>')
    expect(html).not.toContain('i-external-link')
  })

  it('keeps nested inline formatting inside link text', () => {
    const html = render('[**bold** text](https://a.b)')

    expect(html).toContain('<a href="https://a.b"')
    expect(html).toContain('<strong>bold</strong> text')
  })

  it('keeps and escapes the link title attribute', () => {
    const html = render('[x](https://a.b "the title")')

    expect(html).toContain('title="the title"')
  })

  it('falls back to plain text for an unencodable href', () => {
    const html = render('[x](https://a\ud800b)')

    expect(html).toContain('<p>x</p>')
    expect(html).not.toContain('<a')
  })
})

describe('markdownParser raw HTML rendering', () => {
  it('renders raw anchor tags like markdown web links with the external-link icon', () => {
    const html = render('See <a href="https://intel.com">Intel</a> now')

    expect(html).toContain('<a href="https://intel.com">Intel')
    expect(html).toContain('i-external-link')
  })

  it('keeps safe anchor attributes and encodes the raw href', () => {
    const html = render('<a href="https://a.b/c d" target="_blank" rel="noopener">x</a>')

    expect(html).toContain('<a href="https://a.b/c%20d" target="_blank" rel="noopener">x')
    expect(html).toContain('i-external-link')
  })

  it('renders raw non-web anchors without the external-link icon', () => {
    const html = render('Mail <a href="mailto:a@b.c">us</a> today')

    expect(html).toContain('<a href="mailto:a@b.c">us</a>')
    expect(html).not.toContain('i-external-link')
  })

  it('renders underline wrappers around markdown links', () => {
    const html = render('<u>[Intel](https://intel.com)</u>')

    expect(html).toContain('<u><a href="https://intel.com"')
    expect(html).toContain('</a></u>')
    expect(html).toContain('i-external-link')
  })

  it('renders underline wrappers around plain text', () => {
    const html = render('Keep <u>this</u> underlined')

    expect(html).toContain('<u>this</u>')
  })

  it('renders any allowlisted formatting tag the assistant writes', () => {
    const html = render('a <b>bold</b> b <strong>strong</strong> c <em>italic</em>')

    expect(html).toContain('<b>bold</b>')
    expect(html).toContain('<strong>strong</strong>')
    expect(html).toContain('<em>italic</em>')
  })

  it('renders allowlisted block-level raw HTML', () => {
    const html = render('<div class="note">hello</div>')

    expect(html).toContain('<div class="note">hello</div>')
  })

  it('marks raw anchors with arbitrary attributes with the external-link icon', () => {
    const html = render(
      '<a href="https://x.com" style="font-weight: bold" class="font-bold">Intel</a>',
    )

    expect(html).toContain(
      '<a href="https://x.com" style="font-weight: bold" class="font-bold">Intel',
    )
    expect(html).toContain('i-external-link')
  })

  it('marks single-quoted and unquoted raw web anchors with the external-link icon', () => {
    const single = render("<a href='https://x.com'>Intel</a>")
    const unquoted = render('<a href=https://x.com>Intel</a>')

    expect(single).toContain('i-external-link')
    expect(unquoted).toContain('i-external-link')
  })

  it('adds no icon to single-quoted non-web anchors', () => {
    const html = render("<a href='mailto:a@b.c'>contact</a>")

    expect(html).toContain("<a href='mailto:a@b.c'>contact</a>")
    expect(html).not.toContain('i-external-link')
  })

  it('still escapes disallowed raw HTML', () => {
    const html = render(
      'x <script>alert(1)</script> y <iframe src="https://x.com"></iframe> z <strng>typo</strng>',
    )

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;iframe')
    expect(html).toContain('&lt;strng&gt;')
  })

  it('escapes a disallowed tag inside allowlisted tags', () => {
    const html = render('<b><script>alert(1)</script>still bold</b>')

    expect(html).toContain('<b>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('still bold</b>')
  })

  it('still escapes anchors with unencodable hrefs', () => {
    const html = render('<a href="https://a\ud800b">x</a>')

    expect(html).toContain('&lt;a')
  })

  it('does not touch raw anchors inside code blocks', () => {
    const html = render('```\n<a href="https://x.com">x</a>\n```')

    expect(html).not.toContain('i-external-link')
    expect(html).toContain('&lt;a href')
  })

  it('passes allowlisted tags with arbitrary attributes through to the sanitizer', () => {
    // Dangerous attributes are the sanitizer's job (sanitizeMarkdown/), not
    // the parser's: any tag on the allowlist goes through unescaped.
    const html = render('<a href="https://x.com" onclick="alert(1)">x</a>')

    expect(html).toContain('<a href="https://x.com" onclick="alert(1)">x')
  })
})
