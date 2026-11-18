import { describe, expect, it } from 'vitest'
import { nativeRebuildArgs } from './nativeRebuild.mts'

describe('nativeRebuildArgs', () => {
  it('keeps the rebuild on Windows when Visual Studio is installed', () => {
    expect(nativeRebuildArgs({ platform: 'win32', forced: undefined, hasMsvc: true }).args).toEqual(
      [],
    )
  })

  it('skips the rebuild on Windows when Visual Studio is missing', () => {
    const result = nativeRebuildArgs({ platform: 'win32', forced: undefined, hasMsvc: false })
    expect(result.args).toEqual(['-c.npmRebuild=false'])
    expect(result.notice).toContain('Persistent memory')
  })

  it('does not skip the rebuild on other platforms', () => {
    expect(
      nativeRebuildArgs({ platform: 'linux', forced: undefined, hasMsvc: false }).args,
    ).toEqual([])
  })

  it('honors an explicit override', () => {
    expect(nativeRebuildArgs({ platform: 'win32', forced: '1', hasMsvc: false }).args).toEqual([])
    expect(nativeRebuildArgs({ platform: 'linux', forced: '0', hasMsvc: true }).args).toEqual([
      '-c.npmRebuild=false',
    ])
  })
})
