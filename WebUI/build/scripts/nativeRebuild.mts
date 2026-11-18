/**
 * better-sqlite3 publishes no Electron 44 binary, so electron-builder compiles it.
 * That compile needs Visual Studio. Without it, skip the rebuild and still package.
 */
export function nativeRebuildArgs(input: {
  platform: NodeJS.Platform
  forced: string | undefined
  hasMsvc: boolean
}): { args: string[]; notice?: string } {
  if (input.forced === '1') return { args: [] }
  const skip = input.forced === '0' || (input.platform === 'win32' && !input.hasMsvc)
  if (!skip) return { args: [] }
  return {
    args: ['-c.npmRebuild=false'],
    notice:
      'Visual Studio C++ tools were not found, so native addons are not recompiled. Persistent memory will be unavailable in this build. The installer is still produced.',
  }
}
