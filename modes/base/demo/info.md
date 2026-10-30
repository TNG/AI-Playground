This folder contains the presets used in **Demo Mode**. The presets of the product mode's own
`modes/<productMode>/demo` folder are layered over them by name.

## Settings

Demo Mode is configured by three keys in `settings.json` (`LocalSettingsSchema` in
`WebUI/electron/kernel/localSettings.ts`):

| Key                      | Type           | Description                                                                                          |
| ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------- |
| `isDemoModeEnabled`      | boolean        | Turns Demo Mode on. Without the key, Demo Mode is off.                                               |
| `demoModePasscode`       | string         | The **Demo Passcode** staff enter to leave Demo Mode. Plain text.                                    |
| `demoModeResetInSeconds` | number \| null | The **Demo Reset Timeout** in seconds. `null` (the default without the key) means no **Demo Reset**. |

## Installer

The Windows installer writes all three keys into the installed `resources\settings.json` on every
install, per-user and all-users alike, and keeps every other key in the file. The work is done by
`WebUI/build/demo-mode-settings.ps1`, run from `WebUI/build/installer.nsh`.

An interactive install shows a Demo Mode page after the Shared resources page: an "Enable Demo
Mode" checkbox, the Demo Passcode and the Demo Reset Timeout in whole minutes, where empty or 0
means no Demo Reset. Next is blocked while the box is ticked and the passcode is empty or the
timeout is not a whole number of minutes. The installer never writes an empty Demo Passcode: with
the box unticked and the field cleared, it writes `0451`.

The values start from the defaults (Demo Mode on, Demo Passcode `0451`, a 5-minute Demo Reset
Timeout). Each later source overrides the one before it:

1. the defaults;
2. the previous install's `resources\settings.json`, so an upgrade keeps the values on the device,
   hand-edited ones included (a timeout in seconds is rounded up to whole minutes). A file without
   `demoModePasscode` comes from a release before the Demo Mode page, which shipped
   `isDemoModeEnabled: false`; it counts as never configured and reads as the defaults;
3. the installer parameters below.

The result prefills the page, or is written directly by a silent install (`/S`).

| Parameter              | Effect                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `/DEMO=0` \| `/DEMO=1` | Turns Demo Mode off or on.                                                                        |
| `/DEMOPASSCODE=<text>` | Sets the Demo Passcode. An empty value is ignored.                                                |
| `/DEMORESET=<minutes>` | Sets the Demo Reset Timeout. Empty or `0` turns Demo Reset off; an invalid value gives 5 minutes. |

An invalid `/DEMORESET` gives 5 minutes even on an upgrade, rather than keeping the installed
timeout.

How an install mode picks the file up:

- **Per-user install:** it is the app's only `settings.json`.
- **All-users install:** the installer's values are the machine default, so every account starts
  with them. Each account gets its own copy, so leaving Demo Mode on one account leaves the others
  in Demo Mode.
- **Upgrade:** an account's own choice, including having left Demo Mode, is reset to the
  installer's values. On an all-users install with shared resources, an account that already has
  its own copy keeps it, so a reinstall with different values does not reach that account.

## Presets

The logic is intentionally kept simple, no deepmerging from multiple places or similar:

- When in demo mode, all presets are taken from this folder
- If a preset should appear during demo, the json must exist here

To disable only sliders/checkboxes/features during demo mode:

- generally: manually copy files + replace `modifyable: true` with `false`
- there is a `"settings":` block for all available inputs
- there is a `"variants":` block with overrides for "Fast" or "Standard" presets

To change defaults during demo:

- set `"defaultValue":` to the desired default value

Typical things to change for demo mode:

- "Safety Checker Strength" slider to `defaultValue: 0` and `modifyable: false`
- "Show Preview" checkbox to `defaultValue: false` and `modifyable: false`
- "Input Image" image picker to `modifyable: false`

## `_profile.json` — Demo Profile Descriptor

Each product mode's demo folder can contain a `_profile.json` file that configures the demo
mode identity for that product variant (trade show, essentials, etc.).

If `_profile.json` is missing, the app falls back to hardcoded defaults built into the
source code. Existing deployments without the file continue to work identically.

### Fields

| Field                      | Type           | Required | Description                                                                                                                                                                      |
| -------------------------- | -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaults.chatPreset`      | string         | yes      | Preset name to select for chat mode                                                                                                                                              |
| `defaults.chatModel`       | string         | yes      | Model ID to select for chat (e.g. GGUF path)                                                                                                                                     |
| `defaults.imageGenPreset`  | string         | no       | Preset name for image generation mode                                                                                                                                            |
| `defaults.imageEditPreset` | string         | no       | Preset name for image editing mode                                                                                                                                               |
| `inputImage`               | string \| null | no       | Filename of an image in this folder to preload for image editing. Electron reads the file and embeds it as a `data:image/*;base64,...` URI. Set to `null` or omit if not needed. |
| `samplePrompts`            | array          | no       | Sample prompts shown in the prompt area. Each entry has `title`, `description`, `prompt`, and `mode` (`chat`, `imageGen`, `imageEdit`, or `video`).                              |
| `enabledModes`             | array          | no       | Which modes are active: `["chat", "imageGen", "imageEdit", "video"]`. Tour steps and notification dots for disabled modes are hidden. Defaults to all four modes.                |
| `notificationDotButtons`   | array          | no       | Button IDs that show notification dots on first visit. Defaults to an empty array (falls back to hardcoded list).                                                                |

### Creating a new profile for a different product variant

1. Create the product mode's demo folder (e.g. `modes/essentials/demo/`)
2. Copy or create the preset JSON files you want available in that variant
3. Create a `_profile.json` with the fields above, referencing only the presets and
   modes that apply to your variant
4. If your variant uses an input image, place it in the same folder and reference it
   by filename in `inputImage`

Example for a chat-only "essentials" variant:

```json
{
  "defaults": {
    "chatPreset": "Basic",
    "chatModel": "unsloth/SmolLM2-1.7B-Instruct-GGUF/SmolLM2-1.7B-Instruct-Q5_K_S.gguf"
  },
  "inputImage": null,
  "samplePrompts": [
    {
      "title": "Chat Example",
      "description": "Ask anything:",
      "prompt": "What is machine learning?",
      "mode": "chat"
    }
  ],
  "enabledModes": ["chat"],
  "notificationDotButtons": [
    "mode-button-chat",
    "app-settings-button",
    "plus-icon"
  ]
}
```
