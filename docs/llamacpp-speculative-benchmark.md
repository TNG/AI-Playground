# Speculative decoding for Qwen3.8-27B

llama.cpp offers several speculative decoders and they can be stacked. The
[upstream doc](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md)
recommends n-gram drafting for "rewriting source code", which is most of what Game Maker does,
so the obvious idea was to run n-grams on top of the MTP heads Qwen3.8 already ships. This file
records what that actually measured on our hardware.

**Verdict: use `--spec-type draft-mtp` alone. Drop `--spec-default`.** MTP roughly doubles
decode speed. Every n-gram variant either does nothing, costs speed, or changes the model's
output. `--spec-default` is what turns the n-gram layer on, so it is the flag to remove.

## What was measured

`WebUI/scripts/bench/speculative.mts` starts one llama-server per arm over SSH on the Windows
test machine, waits for it through a port-forward, replays fixed requests at `temperature 0`,
and kills it before the next arm so each one owns the GPU. Requests are byte-identical across
arms, so the only variable is how the server drafts.

Three workloads, all replayed from recorded sessions rather than invented:

- **plan** — the first turn of a Game Maker Quick run: a brief in, a plan out.
- **build** — the second turn: write the whole game as one `write` call. New code, so nothing
  in the prompt to copy from.
- **edit** — five consecutive turns of a regular Game Agent run, each replacing one
  `// === section ===` block of `game.js` (`config`, `state`, `input`, `update`, `draw`). Every
  `edit` call quotes the existing section verbatim before rewriting it, so this is the workload
  n-grams are supposed to win.

The edit turns are _replayed_, not free-run: each step sends a recorded prefix and asks only for
the next assistant turn. A free-running loop would let a faster arm wander into different work
and make the arms incomparable — and two arms turned out to produce different output from the
same prompt, so that was not a theoretical concern.

Machine: `intel-ptl`, Arc B390, `Qwen3.8-27B-UD-Q4_K_XL.gguf`, 32k context, fully offloaded
(`--gpu-layers 999`), with the app closed so nothing else holds VRAM.

## Results

Decode speed in tokens per second, median of each arm's requests. The edit column is the
median of three passes; plan and build are single passes.

| arm                                             | plan | build   | edit | build vs none | edit vs none | drafted | accepted |
| ----------------------------------------------- | ---- | ------- | ---- | ------------- | ------------ | ------- | -------- |
| `none`                                          | 5.7  | 5.6     | 5.6  | —             | —            | 0       | —        |
| `draft-mtp`                                     | 10.7 | 11.5    | 10.2 | 2.03×         | 1.83×        | 14017   | 86.3%    |
| `ngram-mod` (`--spec-default`)                  | 5.8  | 5.6     | —    | 0.99×         | —            | 320     | 4.1%     |
| `draft-mtp,ngram-mod`                           | 10.3 | 10.1    | 9.0  | 1.79×         | 1.62×        | 15793   | 75.9%    |
| `draft-mtp,ngram-simple`                        | 3.9  | stalled | —    | —             | —            | 0       | —        |
| `draft-mtp,ngram-map-k4v`                       | 4.3  | 7.9     | —    | 1.39×         | —            | 15663   | 30.8%    |
| shipped: `--spec-default --spec-type draft-mtp` | 11.0 | 10.7    | —    | 1.90×         | —            | 4488    | 80.8%    |

## Timings are noisy; draft counters are not

Repeating the edit workload exposed how little a single timing is worth here. The same arm
replaying the same bytes produced 8.2 to 11.9 tok/s on one turn, and one section ranged from
6.7 to 11.1 tok/s across passes — a 66% spread with nothing changed.

The draft counters, by contrast, reproduce exactly. Every MTP turn drafted and accepted an
identical number of tokens in both repeats (252/336, 548/618, 309/366, 824/945, 890/984), which
is what determinism at `temperature 0` should give.

So this file compares configurations by **draft economics** — how many speculative tokens were
computed and how many survived, for a fixed output — and treats speed differences under about
20% as noise. That is also the better measure: it counts the work done per token instead of how
loaded the GPU happened to be.

Per-pass totals for the five edit turns, which are what the recommendation rests on:

