# MarketReader — decisions

A running log, written as the calls were made rather than reconstructed
afterwards. Times are IST on 4–7 September 2026.

**The entries below are left as they were written, including the ones that
turned out to be wrong.** An adversarial review at the end of the build found
that several of the arguments here describe a system adjacent to the one I
actually shipped — the estimator in R1, the horizon in R2, the threshold in R3,
the false-positive claim in R7. Editing them out would make this a nicer
document and a dishonest one; the value of a decision log is that it records
what you believed at the time. The review pass at the end says what was true.

---

### 14:17 — Record the market before anything else

The brief opened at 11:00 on Friday and closes at 11:00 on Monday. NSE was open
for 72 more minutes of that window and then shut until Monday morning. Everything
built after 15:30 on Friday would have nothing to run against, and a reviewer
opening this at any point over the weekend would see an empty screen through no
fault of the product.

So the first thing written was not architecture. It was a recorder.
`tools/record.py` captured 51 symbols on a ~30-second cycle until the close (7,038
ticks over 72 minutes, including the transition into the close), and
`tools/history.py` pulled five years of daily bars with dividend and split events.

Everything since has been developed against that recording, and the app ships in
replay mode by default so it works at any hour with no network.

**Consequence:** the clock had to become a dependency rather than a call to
`Date.now()`, which turned out to be the single most useful decision in the build.
It is why the time machine in the lab exists at all.

---

### 14:40 — "Meaningful" is a z-score, not a percentage

The brief leaves the definition of meaningful change open, and it is the whole
problem. A fixed percentage threshold has a different false-positive rate for
every stock on a list. Three percent in HDFC Bank is an event; three percent in a
smallcap that swings eight percent a day is Tuesday. One number cannot serve both.

Normalising by each instrument's own realised volatility makes the threshold a
constant false-positive rate instead of a constant percentage.

Chose EWMA over a rolling window because volatility is regime-dependent: a flat
20-day window treats a shock from 20 days ago exactly like one from yesterday and
then drops it off a cliff on day 21, so thresholds jump for no reason the market
can see.

**Rejected:** a percentile of the stock's own historical moves. More robust in
principle, but it needs a lot more history to be stable and it cannot be scaled to
an arbitrary horizon, which the per-user window requires.

---

### 14:45 — Market-relative, not absolute

The failure mode that makes watchlists unreadable is a red day: the index drops
3%, twenty cards fire, and every one of them says the same thing.

Each stock's move is decomposed against its beta to NIFTY 50 and only the residual
is scored. This also surfaces the case nobody catches — a stock that went up on a
day everything else fell — which is qualitatively different news and easy to miss.

**Cost:** a beta is one more thing that can be wrong, and it needs 60+ paired
observations. Where it is unavailable the detector falls back to total volatility
rather than pretending.

---

### 15:05 — Absolute floor alongside the relative threshold

A very low-volatility instrument can produce a three-sigma event on a 0.3% move.
Statistically true; humanly irrelevant. Both a relative and an absolute threshold
must be crossed. This is the kind of thing a purely statistical design gets wrong
and a person notices immediately.

---

### 15:10 — Tests found a double-adjustment for splits

Wrote golden tests against the recorded five-year history rather than against
fixtures, on the theory that synthetic tests prove the code does what you told it
and only real data proves what you told it was true.

They immediately failed. Yahoo's chart endpoint returns closes that are *already*
split-adjusted, alongside an `adjclose` that is split *and* dividend adjusted, and
documents neither. Applying our own adjustment on top fabricated a −90% return on
Nestlé's 10:1 split date, inflating its volatility estimate more than twentyfold —
which would have raised every threshold derived from it and silently suppressed
every real signal from that stock for months. Nothing threw.

**Decision:** the provider boundary now *declares* its price-adjustment semantics
as a typed field, and `detectAdjustment()` *verifies* the declaration against the
data on load by checking the return across each known split's ex-date. A test
asserts declaration and observation agree for every symbol that has a split to
test against. If a vendor changes this silently, the next test run fails loudly
instead of the product quietly degrading.

