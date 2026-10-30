import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalSettingsSchema } from '../../kernel/localSettings'

const SCRIPT = path.resolve(__dirname, '../../../build/demo-mode-settings.ps1')
const BUNDLED_SETTINGS = path.resolve(__dirname, '../../../build/settings.json')
const PASSCODE_ENV = 'AIPG_DEMO_PASSCODE'
const RESET_ENV = 'AIPG_DEMO_RESET'

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0

type DemoValues = { enabled: string; passcode: string | undefined; resetMinutes: string }

const DEFAULTS: DemoValues = { enabled: '1', passcode: '0451', resetMinutes: '5' }

function writeDemoMode(file: string, values: Partial<DemoValues> = {}) {
  const { enabled, passcode, resetMinutes } = { ...DEFAULTS, ...values }
  const env = { ...process.env }
  delete env[PASSCODE_ENV]
  if (passcode !== undefined) env[PASSCODE_ENV] = passcode
  return spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      SCRIPT,
      'write',
      '-Path',
      file,
      '-Enabled',
      enabled,
      '-ResetMinutes',
      resetMinutes,
    ],
    { encoding: 'utf8', env },
  )
}

function writeOk(file: string, values: Partial<DemoValues> = {}) {
  const result = writeDemoMode(file, values)
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  return fs.readFileSync(file, 'utf8')
}

function expectAppReads(
  text: string,
  expected: { enabled: boolean; passcode: string; resetInSeconds: number | null },
) {
  const settings = LocalSettingsSchema.parse(JSON.parse(text))
  expect(settings.isDemoModeEnabled).toBe(expected.enabled)
  expect(settings.demoModePasscode).toBe(expected.passcode)
  expect(settings.demoModeResetInSeconds).toBe(expected.resetInSeconds)
}

describe.skipIf(!hasPwsh)('demo-mode-settings.ps1 write', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-demo-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('turns Demo Mode on in the bundled settings.json, keeping its other keys, as 2-space JSON', () => {
    const file = path.join(dir, 'settings.json')
    fs.copyFileSync(BUNDLED_SETTINGS, file)

    const text = writeOk(file)

    expect(text).toBe(
      [
        '{',
        '  "isDemoModeEnabled": true,',
        '  "openvinoImageGenDevices": [',
        '    "CPU",',
        '    "GPU"',
        '  ],',
        '  "demoModePasscode": "0451",',
        '  "demoModeResetInSeconds": 300',
        '}',
        '',
      ].join('\n'),
    )
    expectAppReads(text, { enabled: true, passcode: '0451', resetInSeconds: 300 })
  })

  it('leaves every unrelated key of a full app-written settings.json unchanged', () => {
    const file = path.join(dir, 'settings.json')
    const existing = {
      productMode: 'nvidia',
      isDemoModeEnabled: false,
      demoModeResetInSeconds: 60,
      demoModePasscode: 'old',
      languageOverride: null,
      disabledBackends: [],
      deviceArchOverride: {},
      huggingfaceEndpoint: 'https://hf.example/path?a=1&b=<2>',
      comfyUiParameters: '--flag "quoted" \\ back\tslash',
      oemVendorOverride: 'Grüße 漢字 😀',
      versionOverrides: {
        'llamacpp-backend': { version: 'b5000', releaseTag: 'v1.0.0' },
        'comfyui-backend': { version: '0.3.1', nested: { deeper: [1, 2.5, -3e-7, true, null] } },
      },
      openvinoKvCacheU4: true,
      someRatio: 0.1,
    }
    fs.writeFileSync(file, JSON.stringify(existing, null, 2))

    const text = writeOk(file)

    expect(text).toBe(
      JSON.stringify(
        {
          ...existing,
          isDemoModeEnabled: true,
          demoModeResetInSeconds: 300,
          demoModePasscode: '0451',
        },
        null,
        2,
      ),
    )
    expectAppReads(text, { enabled: true, passcode: '0451', resetInSeconds: 300 })
  })

  it('creates settings.json when it is missing', () => {
    const file = path.join(dir, 'settings.json')

    const text = writeOk(file)

    expect(JSON.parse(text)).toEqual({
      isDemoModeEnabled: true,
      demoModePasscode: '0451',
      demoModeResetInSeconds: 300,
    })
    expectAppReads(text, { enabled: true, passcode: '0451', resetInSeconds: 300 })
  })

  it('converts the Demo Reset Timeout from minutes to seconds', () => {
    const file = path.join(dir, 'settings.json')

    const text = writeOk(file, { resetMinutes: '12' })

    expectAppReads(text, { enabled: true, passcode: '0451', resetInSeconds: 720 })
  })

  it.each([
    ['empty', ''],
    ['0', '0'],
  ])('writes no Demo Reset (null) for %s minutes', (_label, resetMinutes) => {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ demoModeResetInSeconds: 300 }, null, 2))

    const text = writeOk(file, { resetMinutes })

    expect(JSON.parse(text).demoModeResetInSeconds).toBeNull()
    expectAppReads(text, { enabled: true, passcode: '0451', resetInSeconds: null })
  })

  it('turns Demo Mode off', () => {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ isDemoModeEnabled: true }, null, 2))

    const text = writeOk(file, { enabled: '0' })

    expectAppReads(text, { enabled: false, passcode: '0451', resetInSeconds: 300 })
  })

  it.each([
    ['quotes, spaces, backslashes and non-ASCII', 'pä "ß" \\ 1'],
    ['a leading dash that reads like a parameter', '-Path x'],
    ['a backslash before a quote', 'ab\\" c\\'],
    ['PowerShell syntax', '$(exit 3); `n'],
  ])('keeps a Demo Passcode with %s verbatim', (_label, passcode) => {
    const file = path.join(dir, 'settings.json')

    const text = writeOk(file, { passcode })

    expectAppReads(text, { enabled: true, passcode, resetInSeconds: 300 })
  })

  it.each([
    ['an empty', ''],
    ['an unset', undefined],
  ])(
    'refuses %s Demo Passcode while Demo Mode is on, leaving the file untouched',
    (_l, passcode) => {
      const file = path.join(dir, 'settings.json')
      const before = JSON.stringify({ isDemoModeEnabled: false }, null, 2)
      fs.writeFileSync(file, before)

      const result = writeDemoMode(file, { passcode })

      expect(result.status).toBe(2)
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
    },
  )

  it.each([
    ['an empty', ''],
    ['an unset', undefined],
  ])('writes the default Demo Passcode for %s one while Demo Mode is off', (_l, passcode) => {
    const file = path.join(dir, 'settings.json')

    const text = writeOk(file, { enabled: '0', passcode })

    expectAppReads(text, { enabled: false, passcode: '0451', resetInSeconds: 300 })
  })

  it.each(['-1', '2.5', 'five', '1000000'])(
    'refuses %s minutes and leaves the file untouched',
    (minutes) => {
      const file = path.join(dir, 'settings.json')
      const before = JSON.stringify({ isDemoModeEnabled: false }, null, 2)
      fs.writeFileSync(file, before)

      const result = writeDemoMode(file, { resetMinutes: minutes })

      expect(result.status).not.toBe(0)
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
    },
  )
})

