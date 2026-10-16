# Deployment / white-label configuration

> **Status: draft for stakeholder discussion.** This is a scoping note, not an
> implementation spec. It maps what we already have, what is cheap to open up,
> and what we should refuse to make configurable. Nothing here is committed
> product behaviour.

## Why this

OEMs and other deployments want to ship AI Playground with **their** defaults,
feature set, presets, and branding — without forking the product. We already
built toward that with product modes (studio / essentials / nvidia), demo /
kiosk mode, `settings.json`, and Acer co-branding. Those pieces solve different
jobs and do not compose into one “drop in a pack and this install is Acer /
kiosk / chat-only.”

The goal of a configuration feature is:

- One Intel codebase.
- A **data pack** (JSON + a few assets) that a deployment can supply.
- Predictable overrides for defaults, available features, custom presets, and
  branding.
- Maintenance cost that stays linear with the number of partners, not with the
  number of partners × SKUs × features.

## What we already have (do not rebuild)

Four mechanisms already exist. A white-label feature should **reuse and
generalize** them, not add a fifth parallel system.

| Mechanism | Job it actually does | Where it lives | What it can already change |
| --- | --- | --- | --- |
| **Product mode** | Hardware / stack SKU | `modes/{studio,essentials,nvidia}/mode.json` + `settings.json` `productMode` | Which presets ship (`includePresets` / `excludePresets`), which ComfyUI variant backends are dropped (`excludeVariantBackends`; essentials drops OpenVINO image variants), wizard copy, NVIDIA disables OpenVINO entirely |
| **Demo / kiosk profile** | Locked, resettable show-floor experience | `settings.json` `isDemoModeEnabled` + `modes/{mode}/demo/_profile.json` | Entire preset catalog swap, default chat/image presets and models, which UI modes exist, sample prompts, preloaded edit image, auto-reset + passcode, tour dots |
| **Machine settings** | Admin / deployment policy | Packaged `resources/settings.json`, overlaid by a per-user writable copy | Product mode, demo flags, `disabledBackends`, language lock, HuggingFace endpoint, remote GitHub repo for model/backend updates, OEM vendor override, debug UI gate, Agent-preset gate |
| **OEM co-branding** | Cosmetic partner identity, currently Acer-only | Firmware probe (`oemDetection.ts`) + `useOemBranding` | Display name of Game Agent / Quick Coder (“Acer Game Agent”), Arcade gallery on/off and its label. **Not** a feature flag, **not** a preset filter |

Related, but not a product identity:

- **User presets** — end-user JSON in a per-user folder. Fine for power users;
  not a partner catalog.
- **Installer `install-config.json`** — shared vs per-user model folders only.
- **`models.json` / `mcp.json` / `backend-versions.json`** — shipped catalogs,
  remotely refreshable from `remoteRepository`.
- **Build-time branding** — `productName`, icons, NSIS license, `VITE_PLATFORM_TITLE`
  (“from Intel®”), hardcoded “AI PLAYGROUND” in the title bar and footer.

`modes/base/demo/info.md` still describes an older `demoModePresetsDir` layout.
The running code loads `modes/{productMode}/demo` overlaying `modes/base/demo`.
Treat the code as source of truth.

## The gap

The three axes we care about are **independent**, but the code treats them as
special cases:

```
hardware SKU     studio | essentials | nvidia
kiosk lock       normal | demo (reset + frozen catalog)
partner identity Intel  | Acer | (future OEM)
```

Today they do not stack cleanly:

- Adding “Acer essentials” as a new `modes/acer-essentials/` would explode
  combinatorially (OEM × SKU × demo).
- Acer branding is `if (vendor === 'acer')` in the renderer. A second OEM
  copies that store.
- Acer VisionArt is a normal bundled preset (`modes/base/presets/AcerVisionArt_fluxQ4.json`)
  with an Acer custom node. It is **not** gated on OEM detection, so every
  install sees it.
- Feature hiding is incomplete outside demo mode. Demo can hide Video; there is
  no equivalent policy for Home Agent, Hybrid Cloud, Agent, the model manager,
  user-created presets, or MCP on a normal OEM SKU.
