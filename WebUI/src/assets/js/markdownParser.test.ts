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

describe('markdownParser raw HTML link rendering', () => {
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

  it('still escapes disallowed raw HTML', () => {
    const html = render('x <script>alert(1)</script> y')

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('still escapes anchors with unexpected attributes', () => {
    const html = render('<a href="https://x.com" onclick="alert(1)">x</a>')

    expect(html).toContain('&lt;a')
    expect(html).not.toContain('<a href')
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
})