/** file undefined: no previous install. resetParameter: the raw /DEMORESET value, if given. */
function readDemoMode(file: string | undefined, resetParameter?: string) {
  const env = { ...process.env }
  delete env[RESET_ENV]
  if (resetParameter !== undefined) env[RESET_ENV] = resetParameter
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      SCRIPT,
      'read',
      ...(file === undefined ? [] : ['-Path', file]),
      '-ResultPath',
      resultFile,
    ],
    { encoding: 'utf8', env },
  )
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  const lines = fs.readFileSync(resultFile).toString('utf16le').split('\r\n')
  expect(lines).toHaveLength(4)
  expect(lines[3]).toBe('')
  return { enabled: lines[0], passcode: lines[2], resetMinutes: lines[1] }
}

let resultFile: string

describe.skipIf(!hasPwsh)('demo-mode-settings.ps1 read', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-demo-'))
    file = path.join(dir, 'settings.json')
    resultFile = path.join(dir, 'demo-read.txt')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads back what write wrote', () => {
    writeOk(file, { enabled: '0', passcode: 'shop-7', resetMinutes: '12' })

    expect(readDemoMode(file)).toEqual({ enabled: '0', passcode: 'shop-7', resetMinutes: '12' })
  })

  it.each([
    ['quotes, =, spaces, backslashes and non-ASCII', ' pä "ß"=1 \\ 漢字 😀 '],
    ['a leading dash', '-Path x'],
    ['PowerShell syntax', '$(exit 3); `n'],
  ])('round-trips a Demo Passcode with %s', (_label, passcode) => {
    writeOk(file, { passcode })

    expect(readDemoMode(file)).toEqual({ enabled: '1', passcode, resetMinutes: '5' })
  })

  it('reads a hand-edited file with a BOM and escapes', () => {
    fs.writeFileSync(
      file,
      '﻿{ "demoModeResetInSeconds": 600, "isDemoModeEnabled": true, "demoModePasscode": "a\\"b\\u00e9" }',
    )

    expect(readDemoMode(file)).toEqual({ enabled: '1', passcode: 'a"bé', resetMinutes: '10' })
  })

  it('reads the defaults, Demo Mode on, from a release that predates the Demo Mode page', () => {
    fs.copyFileSync(BUNDLED_SETTINGS, file)

    expect(readDemoMode(file)).toEqual(DEFAULTS)
  })

  it('reads the defaults when Demo Mode was never configured, whatever the other keys say', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ isDemoModeEnabled: false, demoModeResetInSeconds: null }, null, 2),
    )

    expect(readDemoMode(file)).toEqual(DEFAULTS)
  })

  it('keeps a configured Demo Mode that is off', () => {
    fs.writeFileSync(file, JSON.stringify({ isDemoModeEnabled: false, demoModePasscode: 'shop' }))

    expect(readDemoMode(file)).toEqual({ enabled: '0', passcode: 'shop', resetMinutes: '5' })
  })

  it('reads the defaults from a file without Demo Mode keys', () => {
    fs.writeFileSync(file, JSON.stringify({ productMode: 'nvidia' }, null, 2))

    expect(readDemoMode(file)).toEqual(DEFAULTS)
  })

  it('reads the defaults when there is no file', () => {
    expect(readDemoMode(file)).toEqual(DEFAULTS)
  })

  it('reads the defaults when there is no previous install', () => {
    expect(readDemoMode(undefined)).toEqual(DEFAULTS)
  })

  it.each([
    ['not JSON', '{ "isDemoModeEnabled": false, '],
    ['not an object', '[false]'],
    ['empty', ''],
  ])('reads the defaults from a file that is %s, rather than failing the install', (_l, text) => {
    fs.writeFileSync(file, text)

    expect(readDemoMode(file)).toEqual(DEFAULTS)
  })

  it('reads no Demo Reset (null) as an empty timeout', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ demoModePasscode: 'shop', demoModeResetInSeconds: null }),
    )

    expect(readDemoMode(file).resetMinutes).toBe('')
  })

  it.each([
    [90, '2'],
    [61, '2'],
    [60, '1'],
    [1, '1'],
    [59.5, '1'],
    [3e3, '50'],
  ])('rounds %s seconds up to %s minutes, so the reset never fires early', (seconds, minutes) => {
    fs.writeFileSync(
      file,
      JSON.stringify({ demoModePasscode: 'shop', demoModeResetInSeconds: seconds }),
    )

    expect(readDemoMode(file).resetMinutes).toBe(minutes)
  })

  it.each([
    ['an empty passcode', { demoModePasscode: '' }, { passcode: '0451' }],
    ['a passcode with a line break', { demoModePasscode: 'a\nb' }, { passcode: '0451' }],
    ['a numeric passcode', { demoModePasscode: 451 }, { passcode: '0451' }],
    ['a string for enabled', { isDemoModeEnabled: 'yes' }, { enabled: '1' }],
    ['a zero timeout', { demoModeResetInSeconds: 0 }, {}],
    ['a negative timeout', { demoModeResetInSeconds: -60 }, {}],
    ['a string timeout', { demoModeResetInSeconds: '300' }, {}],
    ['a timeout past the page limit', { demoModeResetInSeconds: 1e12 }, { resetMinutes: '999999' }],
  ])('reads %s as a value the installer can write back', (_label, settings, expected) => {
    const configured = { isDemoModeEnabled: false, demoModePasscode: 'shop', ...settings }
    fs.writeFileSync(file, JSON.stringify(configured))

    expect(readDemoMode(file)).toEqual({
      enabled: '0',
      passcode: 'shop',
      resetMinutes: '5',
      ...expected,
    })
  })

  describe('with a /DEMORESET parameter', () => {
    beforeEach(() => {
      writeOk(file, { enabled: '0', passcode: 'shop', resetMinutes: '10' })
    })

    it('reads the parameter over the installed timeout', () => {
      expect(readDemoMode(file, '12')).toEqual({
        enabled: '0',
        passcode: 'shop',
        resetMinutes: '12',
      })
    })

    it.each(['', '0'])('reads %j as no Demo Reset', (parameter) => {
      expect(readDemoMode(file, parameter).resetMinutes).toBe('')
    })

    it.each(['five', '-1', '2.5', '1000000', '-Path x'])(
      'reads an invalid %j as 5 minutes, not the installed timeout',
      (parameter) => {
        expect(readDemoMode(file, parameter).resetMinutes).toBe('5')
      },
    )

    it('applies over the defaults when there is no previous install', () => {
      expect(readDemoMode(undefined, '0')).toEqual({ ...DEFAULTS, resetMinutes: '' })
    })
  })
})
