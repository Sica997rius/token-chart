# token-chart
A side panel for Claude Code that shows how many tokens you use, split by model, next to your usage limits and the session cost, and learns how much each model weighs on **your** 5-hour limit.

## What it shows

- **Usage limits** – the 5-hour and 7-day windows (or a gateway's spend limit) as a bar, with the percentage used, a status (OK / HIGH / CRITICAL) and the time left until the reset.
- **Tokens in the 5-hour window** – a bar chart of the model calls in the current window, coloured by model family (Fable yellow, Opus magenta, Sonnet cyan, Haiku green, any other family neutral), with last / tallest bar / total.
- **Per model** – the share of the 5-hour limit each model has taken (`~x%`), and its input, output, cache written and cache read.
- **Session cost** – in US dollars, as Claude Code totals it.

It updates after every model call, when you send a message, and every 15 seconds (for the reset countdown). The status line also shows `Session NN% · resets in …`.

Without a 5-hour limit (an API key, Bedrock, Vertex, or before the first reading) the panel shows tokens and cost only: percentages would have nothing to rest on.

## Commands

| Command | What it does |
| --- | --- |
| `/token-chart` | Reopens the panel and prints the same summary as text (useful where the surface cannot draw a side panel) |
| `/token-chart cache <w>` | Fixes the cache-read weight by hand (0 to 1) |
| `/token-chart cache auto` | Goes back to learning it |
| `/token-chart reset` | Clears everything the mod has stored and starts again from the starting values |

## Install

Replace `OWNER` in `homepage` and publish this folder as a repository; then `/plugin install token-chart --marketplace <owner>/<repo>`, or load the folder directly in a session:

```
claude --plugin-dir <path-to>/token-chart
```

or put the path in `CLAUDE_CODE_PLUGIN_DIRS`.

## Options

| Option | Values | Default |
| --- | --- | --- |
| `language` | `it`, `en` | `it` |
| `openOnStart` | `yes`, `no` | `yes` |

## How consumption is weighed

Every call of a model family is counted as `input + 5 x output + 1.25 x cache written + w x cache read`, and each family has its own weight on the limit. `w` is the **cache-read weight**; the panel shows how much of your consumption comes from re-reading the cache.

The mod starts from values measured on one account (Pro plan, October 2026: identical jobs on each model, the limit read at each whole-point crossing):

| | Starting value | 95% range on that account |
| --- | --- | --- |
| Sonnet, tokens per 1% | about 108k | 84k to 128k |
| Opus, weight (Sonnet = 1) | 1.5 | 1.2 to 1.8 |
| Haiku, weight (Sonnet = 1) | 0.07 | 0.06 to 0.11 |
| Cache read, weight `w` | 0.03 | 0.02 to 0.04 |

Then it **learns from your own use**. Each time the limit moves up by a point it stores how many tokens of each family and of cache read that took, and refits:

- **The size of a point** depends on your plan (on Pro it is several times smaller than on Max, on Max 20x several times larger), so it is taken from your own crossings from the first one on, with nothing pulling it toward the value above. That value only fills in before your first crossing.
- **The weight of each family** is pulled toward the measured ratios (Opus 1.5, Haiku 0.07) until your data says otherwise: a mix of models that varies little cannot tell the families apart, and the measured ratios carry over between plans better than the size of a point does.
- **A family never measured** (Fable, or a model that comes out later) gets a weight of its own, learned from scratch; it never lands on Sonnet's.
- **The cache-read weight**, unless you fixed it by hand.

The summary lists for PRO plan what has been learned: `learned weights: Sonnet 1% ≈ 110k · Opus x1.48 · Haiku x0.07 · n=40`.

## What the mod cannot see, and what it does about it

The limit belongs to your account; the mod counts only the calls of the Claude Code it runs in.

- **Usage elsewhere** (claude.ai, the desktop or mobile app, another computer, Claude Code without the mod, another plugin calling the model) moves the limit with no tokens counted here. A crossing far off the rest is left out of the learning, pass after pass, and the panel says how many (`left out N`). Small usage elsewhere hides in the noise and makes a point look cheaper than it is: for clean figures, do not use Claude elsewhere while you want the mod to learn.
- **Several Claude Code sessions on the same computer** each add their tokens under a key of their own, a crossing is measured against the sum of all of them, and the first session to see the limit move takes the interval: the same crossing is never counted twice.
- **Compacting** rewrites the whole prompt cache in a call of its own, so the crossing that spans a `/compact` is left out.
- **Modes priced differently under the same model name** (fast mode, contexts over 200k tokens, a one-hour cache) are mixed into that model's weight.

Calls are kept for the chart of the current window (with an hour to spare), at most 8,000; the chart groups them into bars (1 bar = N calls) so none is dropped. The learning keeps the last 600 crossings; the store as a whole stays far below its 4 MiB limit. Data saved by version 1.0 is converted on the first start, not lost.

Changing and reloading any mod rewrites the prompt cache of the session once, which costs a few percent of the 5-hour window; avoid reloading it in the middle of something you are measuring.

### How close to the truth

The panel shows `estimate reliability ±x% · n=…/…`: the 95% error of the size of a point, worked out from how far your own crossings scatter around the fit, and how many crossings it would take to reach ±5%. Before there are enough crossings to work it out, it falls back to what one account measured (about ±20% after 19 crossings). The limit is reported as a whole number, which alone makes each crossing uncertain by about half a point: that is why it takes dozens of crossings, not a handful, to get close.

The figure assumes the weights do not change. Anthropic can change them without notice; then the oldest crossings go stale, and the margin is optimistic until newer ones replace them, which is what the next line is for.

### Has something changed?

The panel and `/token-chart` show `recent change against the learned weights`: the last 10 crossings compared with what the fit predicts for them. `+30%` means the limit is filling 30% faster than the tokens you used would explain (a point now costs fewer tokens), `-30%` slower. Within the noise of 10 crossings (worked out from your data, shown as `±x%`) it says `within noise`; beyond it the line turns yellow and says `LIKELY CHANGE`. It stays `n/a` for the first 30 crossings. After a confirmed change, `/token-chart reset` makes the mod learn the new weights from scratch instead of slowly.

This line catches a change in how Anthropic weighs tokens. A skill or habit that makes you use fewer tokens is not a change of weights: it shows in the chart itself, as fewer tokens per call and a smaller share per model.

## Read this before trusting the numbers

This is an indicator, not an exact meter.

- Claude Code reports your limit only as a **percentage**, never as a token cap. Every figure in tokens is worked out from how many tokens this mod counted while the percentage moved.
- "Cache read" tokens are shown apart and left out of the token totals: they are the conversation re-read on each call and weigh far less.
- The side panel is drawn only by surfaces that place panes (the full-screen terminal, 144 columns or more when opened unasked). If yours does not, use `/token-chart` and the status line.
- It relies on the mod API of Claude Code 2.1.295, which may change.

## Develop

```
claude plugin validate .
claude plugin test .
```

The tests simulate accounts with known weights (Pro, Max, Max 20x, a model never measured, usage elsewhere, two sessions, a change of limits) and check that the mod finds them.

## License

MIT