This is the bug I would show someone who asked what I learned.

---

### 15:12 — The corporate-action feed is incomplete, and that is provable

While fixing the above, found that Vedanta fell 65% in a single session on its
2026 demerger and the provider reports **no split and no dividend** for that date.
Also found real single-session moves past 20% that are not corporate actions at
all: Adani Enterprises −28% on the January 2023 short-seller report, Adani Ports
−21% on the June 2024 election result. F&O names have no fixed circuit band, so
"nothing moves more than 20%" is simply false.

**Decision:** a feed-only defence is not enough. Added a second, purely
statistical guard for moves too large to have been trading, which reports "we
cannot tell you what happened here — verify against the exchange" rather than a
confident wrong number.

Calibrating it is the actual difficulty: loose enough to catch a demerger, tight
enough to let a genuine 28% crash through as news. Both sides have a test.

---

### 15:18 — Robust volatility

Vedanta's −65% is still in the sample. Left in, it raises that stock's volatility
estimate enough to suppress every genuine signal it produces afterwards.

Volatility is now estimated on winsorised returns, clipped at five robust sigmas
(median absolute deviation, rescaled). This keeps a structural event from
redefining "normal" without pretending it did not happen — the detector still sees
the raw move and treats it as the structural event it is.

---

### 15:20 — Volume in log space

Daily turnover is strongly right-skewed. On a raw scale the arithmetic mean sits
well above the median, so an ordinary day scores negative and a single block deal
drags the mean for months. Log volume is close enough to symmetric for a z-score
to mean anything. The geometric mean is what the "×normal" figure on screen uses.

---

### 15:22 — Watermarks are monotonic, enforced in SQL

Someone reads the digest on a phone, then opens a laptop that has been asleep
since yesterday.

Last-write-wins lets the laptop's stale watermark overwrite the phone's, so
everything already read reappears. Reversing the ordering silently swallows news
they never saw. Both are unacceptable and no clock is accurate enough to arbitrate
between two devices.

**Decision:** take the maximum. The merge becomes commutative and idempotent, so
the outcome does not depend on which device syncs first. The guard lives in the
`WHERE` clause of the upsert rather than in application code, so two concurrent
syncs cannot interleave a read and a write around it.

**Corollary:** reading the digest does not advance the watermark. Acknowledgement
is a separate endpoint. A background refresh or a tab restored in a pocket must
not consume news.

---

### 15:25 — Immutable event log, separate read state

The tempting design is a `seen` boolean on the event row. Once flipped, the fact
that the event ever happened is unrecoverable, so history views and any post-hoc
debugging of a bad alert become impossible.

Events are facts about the market and are never mutated. Whether a person has
looked at one is a fact about that person and lives in `event_reads`.

---

### 15:30 — Fan-in ingestion

The obvious design fetches a user's list when that user asks. Cost is
users × symbols, nearly all of it redundant, and it degrades worst in the exact
moment it matters — everyone opening the app at once because the market moved.

One worker subscribes to the union of every watched symbol. There is one current
price for Reliance whether one person or a million watch it. Cost is bounded by
the exchange, not the user base, and is flat in users.

The redundancy removed is reported live as `fanInRatio` on `/api/status`, because
a number nobody can see is a claim rather than a property.

---

### 15:35 — Seven quality states, not two

Most watchlists have a number or a spinner. That is not enough to be honest. "This
price is 20 minutes old" has at least four causes and each demands a different
thing on screen:

- the market is shut → the old price is the *right* answer
- the stock has not traded → the price is real, the stock is thin
- our feed has fallen over → we do not know the price
- the value is impossible → we know the price is *wrong*

Collapsing these into one "stale" badge means either crying wolf every evening or
hiding a real outage. The `illiquid` / `stale` split specifically is decided by
comparing against the freshest timestamp across the whole universe: if everything
else is printing, the feed is fine and this scrip is simply thin.

---

### 16:10 — The sanity band was drawn in the wrong place

