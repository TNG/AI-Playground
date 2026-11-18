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