- Defaults (which chat preset/model is selected on first launch) exist only for
  demo. A non-demo Acer machine still boots whatever the last-used / catalog
  fallback is.
- The window title, footer (“Al Playground from Intel Corporation”), GitHub
  links, and Intel Core Ultra / Arc badges are source, not data.
- Product mode is a **closed Zod enum**. A partner cannot add a mode without a
  code change.

## Recommended shape: a deployment pack, as an overlay

Treat a deployment as **data that overlays the existing SKU**, not as a new
SKU.

```
┌─────────────────────────────────────────────────────────┐
│ 5. Per-user Pinia (theme, last-used preset, cloud keys) │  user preference
├─────────────────────────────────────────────────────────┤
│ 4. Writable settings.json                               │  this machine
├─────────────────────────────────────────────────────────┤
│ 3. Deployment pack (JSON + assets)          ← new       │  partner / SKU overlay
├─────────────────────────────────────────────────────────┤
│ 2. Product mode (studio / essentials / nvidia)          │  hardware SKU
├─────────────────────────────────────────────────────────┤
│ 1. Base catalog (modes/base/presets, models.json, …)    │  Intel product
└─────────────────────────────────────────────────────────┘
```

Rules that keep maintenance cheap:

1. **Compose, don’t replace.** Acer + essentials + demo is three overlays, not
   a fourth product mode. The pack never forks `mode.json`.
2. **Stable internal names.** Preset identity stays `"Game Agent"`. Branding is
   a label (`presetLabel()` already works this way). Last-used state, files on
   disk, and e2e locators keep working when the OEM changes.
3. **One resolved snapshot in main.** Main loads pack + settings + mode, Zod-
   validates, and hands the renderer a single `DeploymentConfig`. UI code asks
   the snapshot (`showsArcade`, `presetLabel`, `featureEnabled('homeAgent')`),
   never `if (vendor === 'acer')`.
4. **Unknown keys are stripped** (same as `models.json`). A partner typo cannot
   invent a feature; a schema bump is an intentional product change.
5. **No silent model downloads.** Selecting an OEM default preset still goes
   through the existing download dialog on first use.
6. **Identity keys are Intel’s.** Backend service names, IPC, and preset file
   names stay ours. The pack can hide or rename in the UI; it cannot register a
   new backend.

### How the pack is supplied

Two delivery models; they share the same schema. Pick per partner, not per
feature.

| | **Runtime pack (recommended default)** | **Co-branded rebuild** |
| --- | --- | --- |
| What the partner gets | Intel installer + a folder (or a thin wrapper installer that copies the folder) | `AI.Playground-<partner>.exe` from our CI |
| Where files live | e.g. `%PUBLIC%/AI Playground/deployment/` or next to `settings.json` | `extraResources` at pack time |
| Good for | Defaults, feature flags, extra presets, logo, copy | Installer name/icon/license, Start Menu shortcut, code signing, protocol handler |
| Partner engineering | Edit JSON, no rebuild | None — we build it |
| Our cost | One loader + schema | Build matrix + signing + release channel |

**Recommendation:** runtime pack is the product. Rebuild only for things Windows
treats as the application identity (see Tier 3). A fork of the repo per OEM is
out of scope.

Selection order for *which* pack applies:

1. Explicit `settings.json` `deploymentPack` (admin pin).
2. Else auto-detect OEM vendor **if** the pack opts into auto-apply.
3. Else Intel defaults (no pack).