Exercising the fault injector caught a layering mistake. The quality layer was
rejecting anything more than 50% from the previous close as "bad data". Sounds
prudent; it is wrong. A 10:1 split prints at exactly a tenth of yesterday's close.
Vedanta's real demerger printed at −65%. Both were being labelled corrupt, which
is false and strictly less useful than the truth.

Deciding whether a large move is corruption, a corporate action, or genuine news
needs the action feed and the instrument's baseline. The quality layer has
neither. **It now catches only what cannot be a price under any reading** — zero,
negative, non-finite, a future timestamp, and magnitude errors of the kind a
units bug produces. Everything below that is the detector's judgement.

Worse: the test that "proved" the old behaviour had widened the band to bypass the
quality layer, so it was verifying something the running system did not do. The
test now runs against the production constant.

---

### 16:20 — The structural guard needed a relative arm

An injected +47% print over a five-session window fell below the absolute
threshold and was reported as an ordinary 15-sigma move. Fifteen sigma is not a
big day; it is evidence that the model does not apply.

Added a z-score arm at 12 sigma — far above anything the ranking thresholds use,
which top out around 2.5, so nothing a person would call a big day can reach it
while a corrupted print does so immediately.

---

### 16:35 — Rewinding the clock has to clear the quote cache

The store rejects any print older than the one it holds. Correct for a real feed,
exactly wrong for time travel: after the lab rewinds, every cached quote carries a
timestamp in the future and the quality layer reports clock skew across the whole
list.

Rather than weaken the monotonic guard — which exists precisely so a re-delivered
old print cannot walk a price backwards — the lab discards the cache and lets it
refill. Time only runs backwards in the lab.

---

---

# The review pass

With the build working, I had it reviewed adversarially against its own
documentation and its own data before submitting. That turned out to be the most
valuable hour of the project, and the entries below are the result. I am keeping
them in full rather than quietly folding the fixes into the entries above,
because what the defects have in common is more instructive than any one of
them: **not one threw, not one produced a number outside a plausible range, the
test suite was green throughout, and three of them passed *because of how I had
shaped the fixtures*.**

---

### R1 — The estimator I documented was not the estimator I shipped

`detect()` divides by `residualVol`. I had written `residualVol` as
`stdev(residuals)` — a flat, equal-weighted standard deviation over 500 sessions
— while the EWMA estimator sits right next to it as `dailyVol`, reached only by
symbols with no beta. Which is to say: almost none.

So the entry at 14:40 above, arguing carefully for exponential decay over a flat
window, is about a quantity the detector never touches. My own sentence — *"a
flat window treats a shock 20 days ago exactly like one yesterday, then drops it
off a cliff on day 21"* — described my shipped code, with 500 in place of 20.

**Fixed:** residuals are decayed with the same half-life as everything else. A
test asserts the denominator is the EWMA one and is measurably not the flat one,
so the two cannot drift apart again.

**What I take from it:** an estimator only reached by a fallback path is not the
system's estimator, and reading the code top to bottom does not tell you which
branch actually runs. I should have printed it.

---

### R2 — Two clocks, and the gap between them was where the product broke

Volatility is estimated from close-to-close returns. A close-to-close return
contains an entire overnight gap. But I scaled it over `sessionsBetween`, which
counts only minutes the market was open — so from Friday's close to Monday's
open the horizon is *zero*, floored at one trading minute, while the price in
front of the user has absorbed a whole weekend of news.

Dividing a close-to-close sigma down to a minute inflates the z-score up to
nineteenfold. An ordinary +1% Monday gap came out at **thirteen sigma**, and the
product told the user to verify against the exchange.

The bitter part: this was caused by the feature I was proudest of. The entry at
15:10 celebrates getting Friday-to-Monday to count as zero sessions, and there is
a test for it. That number is correct as *elapsed trading time* and wrong as a
*risk horizon*, and I never separated the two ideas.

**Fixed:** `riskHorizonSessions` charges a full session for every market open the
window crosses, because that is the unit the denominator was measured in.
`sessionsBetween` still means what it always meant.

