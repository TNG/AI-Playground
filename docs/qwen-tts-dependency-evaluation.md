# Replacing `qwen-tts`: evaluation of vLLM-Omni

Evaluation of whether the `qwen-tts` PyPI package used by the `qwen3-tts` sidecar can be
replaced with [`vllm-omni`](https://github.com/vllm-project/vllm-omni), motivated by
`qwen-tts` being poorly maintained and dragging in dependencies with published advisories.

> TL;DR
>
> - **No, not today.** vLLM-Omni does support Qwen3-TTS and its API is a good fit, but it
>   runs on **vLLM, which has no Windows support at all** — and Windows + Intel XPU is our
>   primary shipping configuration. Intel XPU has no pre-built wheels even on Linux (Docker
>   or a oneAPI source build only) and needs torch 2.13, which we explicitly ceiling out.
> - **The advisories are mostly not `qwen-tts`'s model code — they're `gradio`.** 13 of the
>   18 advisories in the lock come from `pillow`, which is pulled in *only* by `gradio`,
>   which is pulled in *only* by `qwen-tts`, for a demo CLI we never run. Excluding `gradio`
>   removes 35 packages and 13 advisories, and is verified safe.
> - **The one genuine `qwen-tts` problem is its `transformers==4.57.3` hard pin** (2 high +
>   1 medium advisory, one of them reachable from our load path). That is *not* fixable by
>   unpinning: `qwen-tts` 0.1.1 does not run on transformers 5.x. Verified — see
>   [§5.1](#51-tested-unpin-transformers-fails).

---

## 1. What we run today

`qwen3-tts/` is a Flask sidecar (`web_api.py` → `tts_engine.py`) that loads Qwen3-TTS
through `qwen_tts.Qwen3TTSModel.from_pretrained()` and returns WAV bytes over loopback.
Two 12 Hz checkpoints are used, cached side by side so a mode switch never reloads:

| Mode | Model | Engine call |
|---|---|---|
| `custom_voice` | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | `generate_custom_voice()` |
| `voice_design` | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | `generate_voice_design()` |

Torch comes from a per-accelerator extra (`xpu` on Windows, `cuda` in NVIDIA product mode,
`cpu` elsewhere), and `list_devices.py` enumerates XPU/CUDA/CPU for the device selector.

## 2. Is `qwen-tts` actually badly maintained?

Yes, with one nuance: it is a research drop, not a maintained library.

- **6 releases, all inside a two-week window** (0.0.2 on 2026-01-22 → 0.1.1 on 2026-02-06),
  nothing since.
- **The PyPI project URLs are dead.** Both `Homepage` and `Repository` point at
  `github.com/Qwen/Qwen3-TTS`, which 404s. The real code lives at `QwenLM/Qwen3-TTS`
  (12.8k stars, 56 open issues, last push 2026-03-17), so there is no issue tracker
  reachable from the package a consumer installs.
- **It hard-pins `transformers==4.57.3` and `accelerate==1.12.0`** — equality pins on a
  fast-moving library, which is what makes the advisories below unfixable in place.
- **It depends on `gradio` unconditionally** for a demo CLI, and on `sox` (a wrapper around
  a SoX CLI binary we don't ship — importing the package prints `SoX could not be found!`).

## 3. What the advisories actually are

Audited every `name`/`version` pair in `qwen3-tts/uv.lock` (137 distinct packages) against
the GitHub Advisory Database. 18 matches, and they cluster sharply:

| Package | Locked | Advisories | Source of the dependency | Fixable by relocking? |
|---|---|---|---|---|
| `pillow` | 12.2.0 | **13** (10 high, 3 medium) | `gradio` → `qwen-tts` | Yes — `pillow` 12.3.0 exists and `gradio` allows `pillow<13.0` |
| `transformers` | 4.57.3 | **3** (2 high, 1 medium) | `qwen-tts` (`==4.57.3`) | **No** — the pin blocks it |
| `setuptools` | 81.0.0 | 1 (medium) | build-time | Yes — 83.0.0 |
| `torch` | 2.12.1 | 1 (low) | ours | No — we ceiling `torch<2.13` deliberately |

Two things follow:

**The `pillow` cluster is a stale-lock artifact, not a `qwen-tts` design flaw.** Nothing
constrains `pillow` below 12.3.0; the lock is simply older than the fix.

**The `transformers` cluster is the real issue, and one of the three is reachable from our
code path.** [CVE-2026-4372](https://github.com/advisories/GHSA-29pf-2h5f-8g72) (high,
fixed in 5.3.0): a malicious `config.json` sets `_attn_implementation_internal` to an
attacker-controlled Hub repo id, and `from_pretrained()` then downloads and executes code
from it — explicitly **bypassing `trust_remote_code`**. `tts_engine._load_model()` calls
`Qwen3TTSModel.from_pretrained(model_id, …)` with a model id that is overridable via
`QWEN3_TTS_MODEL`, so this is a live path, not a theoretical one. (The other two —
LightGlue loading and the `Trainer` class — are unreachable for us.)

## 4. Could vLLM-Omni replace it?

**Capability: yes.** vLLM-Omni has first-class Qwen3-TTS support covering all three task
types (CustomVoice, VoiceDesign, Base/voice-cloning) for the exact `Qwen3-TTS-12Hz-*`
checkpoints we use, and its OpenAI-compatible `POST /v1/audio/speech` takes `voice`,
`language`, `instructions`, `task_type` and streaming options — a superset of what
`/api/synthesize` exposes. It would also give us streaming audio and voice cloning, which
we don't have today.

**Platform: no.** Every blocker below is independent, and the first one alone is decisive.

1. **No Windows.** vLLM's supported platforms are CUDA/ROCm/XPU GPUs and x86/ARM/Apple/IBM Z
   CPUs — **all Linux** (the x86 CPU doc states `OS: Linux` outright). PyPI ships only
   `manylinux_2_28_{x86_64,aarch64}` wheels for `vllm` 0.26.0; native Windows support is
   still an open request upstream ([vllm#42877](https://github.com/vllm-project/vllm/issues/42877),
   and scoped to a *CUDA source build* at that). Our production build is
   `electron-builder --win --x64`. Adopting vLLM-Omni would remove TTS from the primary
   platform.
2. **No installable Intel XPU path.** vLLM's own XPU doc says "Currently, there are no
   pre-built XPU wheels" — you build from source with `VLLM_TARGET_DEVICE=xpu`, the Level
   Zero compute-runtime driver and `vllm-xpu-kernels`. vLLM-Omni's XPU page has empty
   wheel/source sections and says "vLLM-Omni currently recommends using the Docker image
   setup steps below" (an `intel/deep-learning-essentials` image that clones and compiles
   vLLM under oneAPI). We install backends on end-user machines with `uv sync` and
   `no-build = true`; a oneAPI source build is not something that fits behind an installer
   progress bar. XPU is also validated only on Arc B-Series, not the iGPUs we support.
3. **Direct version conflict.** vLLM's `requirements/xpu.txt` builds against torch 2.13 and
   `triton-xpu` 3.7.x. `qwen3-tts/pyproject.toml` carries `constraint-dependencies =
   ["torch<2.13"]` because "torch 2.13 breaks on Linux (driver issues)". These cannot both
   hold.
4. **No CPU story.** `vllm_omni/platforms/` has `cuda`, `rocm`, `xpu`, `npu`, `musa` — no
   `cpu` — and there is no CPU installation doc. CPU is our fallback whenever no accelerator
   is usable, and the default extra on Linux and macOS.
5. **Footprint and memory model are hostile to a co-resident app.** The `vllm` wheel alone is
   **304 MB** versus 113 KB for `qwen-tts`, on top of torch. Worse, vLLM pre-allocates KV
   cache to `gpu_memory_utilization`, **default 0.92**, documented as a per-instance limit
   that ignores other instances on the same GPU. AI Playground already shares one GPU
   between the LLM backend and ComfyUI. And because `vllm serve` hosts one model per
   process, keeping CustomVoice and VoiceDesign both resident (which the current two-slot
   cache does) would mean two servers, each grabbing its own pool.
6. **It is young and moves fast.** Development Status is `3 - Alpha`, releases track upstream
   vLLM minor-for-minor (0.11.0rc1 → 0.26.0 since Nov 2025), and its own docs recommend
   installing from source because it "is rapidly evolving". Swapping a stale dependency for
   one that re-bases every few weeks trades one maintenance problem for another.

Migration cost on our side would be moderate but not the issue: `spawnAPIProcess` would
launch `vllm serve` instead of `web_api.py`, and `synthesizeTextToSpeech` would post to
`/v1/audio/speech` — the `/api/config` speaker/language catalogue maps onto
`/v1/audio/voices`. The platform story is what rules it out.

## 5. Alternatives, and what we measured

### 5.1 Tested: unpin `transformers` (fails)

The attractive cheap fix is to override `qwen-tts`'s pin and move to transformers 5.x,
fixing all three advisories. It does not work. Against transformers 5.14.1, `qwen-tts`
0.1.1 fails progressively, and each fix reveals the next breakage:

| # | Failure | API change |
|---|---|---|
| 1 | `TypeError: check_model_inputs() missing 1 required positional argument` — at **import** | decorator factory → plain decorator |
| 2 | `AttributeError: 'Qwen3TTSTalkerConfig' object has no attribute 'pad_token_id'` | generation attrs removed from `PretrainedConfig` |
| 3 | `KeyError: 'default'` in `ROPE_INIT_FUNCTIONS` | RoPE init registry restructured |
| 4 | `create_causal_mask() got an unexpected keyword argument 'input_embeds'` | renamed to `inputs_embeds` |
| 5 | `create_causal_mask() got an unexpected keyword argument 'cache_position'` | replaced by `position_ids` |
| 6 | `RuntimeError: probability tensor contains either inf, nan or element < 0` | **numerical**, not an API error |

Failure 6 is the important one. After five mechanical shims the model loads and runs, then
produces NaN logits — a shim changed attention/mask semantics silently. Re-basing this code
onto transformers 5.x is not dependency hygiene, it is porting model internals (masking,
RoPE, cache) with no reference output to validate against beyond listening to the audio.

So the `transformers==4.57.3` pin is load-bearing. Fixing those three advisories requires
either vendoring and *properly* porting the modeling code — a fork we would then own, scoped
in [§5.4](#54-scoping-the-vendor-and-port-option) — or replacing the runner entirely.

Note this also rules out a tempting simpler idea: **`trust_remote_code` is not an option**
either. The `Qwen3-TTS-12Hz-*` repos ship no modeling `.py` and no `auto_map`, and upstream
`transformers` has no native `qwen3_tts` architecture (only `qwen3_omni_moe` and `mimi`), so
the model code has to come from a package.

### 5.2 Recommended now: drop the `gradio` subtree and relock

`gradio` is imported in exactly one file, `qwen_tts/cli/demo.py`, which nothing in our
sidecar touches — so it is pure install weight. Excluding it via a uv override (verified,
[§6](#6-reproducing-the-evidence)) drops **35 packages**: `gradio`, `gradio-client`,
`hf-gradio`, `safehttpx`, `pillow`, `fastapi`, `starlette`, `uvicorn`, `httpx`, `httpcore`,
`python-multipart`, `pydub`, `typer`, `rich`, `pandas` and friends — an entire second web
stack inside a sidecar that already runs Flask. That clears 13 of the 18 advisories, and a
plain relock clears `setuptools` too, leaving only the three `transformers` ones and the
deliberate `torch` ceiling.

```toml
# qwen3-tts/pyproject.toml, in [tool.uv]
# qwen-tts pulls gradio for its demo CLI (qwen_tts/cli/demo.py), which this sidecar never
# imports. A marker no `environments` entry can satisfy drops gradio and its 35-package
# subtree (pillow, fastapi, uvicorn, …) from the resolution. Without the `environments`
# restriction above, uv's universal resolver keeps gradio for a hypothetical platform.
override-dependencies = ["gradio; sys_platform == 'nonexistent'"]
```

`pyproject.toml` and `uv.lock` must change together — `checkBackend()` runs `uv sync
--check`, so a lock that lags the manifest makes the service report itself as not set up.
Regenerate with `uv lock --directory qwen3-tts` (and `--upgrade-package pillow
--upgrade-package setuptools`) on a machine that can reach `download.pytorch.org`; the
torch indexes are unreachable from the Cursor Cloud VM this evaluation ran in, which is why
this repo change is proposed rather than applied here.

Residual, worth knowing but not advisories: `sox` (1.4.1, a wrapper around a CLI binary we
don't ship), `onnxruntime`, `torchaudio` and `einops` are all imported at package-import time
via `core/tokenizer_25hz/vq/`, a path our 12 Hz models never execute — and by nothing else in
the wheel or in our sidecar. They can only be removed by vendoring ([§5.4](#54-scoping-the-vendor-and-port-option)).

### 5.3 If the `transformers` pin must go

In rough order of cost:

1. **Ask upstream.** A `transformers` 5.x compatible `qwen-tts` release, or at least a range
   instead of `==`, fixes this for everyone. `QwenLM/Qwen3-TTS` is stale but not archived.
2. **Vendor the 12 Hz subset and port it** — scoped in [§5.4](#54-scoping-the-vendor-and-port-option).
   The vendoring and the porting are separable, and only the second half is expensive.
3. **Revisit vLLM-Omni** once vLLM ships Windows and pre-built XPU wheels. Worth re-checking
   periodically, since the capability fit is genuinely good.

Note that even option 3 does not remove `transformers` risk: `vllm-omni` requires
`transformers>=5.5.3`, which is *newer* than the fixed versions here — so simply being able
to track a current `transformers` is most of the benefit, and options 1 and 2 get it without
changing platforms.

### 5.4 Scoping the vendor-and-port option

The important structural point: **vendoring and porting are two separable changes**, and they
have very different risk profiles.

**Step A — vendor at `transformers` 4.57.3.** Pure deletion, no behavior change. Keep the
12 Hz path, drop the 25 Hz tokenizer and the demo CLI:

| | Files | Lines | |
|---|---|---|---|
| `core/models/` | 4 | 2924 | keep (`modeling_qwen3_tts.py` alone is 2299) |
| `core/tokenizer_12hz/` | 2 | 1199 | keep |
| `inference/` | 2 | 1287 | keep |
| `core/tokenizer_25hz/` | 5 | 3145 | **drop** |
| `cli/demo.py` | 1 | 634 | **drop** |

So ~5.4k lines kept of 9.3k, spanning ~51 classes (26 plain `nn.Module`, 4 `PreTrainedModel`,
6 config classes, 4 `ModelOutput`, 1 subclass of transformers' `MimiModel`).

Dependency effect, measured in one harness (`uv lock`, same `environments`, torch from PyPI so
the three are comparable):

| Dependency set | Packages |
|---|---|
| current, `qwen-tts` as-is | 114 |
| `gradio` excluded via override ([§5.2](#52-recommended-now-drop-the-gradio-subtree-and-relock)) | 79 |
| 12 Hz vendored, no `qwen-tts` dependency | 72 |

The extra 7 are `qwen-tts`, `sox`, `onnxruntime`, `protobuf`, `flatbuffers`, `torchaudio` and
`einops` — chunkier than the count suggests, since `onnxruntime` and `torchaudio` are native
wheels, and `torchaudio` is currently installed per-accelerator from the PyTorch index for
nothing. What remains is `torch`, `transformers`, `accelerate` (for `device_map`), `numpy`,
`librosa`, `soundfile`, `huggingface_hub`, plus our Flask.

Step A is cheap and verifiable, but note it **does not fix the three `transformers`
advisories** — it only buys the freedom to change the pin ourselves, plus a smaller install.

**Step B — port to `transformers` 5.x.** This is the real cost. Of the 35 transformers symbols
the kept files import, 18 are unchanged between 4.57.3 and 5.14.1 and 17 differ — but ~9 of
those are cosmetic (`Optional[X]` → `X | None`, `PretrainedConfig` → `PreTrainedConfig` in
annotations). The behavioral ones:

| Change | Sites |
|---|---|
| `check_model_inputs` decorator factory → plain decorator | 1 |
| `ROPE_INIT_FUNCTIONS` lost `"default"` (gained `"proportional"`) | 3 |
| `rope_config_validation` now takes `RotaryEmbeddingConfigMixin`, not a config | config classes must adopt the mixin |
| `create_causal_mask` / `create_sliding_window_causal_mask`: `input_embeds` → `inputs_embeds`, `cache_position` dropped, `block_sequence_ids`/`layer_idx` added | 3 |
| generation attrs (`pad_token_id`, …) removed from `PretrainedConfig` | 2 |
| `MimiConfig` is keyword-only and replaced `rope_theta` with `rope_parameters` | see below |

Two things make this more than a mechanical sweep:

- **The NaN failure is not on that list.** Shimming the five loud breakages took ~5 edits and
  got the model loading and generating, and then the logits were NaN
  ([§5.1](#51-tested-unpin-transformers-fails)). Diagnosing that means bisecting mask and
  position semantics against a reference implementation, and it is the part that cannot be
  estimated from an API diff.
- **We inherit an upstream model, and config translation is silent.**
  `Qwen3TTSTokenizerV2Model.__init__` unconditionally builds `Qwen3TTSTokenizerV2Encoder`,
  which **subclasses transformers' `MimiModel`** — so even CustomVoice/VoiceDesign, which
  never encode reference audio, drag in Mimi's internals. The checkpoints ship a
  `speech_tokenizer/config.json` written for 4.x (`rope_theta`, `_frame_rate`). Feeding it to
  5.14.1's `MimiConfig` does **not** raise: `rope_theta` is silently dropped and re-derived
  from the new `rope_parameters` default. Here that default happens to be the same 10000.0, so
  it works *by luck*; a checkpoint with a non-default theta would be silently mis-modelled.
  A vendored port therefore needs an explicit config-translation shim, and owes upstream Mimi
  a re-check on every `transformers` bump.

**A/B can be numeric, not by ear.** Better than feared: generation is bit-reproducible on a
fixed stack. Same seed, two runs, sampled *and* greedy — `max_abs_diff = 0.000e+00` for both
(§6). So the harness is a frozen corpus (texts × the 9 speakers × languages × both modes)
generated once on the pinned 4.57.3 stack, storing **talker codec token sequences** plus
waveform hashes, and the port must reproduce them. Compare token sequences under greedy
decoding as the primary assertion — they are immune to RNG and pin down the model math; the
waveform comparison then covers the decoder stage. Budget ~30–45 s per case on 4 CPU cores at
fp32, so a 12–24 case corpus is 10–20 minutes per stack: a manual or nightly gate, not a
per-commit check. One caveat: bit-equality *across* transformers versions is stricter than
correctness — a single differing logit from kernel dispatch or mask dtype will diverge a
sampled sequence completely, so the harness needs to report the first point of divergence
rather than just pass/fail.

**What we own afterwards:** ~5.4k lines of model code including a subclass of an upstream
transformers model, a config-translation shim, and the A/B corpus — re-validated on every
`transformers` bump. That is why the sequencing matters: [§5.2](#52-recommended-now-drop-the-gradio-subtree-and-relock)
clears 14 of 18 advisories for two lines, so vendoring is only worth starting if the three
`transformers` advisories become a hard gate, and even then Step A should land and be verified
on its own before Step B is attempted.

## 6. Reproducing the evidence

All of the following was run on Ubuntu with `uv` 0.12.1, CPython 3.12.13, torch 2.12.1
and CPU inference.

**Advisory audit** — every `name`/`version` in the lock, queried against the GitHub
Advisory Database (`gh api /advisories?ecosystem=pip&affects=<pkg>`) and matched with
`packaging.specifiers`; 18 hits as tabulated in §3.

**Baseline synthesis works, without `gradio`.** A script mirroring
`tts_engine.synthesize_wav()` ran in a venv with `torch` 2.12.1, `transformers` 4.57.3,
`accelerate` 1.12.0, `librosa`, `soundfile`, `sox`, `onnxruntime`, `einops` and `qwen-tts`
0.1.1 installed **`--no-deps`** — i.e. no `gradio`, `pillow`, `fastapi`, `uvicorn`,
`starlette`, `pydub` or `python-multipart` anywhere. It loaded
`Qwen3-TTS-12Hz-0.6B-CustomVoice` in 3.1 s and produced 4.96 s of valid 24 kHz WAV in
10.5 s (`custom_voice` only; the 1.7B `voice_design` path was not run):

```
transformers=4.57.3 torch=2.12.1+cu130
LOADED in 3.1s
GENERATED in 10.5s
OK sr=24000 samples=119040 duration=4.96s wav_bytes=238124 peak=0.438
```

**transformers 5.x fails.** The same script against `transformers` 5.14.1, patching each
failure in an out-of-tree copy on `PYTHONPATH`, produced the six failures in §5.1.

> One methodology note, since it would otherwise be easy to repeat: do **not** patch
> `site-packages` in place to test this. `uv` hardlinks from its global cache, so editing an
> installed file mutates the cache and silently corrupts every other venv that installs the
> same wheel. A first control run was invalidated exactly that way. Patch a copy and inject
> it with `PYTHONPATH`.

**`gradio` exclusion works.** Two manifests differing only by the override line, both
carrying the `environments` list this project already declares (`win32`/`darwin`/`linux`):

```
$ uv lock            # without the override
Resolved 114 packages
$ uv lock            # with override-dependencies = ["gradio; sys_platform == 'nonexistent'"]
Resolved 79 packages

gradio 0  gradio-client 0  pillow 0  fastapi 0  uvicorn 0  starlette 0
pydub 0   python-multipart 0  safehttpx 0  hf-gradio 0  typer 0  rich 0  pandas 0
transformers 4.57.3  accelerate 1.12.0  librosa 0.11.0  sox 1.4.1  onnxruntime 1.28.0
```

The `environments` restriction is what makes this work: without it, uv's universal resolver
treats `sys_platform == 'nonexistent'` as potentially satisfiable by some hypothetical
platform and keeps `gradio` in the lock anyway.

**Generation is bit-reproducible**, which is what makes a numeric A/B possible. Same seed,
two runs each, on the pinned stack:

```
transformers=4.57.3 torch=2.12.1+cu130
sampled (do_sample=True, seed=1234): len=84480/84480   identical=True max_abs_diff=0.000e+00
greedy  (do_sample=False):           len=145920/145920 identical=True max_abs_diff=0.000e+00
```

**The transformers API surface was diffed symbol by symbol.** All 35 symbols the 12 Hz subset
imports from `transformers` were probed under both versions for existence and signature
(`inspect.signature`, plus dict contents for `ACT2FN` and `ROPE_INIT_FUNCTIONS`): 18 unchanged,
17 changed, of which ~9 are typing-only. `ACT2FN` still has `silu` and `gelu`, the only entries
this code selects.
