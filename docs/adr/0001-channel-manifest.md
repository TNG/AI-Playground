---
status: accepted
---

# The IPC seam is stated once, in a channel manifest

The renderer↔main IPC seam (~200 channels) had its interface hand-copied across three files
(main.ts handlers, the preload bridge, env.d.ts types) — the "Three-File Rule" — with no
exhaustiveness check, and drift shipped: handlerless channels, a bridge invoking the wrong
channel, types promising results handlers never return. We decided to state each channel
once in a typed manifest in `WebUI/src/types/` (name, args, result, direction, envelope,
owner), from which all three sides derive, so a missing or mismatched channel is a build
error, not a runtime bug. This supersedes the Three-File Rule in AGENTS.md: a new channel is
one manifest row plus its handler in the owning module.

## Considered options

- **Zod schemas** — rejected: runtime validation is a tax on a trusted internal seam, and a
  second language for the same facts.
- **Build-time codegen** emitting preload/env.d.ts sections — rejected: the generator itself
  can drift and adds a build step; mapped types enforce the same check at compile time with
  nothing to generate.
- **Hand-shaped bridge, assignability-checked** — rejected: it keeps a second hand-designed
  shape the manifest merely audits. Bridge members derive by naming convention (flat → flat,
  `ns:name` → `ns.nameCamelCase`, `ns:sub:name` → two levels), with an explicit bridge-path
  override in the manifest row for the few channels that don't fit.
- **Big-bang migration** — rejected in favor of strangler-as-commit-sequencing: every
  intermediate tree is green and shippable, and the behavior changes bundled with the
  migration (drift fixes) stay bisectable. Batches land back-to-back, so there is no calendar
  cost; channel names stay verbatim and renaming stays out of scope.

## Consequences

- The manifest states the **target** discriminated error envelope; legacy-envelope channels
  converge as their slice migrates, absorbing the "one error envelope" deepening rather than
  keeping it as a separate pass. A channel whose conversion proves nontrivial may
  temporarily record its current shape instead of blocking its slice.
- Handler placement is unchanged (main.ts / homeAgentBackendService) — moving logic into
  adapters/ is a separate refactor. Clone policy (`cloneForIpc`) is also untouched.
- Enforcement is staged: typed `handle`/`invoke` wrappers land with the manifest; once most
  slices have migrated, stage-b switches to owner-scoped handler registries
  `satisfies`-checked against the manifest rows each owner claims, registration by loop, and
  a source-scan test forbidding raw `ipcMain.handle` outside the registration helpers (the
  `inferenceStoresNoDialogs.test.ts` pattern).
- This is not the externally versioned protocol that architecture-target §10#8 rejects:
  the manifest is internal, compile-time, and carries no wire format.

## Implemented

Batches 0–9c (`c94dce43`..`402345b1`) migrated the whole surface by strangler commits,
each landing green; stage-b enforcement closed it out (whole-object `satisfies ElectronApi`
in preload, the one-line `env.d.ts` derivation, and
`electron/test/kernel/ipcChannelRegistration.test.ts` as the registration scan).
Deviations from the staged plan above:

- **AskRow removed by evidence** — the `ask` direction never survived contact: an M→R ask
  is naturally two rows (a push for the question, an invoke for the answer,
  e.g. `chat:ask`/`chat:answer`), so the union is `invoke`/`send`/`push`.
- **Wrap-in-place registration kept** — handlers register through
  `typedHandle`/`typedOn`/`typedSend` at their call sites (main.ts / the Home Agent
  backend service) rather than owner-scoped registries driven by loop; the source-scan
  test provides the owner-exhaustiveness the registries were meant to buy, without
  moving handler code.
- **Kernel stream** — `kernel:event` and its preload listener stay hand-wired (one ordered
  event stream, infra, deliberately off-manifest; allowlisted in the scan test and declared
  in `IpcExtraBridgeMembers`); `kernel:getSnapshot` migrated as a normal invoke row.
