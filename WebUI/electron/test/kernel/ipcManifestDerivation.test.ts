import { describe, expectTypeOf, it } from 'vitest'
import type { BridgeMemberFor, ElectronApi, NamespaceBridge } from '@/types/ipcChannels'

// Compile-time derivation tests: vue-tsc enforces every assertion here (an
// `expectTypeOf` mismatch is a type error), while vitest runs the blocks as
// trivially green. They pin the three `member`-override placement rules.

describe('channel manifest bridge-path derivation', () => {
  it('places a dotted-member channel at its cross-group path', () => {
    expectTypeOf<ElectronApi['homeAgent']['saveDocument']>().toEqualTypeOf<
      BridgeMemberFor<'saveHomeAgentDocument'>
    >()
    expectTypeOf<ElectronApi>().not.toHaveProperty('saveHomeAgentDocument')
  })

  it('places a dotted member inside a nested sub-group', () => {
    expectTypeOf<ElectronApi['homeAgent']['channel']['saveConfig']>().toEqualTypeOf<
      BridgeMemberFor<'channel:saveConfig'>
    >()
    expectTypeOf<NamespaceBridge<'homeAgent'>>().not.toHaveProperty('saveConfig')
  })

  it('derives ns:sub:leaf channels two levels deep without an override', () => {
    expectTypeOf<ElectronApi['homeAgent']['localWeb']['getUrls']>().toEqualTypeOf<
      BridgeMemberFor<'homeAgent:localWeb:getUrls'>
    >()
    expectTypeOf<NamespaceBridge<'homeAgent'>>().not.toHaveProperty('getUrls')
  })

  it('places a flat-flagged namespaced channel at the top level', () => {
    expectTypeOf<ElectronApi['setLifecycleBusy']>().toEqualTypeOf<
      BridgeMemberFor<'lifecycle:busy'>
    >()
    expectTypeOf<ElectronApi>().not.toHaveProperty('lifecycle')
  })

  it('keeps a dot-less member override a leaf rename inside its own group', () => {
    expectTypeOf<NamespaceBridge<'agentMode'>['submitToolResult']>().toEqualTypeOf<
      BridgeMemberFor<'agentMode:toolResult'>
    >()
    expectTypeOf<NamespaceBridge<'agentMode'>>().not.toHaveProperty('toolResult')
    expectTypeOf<ElectronApi>().not.toHaveProperty('submitToolResult')
  })

  it('derives the raw push listener under its on-prefixed member name', () => {
    expectTypeOf<NamespaceBridge<'webBrowser'>['onStateChanged']>().toEqualTypeOf<
      BridgeMemberFor<'webBrowser:stateChanged'>
    >()
    // raw: the renderer listener returns no unsubscribe
    expectTypeOf<
      ReturnType<NamespaceBridge<'webBrowser'>['onStateChanged']>
    >().toEqualTypeOf<void>()
  })

  it('keeps every migrated group member reachable through its derived path', () => {
    expectTypeOf<ElectronApi['webBrowser']['navigate']>().toEqualTypeOf<
      BridgeMemberFor<'webBrowser:navigate'>
    >()
    expectTypeOf<ElectronApi['homeAgent']['channel']['send']>().toEqualTypeOf<
      BridgeMemberFor<'channel:send'>
    >()
  })
})
