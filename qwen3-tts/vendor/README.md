# Vendored `qwen_tts`

The Qwen3-TTS modelling code, vendored from the `qwen-tts` PyPI package instead of installed
as a dependency. Nothing in here is our code — treat it as a third-party tree (it is excluded
from Ruff in `ruff.toml`) and keep local edits to the minimum listed below so it stays
diffable against upstream.

## Provenance

| | |
|---|---|
| Package | `qwen-tts` 0.1.1 (PyPI) |
| Wheel | `qwen_tts-0.1.1-py3-none-any.whl` |
| Wheel SHA-256 | `11a290d8dabc7ef91a90c54478c8ab19b3edb1d85c0882313721892bdc4af15d` |
| Upstream source | <https://github.com/QwenLM/Qwen3-TTS> |
| License | Apache-2.0 (per-file headers retained) |

## Why vendored

The package declared `transformers==4.57.3`, `accelerate==1.12.0` and — for a Gradio demo CLI
this sidecar never imports — `gradio`, which transitively pulled `pillow`, `fastapi`,
`uvicorn`, `starlette`, `python-multipart` and ~30 more packages into an install that already
runs Flask. Vendoring drops that subtree, drops `sox` / `onnxruntime` / `torchaudio` / `einops`
(imported only by the 25 Hz tokenizer we don't use), and lets us set the `transformers`
constraint ourselves rather than inheriting an equality pin.

Full analysis and measurements: [`docs/qwen-tts-dependency-evaluation.md`](../../docs/qwen-tts-dependency-evaluation.md).

## Local modifications

Deletions — the 25 Hz tokenizer and the demo CLI. AI Playground only loads the 12 Hz
checkpoints (`Qwen3-TTS-12Hz-*`), and the 25 Hz path is the only importer of `sox`,
`onnxruntime`, `torchaudio` and `einops`:

- removed `qwen_tts/core/tokenizer_25hz/` (5 files)
- removed `qwen_tts/cli/` and `qwen_tts/__main__.py` (the `gradio` importers)

Edits, all mechanical consequences of those deletions:

- `qwen_tts/core/__init__.py` — dropped the `Qwen3TTSTokenizerV1{Config,Model}` re-exports.
- `qwen_tts/inference/qwen3_tts_tokenizer.py` — dropped the V1 imports and their
  `AutoConfig`/`AutoModel` registrations, and the 25 Hz branch of `decode()` (an unsupported
  tokenizer type now raises). Docstrings referring to the 25 Hz variant trimmed.

Everything else is byte-identical to the wheel. To verify:

```bash
pip download --no-deps qwen-tts==0.1.1 -d /tmp/qtts && unzip -q /tmp/qtts/*.whl -d /tmp/qtts/src
diff -r /tmp/qtts/src/qwen_tts qwen3-tts/vendor/qwen_tts
```

## Updating

Re-copy from the new wheel, re-apply the deletions and edits above, then re-run the parity
check in `qwen3-tts/tests/test_vendor_parity.py`, which asserts that generation is bit-exact
against a stored reference. A `transformers` bump needs the same check — the modelling code
uses internal APIs (`masking_utils`, `cache_utils`, `modeling_rope_utils`) and is known not to
work on `transformers` 5.x.
