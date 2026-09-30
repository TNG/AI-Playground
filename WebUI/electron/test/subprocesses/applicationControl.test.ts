import { describe, expect, it } from 'vitest'
import {
  APPLICATION_CONTROL_USER_MESSAGE,
  applicationControlHint,
} from '../../subprocesses/applicationControl.ts'

describe('applicationControlHint', () => {
  it.each([
    'error: Failed to spawn: `python.exe`\n  Caused by: An Application Control policy has blocked this file. (os error 4551)',
    'ImportError: DLL load failed while importing _core: An Application Control policy has blocked this file.',
    'CreateProcess failed: ERROR_VIRUS_INFECTED',
  ])('matches policy block text', (text) => {
    expect(applicationControlHint(text, 'linux')).toBe(APPLICATION_CONTROL_USER_MESSAGE)
  })

  it('treats a Windows spawn UNKNOWN as a blocked CreateProcess', () => {
    expect(applicationControlHint('spawn C:\\x\\uv.exe UNKNOWN', 'win32')).toBe(
      APPLICATION_CONTROL_USER_MESSAGE,
    )
  })

  it('ignores spawn UNKNOWN off Windows and unrelated failures', () => {
    expect(applicationControlHint('spawn uv UNKNOWN', 'linux')).toBeUndefined()
    expect(applicationControlHint('spawn uv ENOENT', 'win32')).toBeUndefined()
    expect(applicationControlHint('ModuleNotFoundError: torch', 'win32')).toBeUndefined()
  })
})
