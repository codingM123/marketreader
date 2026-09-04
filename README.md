# MarketReader

A watchlist built around one question: what actually changed since *you* last
looked?

Prices are the easy part, and they're all on `/watch/all` with today's move,
σ/day, beta, 52-week range and a quote-age badge. But you already knew the price.
A watchlist that doesn't know when you last checked can only answer for a period
it picked itself.

So the window is a per-user watermark. Same market, same instant, different
answer depending on whether you've been gone ten minutes or a month. And
"meaningful" is measured against what each stock normally does, with the index
move taken out: a 3% day is 3.7σ of HDFCBANK's market-adjusted volatility and
1.9σ of SUZLON's. One of those is news. The other is a Tuesday.

Built for Code, by Groww.

```bash
npm install
npm run serve          # build + run on http://localhost:8787
```

No API key and no network needed. A real NSE session recorded on 4 September 2026
ships in `data/` and replays through a virtual clock, so it works at 3am on a
Sunday.

<!-- Screenshots: capture instructions in docs/SCREENSHOTS.md -->
<!-- ![The overview](docs/00-landing.png) -->

**Ninety seconds:** open `/` and drag the away-slider. Ten minutes gives one
card, an hour gives five, a week switches to a written summary, three months
surfaces five dividend cards that exist only because the window now contains
their ex-dates. All computed live by `/api/preview` against the recorded prices,
none mocked. Then `/watch/held-back` for what it decided *not* to show you, and
`/lab` to break the feed.