| arm                   | output tokens | drafted | accepted | acceptance |
| --------------------- | ------------- | ------- | -------- | ---------- |
| `draft-mtp`           | 3904          | 3249    | 2823     | 86.9%      |
| `draft-mtp,ngram-mod` | 3854          | 3754    | 2796     | 74.5%      |

## What the numbers say

**MTP is the whole win.** It roughly doubles decode on new code and gives 1.8× on edits, at
85–87% draft acceptance on both. Nothing else came close.

**Stacking n-grams on MTP adds drafts, not tokens.** Over one pass of the edit workload
`ngram-mod` drafted 505 more tokens than MTP alone (3754 vs 3249) and got 27 _fewer_ accepted
(2796 vs 2823). Acceptance falls from 86.9% to 74.5% while the accepted count stays flat, and
rejected drafts are compute spent for nothing. The expectation that edits would favour n-grams
was reasonable — an `edit` call really does quote its context verbatim — but it assumes MTP is
weak on those spans, and at ~87% acceptance there is almost no headroom left to find.

**The n-gram pool also costs determinism.** MTP's counters were identical across repeats;
`ngram-mod`'s were not (376 then 449 drafts on one turn, 1176 then 1146 on another), and its
output drifted slightly from MTP's on one section. The pool carries state between requests, so
a turn's drafting depends on what ran before it.

**`ngram-mod` alone is inert here.** It drafted 320 tokens across two long turns and had 4.1%
of them accepted, landing within noise of no speculation at all.

**The experimental drafters change the output.** At `temperature 0` every well-behaved arm
produced exactly 951 tokens for the plan turn. `ngram-simple` produced 2048 (hitting the cap)
and `ngram-map-k4v` produced 1707. Verified speculative decoding should be token-identical to
the baseline whatever the drafter, so these two are not merely slow — they change results.
`ngram-map-k4v` also drafted 15663 tokens at 30.8% acceptance, which is what its 4.3 tok/s plan
turn is made of, and `ngram-simple` stalled outright on the build turn.

**A long draft budget does not fit.** `--spec-draft-n-max 64`, the doc's suggestion for
rewriting source code, aborts at load next to a fully offloaded 27B:
`failed to fit params to free device memory: n_gpu_layers already set by user to 999, abort`.
Those two arms only run at 16. Worse, llama.cpp does not exit after printing this — the process
stays up holding its allocation, which is why the harness now tails the log during the health
wait and fails the arm on it.

**`--spec-default` is exactly the n-gram layer.** The shipped arm and the explicit
`draft-mtp,ngram-mod` arm drafted identically — 3627 of 4488 accepted, to the token — which is
what determinism at `temperature 0` should give two spellings of one config.

**Speculation only speeds up half a turn.** The first edit turn spent 47.5s of its 110s on
prefill. Decode gains do not touch that, so wall-clock improvement on a short turn with a cold
prompt is much smaller than the tok/s ratio suggests.

## Caveats

One machine, one model, one quantisation. The edit workload is five turns of a single recorded
session, repeated three times; plan and build were measured once each, so their speeds carry
the same ±30% noise and only the ~2× MTP effect is safely outside it. Nothing here is evidence
about the Qwen3.5/3.6 entries in `models.json`, which are different models with their own
`--spec-draft-n-max` tuning.

## Reproducing

```bash
# from WebUI/, with the AI Playground app closed so the bench owns the GPU
npm run bench:speculative -- --repeat 1 --skip-full --build-tokens 4096 \
  --out ~/aipg-bench/speculative

# the edit workload needs a recorded Game Agent session to replay
npm run bench:speculative -- --arms none,mtp,mtp-ngram-mod --only-edit --repeat 2 \
  --edit-session ~/Library/Application\ Support/ai-playground/pi/sessions/<session>.jsonl \
  --out ~/aipg-bench/speculative-edit

# re-render the tables from results already on disk, folding several passes together
npm run bench:speculative -- --report-only --out ~/aipg-bench/speculative \
  --merge ~/aipg-bench/speculative-edit
```

Useful flags: `--arms` to pick arms, `--only-full` for the end-to-end game run, `--only-edit`
for just the edit turns, `--stall-seconds` for the dead-stream watchdog, `--dry-run` to inspect
the fixtures without touching the GPU.