---

### R3 — A relative threshold cannot tell a crash from a split

The structural guard had two arms: an absolute magnitude, and `|z| >= 12`. I
justified the twelve by comparing it against the ranking thresholds, which top
out near 2.5, and concluded nothing a person would call a big day could reach it.

That is a category error. Comparing one z against another says nothing about what
*magnitude* reaches it. Measured against my own shipped baselines, twelve sigma
lands at an 11.8% move in Reliance and 10.2% in HDFC Bank. I ran a genuine 28%
single-session crash — Adani Enterprises, January 2023, the largest real move in
five years of this universe — through every symbol: **47 of 49 reported it as
"we cannot tell you what happened here."** The product refusing to work on the
one day it exists for.

Worse, my golden test asserting the opposite passed, because `detectAcross`
rebuilds the baseline from `bars.slice(0, idx)` — Adani's own crisis-period
volatility — rather than the 500-session baseline the runtime computes. The test
proved the guard on a baseline the running system never produces. That is the
same species of defect as R1, which I had congratulated myself for fixing three
entries earlier.

**Fixed:** the z-arm is gone. A genuine crash *is* 28 sigma, so no cutoff
separates it from a split; magnitude is what actually distinguishes a corporate
action from news. The remaining test is per-session rather than across the user's
window, so absence length cannot change the verdict, and it asks whether known
actions *explain* the move rather than whether any exist — the old predicate let
one unrelated dividend disable the whole defence, and over a year the chance of
some action falling in the window approaches nine in ten.

---

### R4 — The price oracle answered questions about the past with the future

Yahoo stamps daily bars at the session *open* while the row carries the session's
*close*. I passed that through unchanged, so `priceAt(09:20)` returned the 15:30
price and reported it as a 09:20 observation.

Every number this product exists to produce is a comparison against an instant
the user chose. So "since you last looked" collapsed to roughly zero for every
intraday absence — while the conventional "today" figure printed beside it stayed
correct. The number I built the product to replace was the accurate one.

**Fixed:** bars are re-stamped at the close on load, and `priceAt` refuses any
observation later than the instant asked about. The postcondition reads as too
obvious to write down, which is exactly why it went unwritten.

---

### R5 — The primary interaction did nothing

`addWatch` seeds a watermark at wall-clock time. `acknowledge` wrote the exchange
timestamp, which is older by construction. The monotonic guard — correctly —
rejected it. So "mark all as seen" silently did nothing on the first click, and
nothing at all while the market was shut, which is when the app is most often
opened. The digest stayed pinned to its first-visit copy forever.

Two good decisions combining into a bug, and neither wrong on its own.

**Fixed:** the seed is flagged as a placeholder rather than inferred from a device
string, and only a placeholder is exempt from monotonicity. A real watermark
still cannot move backwards, and there are tests for both.

---

### R6 — I wrote confident comments and did not check them

The house style here is comments that assert properties in prose. Under a judging
format built around "do you really understand what you built", a checkably false
assertion is worse than no comment at all, because a reader who catches one has
to wonder about the rest.

A sample of what was found: a chart comment saying the price axis was
"deliberately not normalised" sitting above a per-card min-max normalisation;
"the line is not interpolated across a Sunday" above a single continuous polyline
that ran through every gap; "verifies the declaration on load, so a vendor
changing it fails loudly" for a check that only ever ran inside the test suite;
"batch-shaped, asks for all of them at once" for a serial loop at five requests a
second.

**Fixed** in whichever direction was right. The chart now lifts the pen at session
boundaries, because the comment described the better behaviour. The adjustment
check runs at boot and reports on `/api/status`. The normalisation comment now
says which axis is shared and which is not. The batching claim is withdrawn, and
the README says plainly that the fan-in argument is about shape while the
implementation is not yet the thing the argument describes.

---

### R7 — I claimed a constant false-positive rate and never measured it

*"So the threshold is a constant false-positive rate rather than a constant
percentage"* appears three times across the code and the docs and is the
load-bearing sentence of the design. There are five years of prices in this
repository and I had never pointed it at them.

