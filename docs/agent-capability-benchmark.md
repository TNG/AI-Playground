# Agent harness benchmarks

Two questions about the agent harness that are cheap to argue about and expensive to guess
wrong. Both are answered by measurement, and this file is where the method and the verdicts
live.

1. [Capability activation](#1-capability-activation-eager-vs-dormant) — should a capability's
   tools be exposed from the first request, or kept dormant until the model asks for them?
   Answered; a script reproduces the numbers.
2. [Does the harness help or hurt?](#2-does-the-harness-help-or-hurt-on-a-small-model) — on a
   small local model, does Game Maker beat a plain chat at the same task? Measured once
   (2026-08-14): the harness costs time and never fails to produce a file, but it spends its
   turns re-checking rather than building, and the 35B crashed the GPU every time. The changes
   that came out of that are pending a re-run.

## 1. Capability activation: eager vs dormant

`WebUI/scripts/bench/toolActivation.mts` builds a real Pi `AgentSession` the way
`piAgentManager.createSession` does, reads its system prompt and tool schemas, and replays a
fixed two-step transcript (write a haiku, then illustrate it) against a llama.cpp server. The
transcript is canned, so every arm sees identical token counts and differs only in when the
tools arrive:

- **A — eager:** every capability tool active from the first request.
- **B — lazy:** dormant one-line summaries, the model spends a turn calling `capabilities`
  to activate `media`.
- **C — lazy, host-activated:** the same prompt swap as B, without the extra turn.

```bash
# from WebUI/, with a llama.cpp server already up
node --experimental-strip-types scripts/bench/toolActivation.mts \
  --base-url http://127.0.0.1:39100 --repeat 3 \
  --out ../docs/agent-activation-report.md
```

Each run stamps a unique first line into the system prompt, so no run inherits another's
prompt cache and every arm pays an honest cold prefill.

**Verdict: eager wins on a local model, so tools are active by default.** Activation changes
the system prompt, llama.cpp caches on the prompt *prefix*, and a changed prefix invalidates
the whole cached conversation — the model then re-processes everything said so far. That
re-prefill costs more than carrying the schemas from the start, and B pays for a wasted turn
on top. The only reason left to defer is running out of context, which is exactly the rule the
code implements: capabilities go dormant when their schemas would take more than
`DORMANT_TOOL_BUDGET_SHARE` of the window (`capabilities/types.ts`), and the `capabilities`
meta-tool exists only for that case (`capabilities/core.ts`).

## 2. Does the harness help or hurt on a small model?

The report from testing: the same prompt and model that produce working code in Basic Chat
produce a worse game in Game Maker, and the run sometimes fails outright. Two causes are known
and fixed or bounded, and the rest is what this comparison is for.

**What is already understood:**

- The failures to *finish* were the completion cap. A whole `index.html` in one `write` hit the
  4096-token reply limit and the call was rejected, losing the attempt. The budget is now
  32768 locally / 16384 for cloud, bounded by half the context window (`outputTokenBudget` in
  `piAgentManager.ts`), and the folder now starts from a scaffold the model extends with `edit`
  calls instead of writing a game from nothing.
- The weaker *design* has an obvious suspect: the harness spends a large slice of the context
  before the task begins — Pi's own system prompt, seven file/shell tool schemas, the media,
  browser and game tools, skill announcements and workspace instructions. A 4B–9B model has
  that much less attention for the game itself. Basic Chat spends none of it.

That suspicion is not a measurement, and the fix (fewer capabilities) is not free — dropping
`web-debug` also drops the play-test loop that catches a blank page. So compare three arms
rather than two.

### The three arms

Same model, same prompt, same machine, cold app start for each arm.

| Arm | Setup |
| --- | --- |
| **Chat** | Basic Chat / Assistant preset, one shot, no tools. The reply's code is saved by hand into an `index.html`. |
| **Full** | Game Maker as shipped: `media`, `web-debug`, `game-studio`. |
| **Trimmed** | Game Maker with `media`, `web-debug` and `game-studio` unchecked in Agent Settings, leaving the file tools. Needs no code change. |

Prompt, held constant (deliberately the kind of thing a tester asks for):

> Make a small browser game where the player dodges falling rocks with the arrow keys, with a
> score and a game-over screen.

Run each arm three times — a single run of a small model says very little — and note the model
and quantization with the results.

### Scoring

Per run:

| Measure | How it is taken |
| --- | --- |
| Playable | Open `index.html`: does it start, accept input and reach a game-over? Yes / no. |
| Console clean | Browser console after one minute of play: count of errors and warnings. |
| Prompt adherence | Of the four asked-for elements (falling rocks, arrow keys, score, game-over), how many are present? 0–4. |
| Turns | Assistant turns until the agent reports it is done (Chat: 1 by construction). |
| Tokens | Total prompt + completion tokens for the attempt. |
| Wall time | First send to final reply. |
| Failed | Attempt ended without a runnable file, and why (output cap, context exhausted, tool loop, gave up). |

"Playable" is the only measure that decides anything on its own; the rest explain the result.
Report medians of the three runs, plus every failure.

### What each outcome means

- **Trimmed beats Full on small models:** add a "Lite" variant to the Game Maker preset rather
  than changing the default — `variants[].overrides` can carry `agentCapabilities`, so the
  variant radio becomes the choice between "with art and play-testing" and "just build it".
  Keep the full set as the default for larger and cloud models.
- **Chat beats both, but only on adherence:** the harness prompt is competing with the task.
  Shorten the preset system prompt and move the detail into the skill body, which is only read
  when the model asks for it.
- **Chat beats both outright, including playability:** that is a finding worth acting on — a
  small model should not be offered Game Maker at all, and the preset's model filter should
  have a floor rather than merely requiring `supportsCoding`.
- **Full wins:** the reported degradation was the output cap, now fixed, and nothing further is
  needed beyond re-testing with a larger model
  (`unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-UD-Q4_K_XL.gguf` fits a 32 GB machine and is in
  `models.json`).

The 2026-08-14 run scored none of these branches: it deliberately made no quality judgement, and
what it found instead — where the agent's turns go, and that the 35B crashes the GPU in the agent
loop — was decisive enough without one. The preset prose was shortened and the detail moved into
the skill anyway, on the second bullet's reasoning.

### Results, 2026-08-14

Twelve runs on the Windows dev machine (`intel-ptl`, Arc B390, 47.4 GB shared GPU memory,
llama.cpp Vulkan, dev build), driven through the app's own stores so every run took the product
path. Two models — `Qwen3.5-9B-Q4_K_M` and `Qwen3.6-35B-A3B-UD-Q3_K_XL` — three runs each in
Assistant and in Game Maker, 128k context throughout, Assistant's output cap raised to 8192 to
match the agent's per-call budget. The prompt was a tester's, not the one above:

> Generate a vector game of asteroids in a single html file, make it colorful with modern effects
> like particles, etc

Only the **Chat** and **Full** arms were run; **Trimmed** was skipped once the result made the
capability count look like the wrong variable. Full data, artifacts and the GPU trace live
outside the repo in `~/aipg-bench/asteroids-2026-08-14/`.

| | Chat, 9B | Game Maker, 9B | Chat, 35B | Game Maker, 35B |
| --- | --- | --- | --- | --- |
| Wall time (median) | 4m38s | 7m52s | 4m14s | 7m41s |
| Spread | 4m06-4m44s | 5m51-14m51s | 4m08-4m54s | 4m53-21m23s |
| Output tokens (median) | 4956 | 6430 | 7394 | 10591 |
| File size | 17.1-19.0 KB | 15.0-19.7 KB | 17.7-21.7 KB | 13.9-17.7 KB |
| Runs that produced a complete file | 3/3 | 3/3 | 2/3 | 3/3 |
| Peak shared GPU memory | 11.6 GB | 11.6-11.8 GB | 20.7 GB | 20.6 GB |

**Nobody failed to produce a game, and the harness was not the cheaper way to get one.** Game
Maker took roughly twice as long for a file no larger, and its time was wildly unpredictable
where the chat arm was tightly grouped — the spread tracks how many play-test cycles the model
chose to run, not the difficulty of the game.

Four findings drove the changes that followed:

- **The turns went into looking, not building.** Per run: 1-3 `write`, 0-5 `edit`, 3-10
  `browser`. The agent re-opened and squinted at its page far more often than it changed it,
  because a screenshot is a weak answer to "is this working?".
- **Every 35B agent run died** with `decode() failed: vk::Device::getFenceStatus:
  ErrorDeviceLost`, after browser screenshots, at 8, 5 and 21 minutes. The same model in plain
  chat never crashed and the 9B agent runs never crashed, so vision decode inside the agent loop
  is the suspect. Each crash landed *after* the game was written, so all three still left a
  playable file.
- **All three 35B runs made zero `game` tool calls**, leaving the library card showing the
  provisional prompt as the title. Naming was last on the list and the runs ended first.
- **Memory is a property of the model, not the mode**: 11.6-11.8 GB for the 9B and 20.6-20.7 GB
  for the 35B at 128k in either mode, of which llama-server holds essentially all. Screenshots,
  vision decode and image generation never moved the peak. Assistant mode's 35B run 1 stopped
  dead at the 8192-token cap mid-file, which is why the local budget is now 32768.

### Next: shipped Game Maker vs scaffold + probe

The arms that matter now are not capability counts. Game Maker was changed in response to the
above — a new game folder is scaffolded with a running `index.html` + `game.js` split by section
markers, and play-testing is a text probe injected by the preview server
(`browser {"action":"probe"}`) instead of a screenshot the model looks at. So:

| Arm | Setup |
| --- | --- |
| **Shipped** | Game Maker as it was on 2026-08-14 (empty folder, screenshot play-testing). |
| **Scaffold + probe** | Game Maker as it is now. |

Same prompt, same two models, same machine, three runs each, and the measures above plus three
that target the change directly:

| Measure | Why |
| --- | --- |
| `browser` calls per `edit` | The point of the probe is to spend fewer turns asking and more changing. |
| Runs that call `game set_metadata` | The skill now asks for it first; the 35B never reached it. |
| `ErrorDeviceLost` recurrences | The cheap test of the vision hypothesis. If it survives the removal of screenshots from the loop, it is a driver problem and becomes its own investigation. |

A scaffold every game starts from also risks sameness, so the re-run should note whether the
three games in an arm are recognizably different from each other.
