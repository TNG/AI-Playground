import { describe, expect, it } from 'vitest'
import {
  elevatedPowershellArgs,
  elevatedScriptBody,
} from '../../../adapters/install/elevatedBatch'

describe('elevatedScriptBody', () => {
  it('runs every non-blank step after echo off, with CRLF line ends', () => {
    expect(elevatedScriptBody(['a', ' ', 'b'])).toBe('@echo off\r\na\r\nb')
  })

  it('has nothing to elevate when every step is blank', () => {
    expect(elevatedScriptBody([' ', ''])).toBeNull()
  })
})

describe('elevatedPowershellArgs', () => {
  it('starts the script once under RunAs and escapes single quotes', () => {
    const args = elevatedPowershellArgs("x'y.cmd", 'w')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args.at(-1)).toBe(
      "Start-Process -FilePath 'x''y.cmd' -WorkingDirectory 'w' -Verb RunAs -Wait",
    )
  })
})