Measured out of sample across 49 symbols and 34,732 held-out sessions: at
`|z| >= 2.0` the pooled rate is 8.7% against a Gaussian 4.6%, and across
instruments it runs from **0.8% (Suzlon) to 15.0% (TCS)**. Not constant, and not
close.

The reason is not a bug: standardising equalises scale, not shape. Equity returns
are fat-tailed and their kurtosis differs by name, so one threshold cuts
different fractions of different distributions.

**Fixed by correcting the claim rather than the code**, and by making the
measurement permanent. `calibration.test.ts` measures the alert rate, the
per-instrument spread, and the out-of-sample volatility reduction from the market
adjustment (median 13.9%, implied R-squared 0.26, harmful for none of 49). The
README quotes those numbers instead of the sentence.

The number that turned out to matter at product level was the one I had not
thought to ask for: on a twenty-symbol list a visit surfaces **1.7 cards** against
a cap of five. That is the defensible claim, and it is measured.

**And the replaced test deserves naming.** `golden.test.ts` asserted
`residualVol < stdev(returns)` for every symbol as evidence the market adjustment
worked. Regressing on any factor cannot increase residual variance in sample — it
is an algebraic identity, and my own comment in the test said so. It could not
fail, and I had counted it as evidence.

---

### R8 — Smaller, and all of the same kind

- 52-week levels were computed from closes while the traded high and low were
  parsed and thrown away. "Broke its 52-week high" is a claim about a price that
  printed, and the gap runs to nearly 4% on this universe.
- `/api/health` could not return unhealthy: it tested `store.symbols > 0`, and the
  store only grows.
- Five of eight lab buttons appeared to do nothing, because staleness is a
  function of elapsed time and nothing advanced the clock. A reviewer clicking
  "kill the feed" and seeing no change learns the opposite of the truth.
- Freezing a symbol never landed — it served the first recorded tick, older than
  the quote already held, so the monotonic guard rejected it. The fault produced
  the same behaviour as `OUT_OF_ORDER` while inflating the counter I describe as
  the earliest warning of a misbehaving upstream.
- A symbol the provider had stopped returning was indistinguishable from a thin
  one. The provider *told us*, I discarded it, and then inferred the same
  conclusion from silence — later, and less certainly.
- `CREATE TABLE IF NOT EXISTS` is not a migration. Adding a column broke every
  request on any database older than an hour.
- `CALENDAR_VERIFIED_UNTIL` was exported and read by nothing, which reads like a
  safeguard and is not one.
- The lab endpoints — unauthenticated writes to global state, including one that
  moves watermarks backwards — were registered in live mode.

---

### What I would tell someone starting this again

Three things, in order of how much they cost me.

**Print the numbers your system produces, early.** Every defect above except R6
was findable in ten minutes with a script that ran the detector over the data
already sitting in the repository and printed what came out. I wrote tests
instead, and tests only check the cases you thought of, against fixtures you
built — which is why three of mine passed while the behaviour they described was
broken.

**A test whose fixture you designed around the code is not evidence.** R3 is the
clean example: I built the baseline from the crisis window, the assertion passed,
and the running system did the opposite. The golden tests caught a real bug (the
split double-adjustment) precisely because I did not get to choose the data.

**Confident prose is a liability unless it is checked.** The comments here are the
thing I am most pleased with and were the largest single source of risk, because
several described a system adjacent to the one I built. Writing them was worth it.
Not re-reading them against the code was not.

---

## Things I would do differently with more time

- **Baselines belong in a nightly batch.** They are pure functions of history and
  are currently recomputed in memory at boot. Fine for fifty symbols, unacceptable
  for two thousand.
- **Fan-out needs a real pub/sub.** Each SSE client re-runs the whole digest
  pipeline on a timer. It should be a topic per symbol with per-user fan-out
  computed only on change.
- **Circuit bands should come from the exchange's daily file** rather than being
  assumed at the most permissive tier.
