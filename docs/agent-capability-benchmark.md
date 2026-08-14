# Agent harness benchmarks

Two questions about the agent harness that are cheap to argue about and expensive to guess
wrong. Both are answered by measurement, and this file is where the method and the verdicts
live.

1. [Capability activation](#1-capability-activation-eager-vs-dormant) — should a capability's
   tools be exposed from the first request, or kept dormant until the model asks for them?
   Answered; a script reproduces the numbers.
2. [Does the harness help or hurt?](#2-does-the-harness-help-or-hurt-on-a-small-model) — on a
   small local model, does Game Maker beat a plain chat at the same task? Open; the protocol
   below is what settles it.

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
  8192 locally / 16384 for cloud (`outputTokenBudget` in `piAgentManager.ts`), and both the
  preset prompt and the `html-game-studio` skill tell the model to write a running skeleton
  first and grow it with `edit` calls.
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

### Results

_Not run yet._ Fill in below with model, quantization, machine, and the medians above.
