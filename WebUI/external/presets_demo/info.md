This folder contains the presets to be used during demo mode.
Demo mode can be activated by `isDemoModeEnabled: true` in `settings.json`.

The demo presets folder can be configured via `demoModePresetsDir` (defaults to `presets_demo`).

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
