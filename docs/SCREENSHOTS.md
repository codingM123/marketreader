# Screenshots to capture before submitting

Five images and one short recording. Each has a fixed filename because
`README.md` already has a commented-out slot pointing at it — uncomment the
line once the file exists.

Everything below comes from a single run:

```bash
npm run serve
```

Then `http://localhost:8787`. Take them at a **1280px-wide window** and stay in
one theme for the whole set, so it reads as one product rather than five
screenshots of five things.

**If you only have time for three, take 01, 03 and 04.** Those are the digest,
the evidence panel, and a fault firing: the product, the proof, and the
resilience claim. The other two are upside.

---

### `docs/00-landing.png` — the argument, above the fold

Load `/`. Capture the first screen, before any scrolling: the headline, the
away-slider, and the cards the slider produced.

Then **drag the slider to "a month"** and take a second frame if you want one
extra. The card count and the wording change, because the cards are computed
live by `/api/preview` against the real recording — nothing on that page is a
mockup, and that is the point worth showing.

### `docs/01-digest.png` — the product

Go to `/watch`. Capture from the headline down through the second card, so the
frame contains:

- the headline and its subhead
- the absence ruler underneath, with its shaded session bands
- the first card, its sparkline, and the *you last saw ₹…* line

This is the one image that has to work alone. Someone who sees only this should
understand the thesis without reading a word.

### `docs/02-held-back.png` — the restraint

Go to `/watch/held-back`. Capture the list.

Every row is a symbol the system considered and deliberately did not show, with
the distance it fell short by — *1.9σ against a bar of 2.0σ*. Most watchlists
cannot produce this page, because they never decided anything. It is the
cheapest way to prove the digest is a judgement rather than a filter.

### `docs/03-why.png` — the evidence

Back on `/watch`, click **why this surfaced** on any price card. Capture the
card with the panel open and the evidence grid legible: return adjusted, return
raw, market return, beta, residual, sigma for horizon, horizon sessions,
z-score, baseline observations, rank score.

This is the answer to *how do you know?*, and for an engineering audience it is
the most persuasive frame in the set.

### `docs/04-lab.png` — a fault firing

Go to `/lab`. Under **Break the feed**, set **Target** to `SBIN`, then click
**Freeze one symbol**. Capture the page with the quality counters at the top
visible.

`SBIN` reads `illiquid` while every other symbol still reads `live`. That is the
distinction the seven-state taxonomy exists for — this symbol stopped printing,
the feed is fine — and it is the hardest thing here to explain in prose and the
easiest to show.

---

### `docs/demo.gif` (or `.mp4`) — ninety seconds

One take, no narration needed:

1. Land on `/`. Drag the away-slider from ten minutes to a month. The answer
   changes shape.
2. **Open the watchlist** → `/watch`. Pause on the headline.
3. Open a **why this surfaced** panel. Scroll the evidence.
4. `/watch/held-back` — what was considered and refused.
5. `/lab` → **Break the feed → Freeze one symbol** on `SBIN`. Point at
   `illiquid` sitting beside `live`.
6. `/lab` → **Undocumented 10:1** on `RELIANCE`. The card reads *"changed −90.0%
   with nothing on file to explain it"* rather than reporting a crash.
7. **Reset everything.**

Steps 5 and 6 are the whole argument. If the recording has to be shorter, keep
those and the headline.

---

### Then

Uncomment the matching `![...](docs/...)` line in `README.md` for each file you
captured, and delete the slots you did not fill — an image reference that 404s
reads worse than no image at all.

An image above the fold is the difference between depth that exists and depth
that gets noticed.
