# Compute resource metrics

How AI Playground samples GPU and host memory, how those numbers land on Laminar
traces, and how they are shown in the UI.

## Why one sampler

Token speeds already come from the inference server (`timings` on llama.cpp, wall
clock elsewhere). They say how fast a call was, not what the machine was doing:
vRAM filled, GPU busy, host RAM stolen by an iGPU. Those are hardware facts, so
they are collected once in the Electron main process and fanned out to two
consumers:

1. **Traces** — peak/last values on the LLM span (`aipg.gpu.*` / `aipg.host.*`)
   and filterable metadata on the run root (`gpuUtilPeak`, `gpuMemPeakMib`,
   `hostMemPeakMib`), so a slow Game Agent turn can be correlated with a vRAM
   spike or a GPU that never left idle.
2. **UI** — live chip on the prompt status bar, and per-turn peaks on the chat
   message footer, both gated by Chat Settings → Metrics (the same toggle as
   tokens/s).

A probe failure never fails a turn. Missing `nvidia-smi` / `xpu-smi` yields a
host-RAM-only snapshot.

## Sources

| Vendor / OS | Probe | Notes |
| --- | --- | --- |
| Host (all) | `os.totalmem` / `os.freemem` | Always present. On Intel iGPU, "vRAM" is stolen from this pool. |
| NVIDIA | `nvidia-smi --query-gpu=… --format=csv,noheader,nounits` | Same binary already used for discovery. Instant. |
| Intel, Windows | bundled `xpu-smi.exe` (`dump -d -1 -m 0,1,2,5,18 -n 1`) | GPU util, power, freq, memory used. Names + total size from `discovery --dump 1,2,16`. |
| Intel, Linux | `xpu-smi` on `PATH` if the user installed XPU Manager | Not bundled today (Linux discovery still uses `lspci`). Without it, GPU rows are empty. |

NPU has no util/memory probe here. Cloud turns still record **host** RAM but
omit GPU attributes — the serving GPU is not this machine.

Metric IDs for `xpu-smi dump` (Intel XPU Manager CLI): `0` GPU Utilization (%),
`1` GPU Power (W), `2` GPU Frequency (MHz), `5` GPU Memory Utilization (%),
`18` GPU Memory Used (MiB).

## Sampling

`electron/computeMetrics.ts` polls every 2s after the window is created, skips
overlapping ticks (a 1s Intel dump must not pile up), and keeps ~120 samples
(~4 min). The renderer gets each snapshot over `computeMetricsUpdate`.

Pick the GPU to report: name-match against the selected device (`deviceName` on
the trace context), else the card with the highest memory used.

## Follow-ups worth doing, not in this slice

- Bundle `xpu-smi` for Linux the way Windows already does, or a sysfs/`xe`
  fallback for freq + drm client memory when XPU Manager is absent.
- Long-lived `xpu-smi dump` (no `-n 1`) to avoid the 1s dump interval.
- Backend-owned numbers: llama.cpp `/slots` KV bytes, ComfyUI's own VRAM
  estimate — complementary to board-level SMI, not a replacement.
- Per-process GPU memory (needs `cap_perfmon` / admin on Intel) to split LLM vs
  ComfyUI on the same card.