- **Beta should be shrunk toward one.** A single OLS fit on 500 sessions is noisy
  for thin names; a Bayesian shrinkage estimator would be better behaved and is
  about ten lines.
- **The holiday calendar should sync itself.** It is data with a stated verified
  horizon and a runtime backstop, which is honest but not a solution.

---

# The frontend, and a second look

### 19:05 — Two experiences, one product

The product was one screen. It was the right first build and the wrong thing to
submit, because the argument it makes is not visible in it: a stranger opening a
digest sees a list of cards, and everything interesting is *why those cards and
not the other thirteen*.

So `/` became an overview whose job is to make the case, and the product moved
behind it. The rule I set for the overview was that every section must carry a
working element rather than a description of one — the hero is a slider that
re-runs the real pipeline against recorded prices at seven absence lengths, the
"what is normal" section reads two live baselines and shows one stock firing
while the other stays silent at the same percentage, the beta section runs two
scenarios against a live beta. Nothing on it is typed in.

**Cost:** 539 lines of `Landing.tsx` and about 1,400 of CSS that no test covers.
**Rejected:** a static hero with a screenshot and a number. It would have been an
hour's work, and it would have been describing the thesis rather than showing it,
which is the exact failure the thesis is about.

### 19:20 — Six routes, and the test each had to pass

The temptation with a sidebar is to fill it. The test I used: **delete this
route, and a real capability stops being reachable.** Six passed.

Two of them mattered more than the rest. `/watch/history` and `/system` had no UI
at all — `GET /api/events` and `GET /api/status` existed, were argued for at
length in this file, and had no consumer. An immutable log with read state held
separately, and a fan-in design whose cost is bounded by the exchange rather than
the user count, were both claims. Putting them on screen makes them checkable.
`/watch/all` earned its place differently: it is where adding and removing
symbols lives, which is the brief's *first* stated minimum and was buried.

**Rejected:** twelve routes. A citizen portal, an intel lab and a case archive
would have looked like more product and been padding, and this brief says in as
many words that it is not counting features.

### 19:35 — The router is eighty lines and not a dependency

Seven static paths, no parameters, no nested layouts beyond one shell. A router
library is the conventional answer and would be more code here, not less.

The trade is real and I want it stated rather than implied: no route params, no
data loaders, no lazy boundaries. If any of those were needed this becomes a
dependency rather than grows. The one thing I did not cut is that `Link` renders
a real `href` and intercepts only a plain left-click, so middle-click and
open-in-new-tab still work — that is the part people actually notice missing.

### 19:50 — `/api/preview` exists because `/api/digest` is a command

The landing slider needed a digest for an arbitrary absence. `GET /api/digest`
could not serve it, for a reason that turned out to be a defect in its own right:
it wrote to the event log. A query-named endpoint was a command, on a timer, once
per connected SSE reader.

Splitting `computeDigest` (reads, never writes) from `buildDigestFor` (compute,
then record) fixed that and produced the endpoint the landing page needed for
free. A stranger dragging a control cannot move anyone's watermark.

**Still owed:** the split exists and the read endpoints do not use it. `GET
/api/digest` and the stream both still call the write path. The log does not grow
because `recordEvent` is idempotent on its dedupe key, which is why it is safe —
not the design. It is in Known limits rather than fixed.

---

# The second review pass

Six agents were pointed at the build with instructions to refute it. What they
returned is worse for me than the first pass, because two of the findings were in
fixes I had already written up as done.

### R9 — The two fixes I was proudest of were the two that were wrong

**The risk horizon.** R2 found that scaling volatility over elapsed *trading*
time made a weekend gap a zero-length window, so an ordinary Monday gap came out
at thirteen sigma. I fixed it by taking the **maximum** of overnight gaps and
elapsed trading time, wrote it up, and moved on.

That replaced a 19x inflation with a 2x deflation of exactly the window this
product is named after. Measured out of sample, overnight moves fired at 1.87%
against 9.88% for a same-day move of identical significance. The number that
disproved it — that an overnight gap carries 23.8% of close-to-close variance,
not 100% — was sitting in the comment directly above the code I wrote. Variance
is additive, so the horizon is additive: `gaps x 0.238 + elapsed x 0.762`.