If you read two sections, read [what counts as
meaningful](#what-counts-as-meaningful), which I measured after claiming it, and
[what review found](#what-review-found).

---

## Setup

```bash
npm install
npm run serve                    # build + run, http://localhost:8787
MODE=live npm run serve          # network provider instead of the recording
npm test                         # 84 tests in 4 files; ~8s, ~18s from cold
npm run dev                      # two processes: web :5173, API :8787
```

Node `>=20.9 <23`. That range is declared in all three `package.json` files but
nothing enforces it, since there's no `.npmrc`. SQLite gets created on first boot
and there's nothing else to install.

If port 8787 is taken the server tells you and prints the override for your
shell. `PORT=8080 npm run serve` in bash or zsh, `$env:PORT=8080; npm run serve`
in PowerShell, `set PORT=8080 && npm run serve` in cmd.

Two gotchas worth knowing:

`PORT` only applies to `serve`. The dev proxy in `web/vite.config.ts` is pinned
to 8787, so moving the port under `npm run dev` gets you a UI talking to whatever
else happens to be on 8787 instead of the API it just started.

`npm test` needs to run from the repo root or from `server/`. Three of the test
files find `data/` relative to the working directory and quietly `describe.skip`
if they can't, which would leave you with a green suite that measured nothing.

Three accounts come seeded with a past, so a fresh clone opens onto a working
digest instead of a first-visit screen:

| Account | Policy | Away | Symbols |
| --- | --- | --- | --- |
| `demo` | balanced | 7 days | 15 |
| `asha` | signal | 3 days | 12 |
| `ravi` | everything | 30 days | 10 |

Switch between them in the header. One market seen through three different
absences is the fastest way to get the idea.

Replay mode also turns on `/lab`. Under `MODE=live` its five routes aren't
registered at all, the sidebar link hides, and the route itself checks, so a
bookmark gets an explanation instead of a page where every button 404s. `LAB=1`
turns it back on.

---

## What counts as meaningful

This design used to rest on one sentence: *the threshold is a constant
false-positive rate rather than a constant percentage.* Nice sentence. Nobody had
checked it against the five years of prices sitting in this repo.

I checked. It's false.

| Measured, out of sample | Value |
| --- | --- |
| Median volatility reduction from the market adjustment | **13.9%** (implied R² 0.26) |
| Symbols where the adjustment made things worse | **0 of 49** |
| Alert rate at \|z\| ≥ 2.0, pooled | **8.7%** (a normal distribution implies 4.6%) |
| Alert rate at \|z\| ≥ 2.5, pooled | **4.9%** (normal implies 1.2%) |
| Alert rate at \|z\| ≥ 2.0, across instruments | **0.8% to 15.0%** |
| Expected cards per visit, 20-symbol list | **1.7** |

49 symbols, 34,732 held-out sessions. `server/test/calibration.test.ts` runs all
of it.

Two things fell out of that, and both changed the design.

The rate isn't constant across instruments, and dividing by sigma can't make it
so. Sigma equalises scale, not shape. Equity returns are fat-tailed and the
kurtosis differs by name, so TCS fires 15.0% of the time and SUZLON 0.8% against
the same threshold. That's an 18× spread. It's why the system also caps cards,
holds a cooldown per event, and collapses market-wide moves instead of asking one
threshold to do all the work.

The rate is also higher than Gaussian everywhere, which is a fact about returns
and not a bug in my code. The row that matters for the product is the last one: a
typical visit shows fewer than two cards, against a cap of five.

That calibration test replaced one that asserted `residualVol < stdev(returns)`.
Which is an identity. Regressing on any factor can't increase residual variance
in sample, so it passed by construction and measured nothing at all.

The mechanism itself, per symbol: fit beta against NIFTY 50 over 500 sessions
(betas here run 0.498 to 1.710), subtract `beta × market return`, then divide
what's left by an EWMA volatility scaled to how long you were away. That's what
catches a stock that went *up* on a day everything else fell, and what turns a
market-wide selloff into one line instead of twenty cards.

---

## What review found

I reviewed the build against its own documentation and its own data before
submitting. Seven defects had survived a green test suite. What they have in
common is more interesting than any one of them: none threw, none produced a
number that looked wrong, and three passed *because of the way I'd built the
fixtures*.

**The estimator I documented wasn't the one I shipped.** `detect()` divided by a
flat equal-weighted standard deviation. The EWMA that every design note argues
for was only reached by symbols with no beta, which is almost none of them. Every
parameter discussion in `DECISIONS.md` was about a quantity the detector never
touched.

**Volatility was scaled over the wrong clock.** Close-to-close sigma, but elapsed
*trading* time as the horizon. Across a weekend that horizon is zero, so a 1.5%
Infosys gap came out at seventeen sigma.

**The structural guard was eating real crashes.** Its relative arm fired at 12σ.
A genuine 28% single-session fall is about 23σ at the median symbol here, so
there's no z-cutoff anywhere that separates a crash from a split. Measured
against the shipped baselines, 47 of 49 equities would have had a real crash
reported as "we cannot tell you what happened" — the product refusing to work on
the one day it exists for. The arm is gone. Magnitude does that job now.

**The price oracle answered with the future.** Yahoo stamps daily bars at the
session open while the row carries the close, so a lookup at 09:20 got back the
15:30 price labelled 09:20. "Since you last looked" collapsed to roughly zero for
every intraday absence, while the ordinary "today" figure next to it stayed
right. Bars get re-stamped at load now.

**Acknowledgement never worked.** Adding a symbol seeds a watermark at wall-clock
time. Acknowledging wrote the exchange timestamp, which is always older, so the
monotonic guard threw it out. The main interaction in the product did nothing at
all on the first click.

**Comments claimed things the code didn't do.** A chart comment denying a
normalisation it was performing. "Not interpolated across a Sunday" sitting above
a continuous polyline.

**The frontend had never been opened in a browser.** Not once. `.btn` and
`.btnrow` were used by twenty-one elements and defined in neither stylesheet, so
the lab rendered as plain text. Every landing section shipped at `opacity: 0`,
revealed only by an IntersectionObserver that hadn't fired, which meant a black
page on first paint. That one rule explained a whole session of screenshots I'd
blamed on the capture tooling.

A third UI bug turned up later, and it's my favourite of the lot. The sparkline
lifts its pen across closed sessions, which is right: drawing a diagonal through
a weekend invents a journey the price never took. But a session that printed only
once became a subpath containing a single `moveto`, and SVG strokes nothing when
there's no length to stroke. So across a five-session absence, where each session
contributes one close, the entire price path was invisible. Intraday windows have
plenty of prints per session, so only the long-absence case broke — which is the
case this whole product is for. Typechecks passed the whole time.

### The two fixes I was proudest of were the two that were wrong

Worth its own heading, because it's the part that generalises.

The overnight-gap horizon was wrong twice. First it inflated by up to 19×. Then
my fix took the maximum of two terms and deflated by about 2×, in exactly the
window this product is named after. Measured at the time, overnight moves fired
several times less often than same-day moves of equal significance.
`calibration.test.ts` now pins the two rates to each other, so the assertion does
the work instead of my recollection. Variance is additive, so the horizon is too:
`gaps × 0.238 + elapsed × 0.762`, where 0.238 is the overnight share of
close-to-close variance measured across all 51 recorded histories (median
0.2385). The number that disproved my first fix was sitting in the comment
directly above the code I wrote.

The structural guard was the same story. My fix compared a *window*-level
explained fraction against a *session*-level magnitude, which reopened the hole it
was written to close and got worse the longer you'd been away. Over six months a
net return can be near zero, so a trivial dividend "explains" a large fraction of
it, and a 65% overnight collapse inside that window came out as "dividend in this
window; the adjusted move is −0.3%". It now weighs the actual price impact of the
known actions against the size of the worst single session. A rupee of dividend
can't account for two thirds of a share price at any window length.

Both times I fixed the direction of the error and not its size, and I checked the
fix against the case that prompted it instead of against the data.

Full account, with timestamps and the things I rejected, in `DECISIONS.md`.

---

## What you see

<!-- ![The digest](docs/01-digest.png) -->

Six routes behind the overview. Each one shows work the server was already doing
with nowhere to put it: the suppression ledger, the event log with read state
joined onto it, the ingestion counters. Two of them, `/watch/history` and
`/system`, had no UI at all until this pass. The endpoints existed, this README
argued from them, and nothing rendered them.

| Route | What it is |
| --- | --- |
| `/watch` | The digest. Headline, absence ruler, cards, each with a *why this surfaced* panel: raw return, corporate-action-adjusted return, index return, beta, residual (the move with the market taken out), sigma for the horizon, z, baseline observations. |
| `/watch/all` | Every symbol whether it surfaced or not: price, today's move, move since you last looked, σ/day, beta, 52-week range, quote age. Deliberately monochrome. Add and remove symbols here. |
| `/watch/held-back` | Every candidate it generated and didn't show, with the reason. |
| `/watch/history` | The append-only event log, and whether each row was acknowledged. |
| `/lab` | Fault injection. |
| `/system` | Ingestion, quality counters, replay state. |

<!-- ![What was held back](docs/02-held-back.png) -->

The held-back ledger is the cheapest way to show nothing gets dropped silently.
A fresh clone of `demo` opens with 2 cards and 13 ledger rows, things like
`RELIANCE: 1.9σ against a bar of 2.0σ` and `HDFCBANK: 0.7σ against a bar of 2.0σ,
and below the 1.0% floor`. Symbols that stayed inside their range used to leave
no trace at all. They were counted, and the count was the whole record, which
quietly made a liar out of the loudest claim in the project.

<!-- ![Why this surfaced](docs/03-why.png) -->

The ruler and every sparkline share one time axis, so two moves at the same
horizontal position happened at the same moment. Usually that means the tape
rather than the company.

Colour has a noise budget. Green and red only appear on surfaced cards, and the
table at `/watch/all` is monochrome, because colour that's always on tells you
nothing. There's a third semantic most financial interfaces don't have: amber,
meaning *we can't tell you*. Corporate actions, stale feeds, structural moves
nobody can explain. Up is good, down is bad, amber is neither.

One control instead of a settings page: a three-stop slider over `signal`
(z 2.5, 3 cards, 6h cooldown), `balanced` (2.0, 5, 4h) and `everything`
(1.0, 25, 30m).

About `/`: no example on that page is remembered. The hero slider, the
two-instrument sigma comparison and the beta decomposition all read a live
`/api/preview`, because an earlier version had them typed in and a fact-check
found eight figures that were stale, wrong or impossible to reproduce. One was a
flagship "1.9σ" example card that the shipped detector would have suppressed at a
2.0 bar. What's still literal on that page is the historical material that can't
change: the Nestlé and Vedanta case studies, and the calibration table, which is
the same table as above and comes out of `calibration.test.ts`.

---

## The lab

<!-- ![A fault firing](docs/04-lab.png) -->

Resilience claims aren't worth much unless a stranger can check them in ninety
seconds. From a fresh boot on `demo`, whose 15 symbols include one that's
delisted on purpose:

| Do this | And this happens |
| --- | --- |
| Kill the feed | 14 symbols `STALE`, 1 `UNAVAILABLE` |
| Rate limit us | the same 14 `STALE` |
| Freeze one symbol | 1 `ILLIQUID`, 13 still `LIVE`. The feed is fine, this stock stopped printing |
| Delist a symbol | `UNAVAILABLE` plus a lifecycle card |
| Send garbage (85× the previous close) | `SUSPECT`, never displayed |
| Undocumented 10:1 | `SUSPECTED_STRUCTURAL`, not a −90% crash |
| Move it 47% | `SUSPECTED_STRUCTURAL` |
| Replay an old print | `REJECTED_OUT_OF_ORDER`. Prices don't walk backwards |

"Come back later" rewinds your watermark anywhere from ten minutes to a month.
Faults that need time to become visible advance the clock themselves and tell you
by how much.

---

## Architecture, and the rest of the brief

5,065 lines of TypeScript in `server/src`, 2,889 in `web/src` plus 2,323 of CSS,
1,542 of tests, 18 HTTP endpoints. Everything in `core/` is pure: `detect`,
`rank`, `digest`, `baseline`, `stats`, `calendar`, `clock`, `corporate`,
`quality`, `money`. No I/O, no network, and nothing outside `clock.ts` calls
`Date.now()`. `app.ts` is the single place where that meets the database.

### State across sessions and devices

One watermark per user per symbol, merged by taking the maximum, and the guard
lives in the `WHERE` clause of the upsert rather than in application code.

Why maximum: someone reads on their phone, then opens a laptop that's been asleep
since yesterday. Last-write-wins lets the stale watermark clobber the fresh one,
so everything they already read comes back. Flip the ordering and it swallows
news they never saw. No clock can arbitrate. Maximum makes the merge commutative
and idempotent, so the answer doesn't depend on which device syncs first.

The event log is immutable, and whether a row has been *seen* lives in a separate
table. A `seen` boolean on the event itself would destroy the record that it ever
happened, killing history views and any hope of debugging a bad alert later.

Reading doesn't acknowledge. Fetching the digest marks nothing, because a
background refresh or a phone restoring a tab in someone's pocket would otherwise
eat news nobody read. Acknowledgement is its own endpoint and its own button, and
`/watch/history` puts the join on screen so you can check it.

### Stale, delayed and conflicting data

Seven quote states: `LIVE`, `DELAYED`, `ILLIQUID`, `STALE`, `CLOSED`, `SUSPECT`,
`UNAVAILABLE`. "No trade in six minutes" and "the feed is down" are different
facts that look identical in a price field, and an 18-hour-old price is correct
at 6am on a Sunday and a fault at 11am on a Tuesday.

Out-of-order prints get rejected at the store. A price 85× the previous close
isn't a price.

A single-session move past 35% that the corporate-action feed can't account for
gets reported as *something structural happened and we can't tell you what*, never
as a crash. That's because the feed is provably incomplete, and I can show you:
Vedanta fell 64.9% in one session on its 2026 demerger, and the feed carries no
split for it, ever. It carries 17 dividends. So it isn't a sparse feed, it's a
feed that's wrong about the one event that mattered. Nestlé India is the mirror
image, a real 10:1 on 5 January 2024: ₹27,116.40 the day before, ₹2,754.00 the
morning after. Naively that's −89.8%. For whoever held it, it was +1.6%.

### Scale

Ingestion fans in. One fetch per distinct symbol across all users, not one per
watchlist row. On a fresh clone `/api/status` reports 37 watchlist rows served by
28 fetches, 9 saved per cycle, fan-in 1.32. That's a number `/system` prints, not
a sentence I'm asking you to believe.

The union of watched symbols grows much slower than the user count, so cost is
bounded by the size of the exchange rather than by how many people show up. The
shape is right. The implementation isn't there yet: the Yahoo provider loops
symbols serially at 5 req/s, so two thousand symbols would take about 400
seconds. Its batch quote endpoint is the fix and I haven't written it.

### Where I didn't add complexity

**No authentication.** The user is a query parameter threaded through every layer
as a first-class value, so real auth is a middleware that sets it. Deliberate,
and the source says so.

**No router dependency.** `router.tsx` is 80 lines for seven static paths, and a
library would be more code than that, not less. Middle-click still opens a new
tab because the `href` is real. The trade-off is no route params, no data
loaders, no lazy boundaries. If I needed any of those, this becomes a dependency
rather than growing into one. The frontend depends on `react` and `react-dom`,
nothing else.

**No push notifications.** The digest *is* the notification, and adding push
before solving the ranking just moves the noise somewhere more annoying.

**No LLM summariser, no ML ranker.** Narrative sentences are templates filled
with computed numbers, so I can tell you why any of them said what it said. And
there's no labelled ground truth for "was this alert useful". No portfolio, no
news feed, no indicators either. Different products.

---

## Data

`tools/record.py` captured a live NSE session on 4 September 2026: 7,038 ticks
across 51 symbols over 72 minutes, running into the close. `tools/history.py`
pulled five years of daily bars with dividend and split events, 51 files and
62,153 bars going back to 2021-09-06. Both are committed, which is what lets a
fresh clone work offline.

The universe was picked for edge cases rather than market caps:

- a real 10:1 split (NESTLEIND, which also carries a later 2:1)
- an undocumented demerger (VEDL)
- a −28.2% session (ADANIENT, 1 February 2023)
- a recent listing with 688 daily bars where 48 of the 51 files have 1,240 (IREDA)
- a high- and a low-volatility pair (SUZLON, HINDUNILVR)
- one symbol the recorder asked for and got nothing back for (TATAMOTORS)

That last one stays on `demo`'s watchlist precisely *because* it has no data.
It's the only watched symbol with no history file and no ticks, so every run
exercises the unavailable path for real instead of through an injected fault.

Market data is Yahoo's public endpoints: delayed, unofficial, and fine for a
build about how you reason over market data. The provider interface is one file.

---
