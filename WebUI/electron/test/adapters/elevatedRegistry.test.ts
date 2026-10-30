import { describe, expect, it } from 'vitest'
import { buildElevationCommand, buildRegistryScript } from '../../adapters/elevatedRegistry'

const key = 'HKLM\\SOFTWARE\\AI Playground'

describe('buildRegistryScript', () => {
  it('adds and deletes values in the 64-bit view, stopping at the first failure', () => {
    const script = buildRegistryScript(key, [
      { action: 'set', name: 'demoModePasscode', type: 'REG_SZ', data: 'pbkdf2$600000$c2E=$aA==' },
      { action: 'delete', name: 'demoModeResetInSeconds' },
      { action: 'set', name: 'isDemoModeEnabled', type: 'REG_DWORD', data: 1 },
    ])

    expect(script.split('\n')).toEqual([
      "& reg.exe add 'HKLM\\SOFTWARE\\AI Playground' /v 'demoModePasscode' /t REG_SZ " +
        "/d 'pbkdf2$600000$c2E=$aA==' /f /reg:64 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 }",
      "& reg.exe query 'HKLM\\SOFTWARE\\AI Playground' /v 'demoModeResetInSeconds' /reg:64 *> $null; " +
        "if ($LASTEXITCODE -eq 0) { & reg.exe delete 'HKLM\\SOFTWARE\\AI Playground' " +
        "/v 'demoModeResetInSeconds' /f /reg:64 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 } }",
      "& reg.exe add 'HKLM\\SOFTWARE\\AI Playground' /v 'isDemoModeEnabled' /t REG_DWORD " +
        '/d 1 /f /reg:64 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 }',
      'exit 0',
    ])
  })

  it('restores the previous values when a write fails, ignoring failures while restoring', () => {
    const script = buildRegistryScript(
      key,
      [
        { action: 'set', name: 'demoModePasscode', type: 'REG_SZ', data: 'pbkdf2$1$bmV3$bmV3' },
        { action: 'set', name: 'isDemoModeEnabled', type: 'REG_DWORD', data: 1 },
      ],
      [
        { action: 'set', name: 'demoModePasscode', type: 'REG_SZ', data: 'pbkdf2$1$b2xk$b2xk' },
        { action: 'delete', name: 'demoModeResetInSeconds' },
      ],
    )

    const restore = 'if ($LASTEXITCODE -ne 0) { Restore-Previous; exit 1 }'
    expect(script.split('\n')).toEqual([
      'function Restore-Previous {',
      "  & reg.exe add 'HKLM\\SOFTWARE\\AI Playground' /v 'demoModePasscode' /t REG_SZ " +
        "/d 'pbkdf2$1$b2xk$b2xk' /f /reg:64 *> $null",
      "  & reg.exe delete 'HKLM\\SOFTWARE\\AI Playground' /v 'demoModeResetInSeconds' " +
        '/f /reg:64 *> $null',
      '}',
      "& reg.exe add 'HKLM\\SOFTWARE\\AI Playground' /v 'demoModePasscode' /t REG_SZ " +
        `/d 'pbkdf2$1$bmV3$bmV3' /f /reg:64 | Out-Null; ${restore}`,
      "& reg.exe add 'HKLM\\SOFTWARE\\AI Playground' /v 'isDemoModeEnabled' /t REG_DWORD " +
        `/d 1 /f /reg:64 | Out-Null; ${restore}`,
      'exit 0',
    ])
  })

  it.each([
    ['a quote in a string', { action: 'set', name: 'x', type: 'REG_SZ', data: "a'; calc; '" }],
    ['a space in a string', { action: 'set', name: 'x', type: 'REG_SZ', data: 'a b' }],
    ['a value name with a quote', { action: 'delete', name: "x' -or '" }],
    ['a negative DWORD', { action: 'set', name: 'x', type: 'REG_DWORD', data: -1 }],
    ['a fractional DWORD', { action: 'set', name: 'x', type: 'REG_DWORD', data: 1.5 }],
  ] as const)('refuses %s', (_label, change) => {
    expect(() => buildRegistryScript(key, [change])).toThrow()
  })
})

describe('buildElevationCommand', () => {
  it('runs the script elevated as encoded data and passes its exit code through', () => {
    const command = buildElevationCommand('exit 0')
    const encoded = Buffer.from('exit 0', 'utf16le').toString('base64')

    expect(command).toBe(
      "try { $p = Start-Process -FilePath 'powershell.exe' " +
        `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' ` +
        '-Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop } ' +
        'catch { exit 1223 }; exit $p.ExitCode',
    )
  })
})
