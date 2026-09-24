# AI Playground

Electron + Vue.js desktop app for AI inference on Intel GPUs: an Electron main process
orchestrating a Vue renderer and several backend processes (llama.cpp, OpenVINO, ComfyUI,
Python model management).

## Language

**Channel manifest**:
The one typed table stating each IPC channel once — name, arguments, result, direction,
and envelope. Every side of the renderer↔main seam (handlers, preload bridge, renderer
`electronAPI` types) derives from it.
_Avoid_: IPC contract, channel registry, three-file rule (historical)