**The structural guard.** R3 removed its relative arm. The replacement compared a
**window**-level explained fraction against a **session**-level magnitude, which
reopened the hole it was written to close and made it worse the longer you were
away: over six months a net return can be near zero, so a small dividend explains
a large *fraction* of it, and a 65% overnight collapse inside that window was
reported as "dividend in this window; the adjusted move is −0.3%". It now weighs
the absolute price impact the known actions carry against the size of the worst
single session, which is scale-free — a rupee of dividend cannot account for two
thirds of a share price at any window length.

Same shape both times: I fixed the direction of the error and not its magnitude,
and I checked the fix against the case that motivated it rather than against the
data. Both were caught by someone re-reading my own comments against my own code.

### R10 — Three fixes reverted with a green suite

After R9 I mutated the fixes to see whether the suite would catch a revert. Three
survived.

The estimator test compared EWMA against a flat standard deviation on real data,
where the two land within a few percent — so reverting to `stdev`, the exact bug
R1 found, passed. The discriminating case is a synthetic regime change, which is
the entire reason for weighting recency. The structural-guard tests pinned the
watermark price to the previous close, making `maxSessionMove` and the window
return identical *by construction*, so a mutation swapping one for the other
passed everything.

A test whose fixture was designed around the code is not evidence. I wrote that
sentence in this file after the first review pass and then shipped three more
instances of it.

### R11 — The frontend had never been opened in a browser

Not once. `.btn` and `.btnrow` were referenced by twenty-one elements and defined
in neither stylesheet, so the lab rendered as unstyled text. Every landing
section shipped at `opacity: 0`, revealed only by an IntersectionObserver — a
black page on first paint, and permanently black if the observer never fired.
That single rule explains a whole session of screenshots I had assumed were a
capture-tooling problem.

A third turned up later, in the one state this product is actually about. The
sparkline lifts its pen across closed sessions, which is right: a diagonal
through a weekend draws a journey the price never took. But a session that
printed once became a subpath of a single `moveto`, and SVG strokes nothing with
no length — so across a five-session absence, where each session contributes one
close, the whole price path was invisible. Intraday windows have many prints per
session, which is why only the long-absence case broke. The long absence is the
case the product exists for. Isolated prints are now drawn as points.

Typechecks passed throughout. All three were a browser away.

### R12 — A ledger that was empty in every state

"Nothing is dropped silently" is the loudest claim in this project, and the page
that demonstrates it was empty on arrival in every account, because a symbol that
stayed inside its range left no record at all — it was counted, and the count was
the record.

A new `NOTHING_UNUSUAL` signal now records the near miss with the distance it
fell short by (`RELIANCE — 1.9σ against a bar of 2.0σ`), and `rank()` routes it
to the ledger ahead of the cooldown pass so it can never compete for a card slot.
A fresh clone's demo account now arrives with 2 cards and 13 ledger rows.

**Consequence I did not want:** the three counters on that page no longer
partition the evaluated set, and "quiet" is now structurally near zero. Recorded
in Known limits rather than papered over.

### R13 — The verified horizon nobody consulted

`CALENDAR_VERIFIED_UNTIL` was exported. `calendarIsVerified` was exported, and
carried a doc comment reading *"stating a verified horizon and then never reading
it is worse than not having one, because it reads like a safeguard."* Nothing in
the tree called it. R8 recorded exactly this as a found defect — and then the
README asserted the fix that was never made.

`/api/health` now returns a `warnings` array and reports the horizon once the
clock passes it, with two regression tests: one that it fires, one that it does
*not* fail liveness, because a guess about a holiday is not an outage and pulling
an instance out of rotation over documentation would be the obvious wrong fix.

The lesson is not about calendars. It is that a defect written up in a decision
log and left unfixed becomes worse than one nobody noticed, because the write-up
then reads as a fix to everyone including me.