Auto-apply is a policy choice, not an engineering one — see [Open questions](#open-questions-for-stakeholders).

## What to make configurable

Cost is “how many call sites, how often it bit-rots when we add a feature, how
easy a bad pack is to debug.” Value is “how often an OEM/kiosk/admin actually
asks for it.”

### Tier 1 — high value, already almost data (do these first)

These are either already a file, or a single boolean with one call site. The
work is a schema + wiring, not new product behaviour.

| Surface | Today | Pack field (illustrative) | Why it’s cheap |
| --- | --- | --- | --- |
| **Preset allow/deny** | `includePresets` / `excludePresets` on the product mode | Same lists on the pack, applied *after* the mode filter | Loader already exists in `getPresetLoadConfig` |
| **OEM-only extra presets** | Acer VisionArt lives in `modes/base/presets/` for everyone | Pack directory of extra preset JSON (+ images) | User-preset loader is the template; pack presets are just another directory |
| **Default chat / image preset + model** | Demo `_profile.json` only | Same `defaults` object for non-demo first launch | `applyDemoModeExplicitDefaults` already does this; run once when no last-used state exists |
| **Enabled UI modes** | Demo `enabledModes` | Same list for a locked SKU (e.g. chat-only essentials) | Prompt-area mode buttons already hide from this in demo |
| **Disabled backends** | `settings.json` `disabledBackends` (user wizard choice) | Pack default, still user-overridable unless locked | Service registry already honours the list |
| **Feature gates that already have a switch** | `isAgentPresetEnabled`; Home Agent is opt-in in the wizard; Hybrid Cloud is a Pinia flag | Pack `features: { agent, homeAgent, hybridCloud, userPresets, addModels }` | Each is one place today; promoting them to one map avoids new `if (acer)` |
| **Co-branding table** | Hardcoded Acer | `{ vendor, brand, coBrandedPresets, showsArcade, arcadeLabel }` | `oemBranding.ts` is already the single UI choke point |
| **Language lock** | `languageOverride` | Same | Already machine-level |
| **HuggingFace + update repo** | `huggingfaceEndpoint`, `remoteRepository` | Same | Already machine-level; an OEM air-gap or mirror is a settings copy |
| **Title-bar subtitle** | Build env `VITE_PLATFORM_TITLE` | Pack `branding.subtitle` | One string in `App.vue` |

Illustrative pack (not a committed schema):

```json
{
  "id": "acer",
  "autoApplyOnVendor": "acer",
  "branding": {
    "brand": "Acer",
    "subtitle": "from Acer",
    "coBrandedPresets": ["Game Agent", "Quick Coder"],
    "showsArcade": true,
    "arcadeLabel": "My Acer Arcade"
  },
  "features": {
    "agent": false,
    "homeAgent": true,
    "hybridCloud": true,
    "userPresets": true,
    "addModels": true
  },
  "includePresets": null,
  "excludePresets": [],
  "extraPresetsDir": "presets",
  "defaults": {
    "chatPreset": "Assistant",
    "chatModel": "unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q5_K_S.gguf"
  }
}
```

### Tier 2 — worth it, but needs new policy

Each of these is a real product decision plus a handful of call sites. Do them
once the pack loader exists, not before.

| Surface | Why an OEM wants it | Cost / risk |
| --- | --- | --- |
| **Model catalog allow/deny** | Hide huge / gated / competitor models; pin a small default list | `models.json` is remotely refreshed. A deny-list must apply *after* refresh or a catalog update undoes the OEM. Allow-list is safer for locked SKUs |
| **Wizard: which backends are offered / pre-selected** | Chat-only SKU should not offer ComfyUI; Home Agent default-on for a “home PC” OEM | `wizardInstallDefaults.ts` is already the policy module. Pack becomes its input. Risk: a pack that pre-selects Home Agent reintroduces the “install something nobody asked for” bug we just fixed |
| **Lock vs default** | Kiosk: user cannot enable Video. OEM: Video off by default, user may turn it on | Needs an explicit `locked: true` per feature/mode. Demo is 100% locked; confusing the two will make support painful |
| **Sample prompts outside demo** | OEM wants suggested prompts without kiosk reset | Demo profile already has the shape; PromptArea must read it when not in demo |
| **MCP server allow-list / extra servers** | Disable datetime MCP; add a partner MCP | `mcp.json` is already a file. Extra servers from a pack are easy; **shipping partner binaries** is not (signing, AV, support) |
| **Cloud provider allow-list** | Education SKU: no OpenAI, only a district endpoint | `CLOUD_PROVIDER_PRESETS` is a hardcoded array. Moving it to data is small; locking out “Custom” is a policy call |
| **About / footer copy** | Partner name, support URL, hide Intel GitHub | Footer is hardcoded (including a typo, “Al Playground”). Easy strings; **legal notices and 3rd-party licenses stay Intel’s** unless Legal says otherwise |
| **Default theme + allowed themes** | Light-only education; BMG for a show SKU | Four themes are a constant. Allow-list is cheap. **New theme artwork is not** (see Tier 3) |
| **Arcade sample games pack** | OEM wants their demos, not Intel’s | `external/arcade-samples` is already an extraResources tree. A pack can replace it. Keep samples nested so they never enter `listGames()` / `library.json` (current Acer rule) |

### Tier 3 — expensive, do not promise in v1

These look like “just branding” and are not.

| Surface | Why it is expensive |
| --- | --- |
| **Installer product name, icons, shortcuts, license RTF, NSIS pages** | `electron-builder` / NSIS. Needs a rebuild, a signing identity, possibly a different `appId` (two apps on one machine). This is a release-engineering product, not a JSON field |
| **Custom colour theme / logo / splash** | Themes (`lnl`, `bmg`, `light`, `dark`) are CSS + raster art + title-bar layout. Arbitrary CSS from a pack is a support and security surface. A *fixed* slot (logo PNG + one accent colour) is the most we should offer without a designer in the loop |
| **Full i18n of OEM strings across 13 locales** | `en-US.json` is the source of truth; every key must exist in every locale. OEM copy should stay in the pack as English (or a small per-locale overlay the OEM maintains). We should not take a 13-locale translation burden per partner |
| **Replacing Intel legal / notices** | Legal, not engineering. Footer links point at Intel GitHub `notices-disclaimers.md` |
| **Bundling different backend binaries or Python deps** | This is a different product. Product mode already switches CUDA vs XPU; that is the supported axis |
| **New backends, new IPC, new inference stacks** | Code, not configuration |
| **Per-control theming, custom chrome, hiding the setup wizard entirely** | Death by a thousand `v-if`s. If a partner needs a different app, that is a different app |

## What we should refuse (unless a stakeholder owns the cost)

- **A product mode per OEM.** Combinatorial. Overlay the existing three SKUs.
- **Fork-per-partner.** We will not keep Acer / Dell / education branches in
  sync with `dev`.
- **Runtime plugins** (arbitrary JS/Python from the pack). Security and
  support.
- **Auto-downloading OEM models at install.** Contradicts the existing
  on-demand download rule and blows install size / legal surface.
- **Translating the whole UI into a partner voice.** Labels and a subtitle,
  not a second i18n tree.
- **Making every hardcoded string a setting.** If a string has one call site
  and one OEM has asked once, change the source. If it is a repeated partner
  axis (name, logo, default preset), put it in the pack.

## How this relates to essentials and demo

Keep the three axes separate in the product conversation. They happen to share
files today, which is why they feel like “we already did white-label.”

| Axis | Question it answers | User can change it? |
| --- | --- | --- |
| **Product mode** | What hardware / stack is this machine? | Chosen once in the wizard (unless we lock it) |
| **Demo** | Is this a kiosk that must reset? | No — passcode. Frozen catalog, tour, auto-reset |
| **Deployment pack** | Whose product is this install? | No — admin/OEM. Branding, extra presets, feature policy |

Essentials is “low-power Intel, small preset list, no OpenVINO image
variants.” It is not “Acer” and it is not “demo.” An Acer essentials kiosk is
all three overlays at once, and that is the design test: if the pack design
cannot express that without a new `modes/` folder, it is wrong.

Demo should stay a kiosk mode. Do not overload `_profile.json` into the OEM
pack. Share *shapes* (defaults, enabledModes, samplePrompts) via a common
schema; keep the demo-only fields (passcode, reset timer, tour dots) out of
the OEM pack.

## Suggested first slice (after this discussion)

Enough to prove the model on a real partner SKU without boiling the ocean.

1. **Schema + loader in main** for a deployment pack directory. Zod, stripped
   unknown keys, logged when applied. Renderer gets one snapshot (IPC, same
   three-file rule as any other channel).
2. **Replace `if (acer)`** in `oemBranding.ts` with table data from the pack.
   Acer’s current behaviour becomes the first pack, shipped in-tree, auto-
   applied on Acer hardware *only if stakeholders still want auto-detect*.
3. **Move Acer VisionArt** out of `modes/base/presets/` into that pack’s extra
   presets directory, so non-Acer installs stop seeing it.
4. **Preset include/exclude + extra presets dir** on the pack, applied after
   product-mode filtering.
5. **Non-demo defaults** (chat preset/model) applied only when the user has no
   last-used state — so an OEM first-boot is theirs, and a returning user is
   not reset.
6. **Feature map** for Agent, Home Agent, Hybrid Cloud (hide the control; do
   not uninstall what is already there).

Out of the first slice: installer identity, custom themes, model allow-lists,
wizard redesign, i18n overlays.

## Open questions for stakeholders

These are the decisions that change the design. Engineering can implement any
combination; it cannot invent the answers.

1. **Who is the customer of v1?** One named OEM (Acer, since we already have
   the probe + Arcade + VisionArt), a kiosk/demo SKU, an education/admin lock-
   down, or a generic “partners edit JSON” promise? v1 should serve one of
   these fully rather than all of them halfway.
2. **Auto-detect vs explicit pin?** Today any Acer PC running the Intel build
   gets Arcade and “Acer Game Agent.” Is that still desired, or should Acer
   branding ship only with an Acer-signed installer / a packed `deploymentPack`?
   Auto-detect on a generic Intel install is surprising; pinning is extra
   release work.
3. **Lock or default?** When an OEM hides Video or Home Agent, may the user
   turn it back on in Settings? Kiosk = lock. Retail OEM = usually default.
   Mixing them without a `locked` bit will generate support tickets.
4. **Does Acer VisionArt belong on non-Acer machines?** It is in the base
   catalog today and pulls an Acer custom node. Gating it is a partner-IP /
   catalog decision, not a technical one.
5. **May a pack add presets that we do not review?** If yes, we own support
   for partner workflows, custom nodes, and model licenses. If no, extra
   presets go through Intel review and ship in our repo under `modes/` or a
   reviewed pack. This is the highest-cost question in the list.
6. **Rebuild or runtime pack for the first OEM?** If they need a different
   Start Menu name and icon, that is a rebuild regardless of the JSON pack.
   Confirm before we promise “just a folder.”
7. **Legal / about:** may a pack change the footer attribution and support
   URL? Must notices and licenses stay Intel’s?
8. **Hybrid Cloud and Home Agent on OEM SKUs?** Both talk to the network.
   Education and some OEM channels will want them off. They are currently
   user-enableable, not machine policy.
9. **Model catalog:** allow-list (small locked set) or deny-list (hide a few)?
   Allow-list survives a remote `models.json` refresh; deny-list does not
   unless we apply it after every refresh.
10. **Success metric for v1.** One OEM SKU shipping without a fork? Demo/kiosk
    expressed as a pack so we can delete special cases? Admin feature-lock for
    a managed PC? The first slice above assumes “one OEM SKU without a fork.”

## Appendix — current Acer / essentials / demo behaviour (for the meeting)

- **Acer, runtime:** Windows CIM manufacturer (or Acer registry hive) →
  `vendor: 'acer'`. Override: `settings.json` `oemVendorOverride` (Developer
  settings when `showDebugSettingsInUI`). Linux always `unknown` unless
  overridden. Branding is labels + Arcade; Game Agent’s files and tools do not
  change.
- **Arcade:** Acer-only UI. Samples live in `_arcade-samples/` so they never
  appear as Game Agent sessions and are omitted from `library.json` (portal
  upload).
- **Essentials:** `includePresets` of eight image/chat presets; OpenVINO
  ComfyUI variants stripped; recommended for PCI ids `0xFD80` / `0xFD81`.
  Video, Flux, agent, TTS/STT, etc. are simply not in the list.
- **Demo:** swaps the whole catalog to `modes/{mode}/demo`, applies
  `_profile.json` defaults every reset, optional idle auto-reset and passcode.
  Essentials demo already drops Video via `enabledModes`.
- **Agent preset:** hidden unless `isAgentPresetEnabled` (Developer checkbox,
  persisted in `settings.json`). Game Agent / Quick Coder are separate bundled
  presets, not behind that flag.
- **Home Agent:** wizard opt-in (`OPT_IN_BACKENDS`). Title-bar toggle only
  after it is installed. Not OEM-aware.
- **Hybrid Cloud:** renderer Pinia `isFeatureEnabled`, off by default, not in
  `settings.json`.
)
