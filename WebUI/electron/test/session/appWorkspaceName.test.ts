import { describe, expect, it } from 'vitest'
import { appWorkspaceName, safeFolderName } from '../../session/appWorkspaceName'

const NOV_19 = new Date(2026, 10, 19, 15, 30).getTime()
const ROOT = 'C:\\Users\\ada\\Documents\\AI-Playground\\Sessions'

describe("an app-created Workspace's name", () => {
  it('is the creation date and the title', () => {
    expect(appWorkspaceName(NOV_19, 'Cat poster', ROOT)).toBe('2026-11-19 Cat poster')
  })

  it('is "New session" until the Session has a title', () => {
    expect(appWorkspaceName(NOV_19, '', ROOT)).toBe('2026-11-19 New session')
    expect(appWorkspaceName(NOV_19, ' ?*/ ', ROOT)).toBe('2026-11-19 New session')
  })

  it('drops characters no OS allows and trailing dots and spaces', () => {
    expect(appWorkspaceName(NOV_19, 'a/b\\c: "d" <e>|f?*', ROOT)).toBe('2026-11-19 a b c d e f')
    expect(appWorkspaceName(NOV_19, 'tab\there\u0001', ROOT)).toBe('2026-11-19 tab here')
    expect(appWorkspaceName(NOV_19, 'Wait for it... ', ROOT)).toBe('2026-11-19 Wait for it')
  })

  it('caps the title so the deepest Artifact path stays under the Windows limit', () => {
    const long = 'word '.repeat(100)
    const name = appWorkspaceName(NOV_19, long, ROOT)
    const deepest = `${ROOT}\\${name} (99)\\${'x'.repeat(60)}`
    expect(deepest.length).toBeLessThan(260)
    expect(name.startsWith('2026-11-19 word word')).toBe(true)
    expect(name).not.toMatch(/[ .]$/)
  })

  it('is the date alone when the root leaves no room for a title', () => {
    expect(appWorkspaceName(NOV_19, 'Cat poster', `C:\\${'d'.repeat(180)}`)).toBe('2026-11-19')
  })
})

describe('a folder name safe on every OS', () => {
  it('suffixes Windows-reserved device names, with or without an extension', () => {
    expect(safeFolderName('CON')).toBe('CON_')
    expect(safeFolderName('nul')).toBe('nul_')
    expect(safeFolderName('com1.txt')).toBe('com1_.txt')
    expect(safeFolderName('LPT9')).toBe('LPT9_')
    expect(safeFolderName('Console')).toBe('Console')
  })

  it('leaves nothing of names made only of dots', () => {
    expect(safeFolderName('...')).toBe('')
    expect(safeFolderName('..')).toBe('')
  })
})
