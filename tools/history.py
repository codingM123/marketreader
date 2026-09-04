"""One-shot: 5y daily OHLCV + dividend/split events per symbol.
Feeds volatility baselines, 52-week levels and the corporate-action table."""
import json, os, sys, time, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "history")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from record import SYMBOLS

os.makedirs(OUT, exist_ok=True)
ok = fail = 0
for sym in SYMBOLS:
    y = sym if sym.startswith("^") else sym + ".NS"
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(y)}"
           f"?interval=1d&range=5y&events=div%2Csplit")
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.loads(r.read().decode())
        res = (d.get("chart", {}).get("result") or [None])[0]
        if not res:
            raise ValueError("empty result")
        with open(os.path.join(OUT, sym.replace("^", "_") + ".json"), "w", encoding="utf-8") as f:
            json.dump(res, f, separators=(",", ":"))
        ev = res.get("events", {}) or {}
        n = len(res.get("timestamp") or [])
        print(f"  {sym:12s} bars={n:5d} div={len(ev.get('dividends',{}))} split={len(ev.get('splits',{}))}", flush=True)
        ok += 1
    except Exception as e:
        print(f"  !{sym}: {type(e).__name__} {e}", flush=True)
        fail += 1
    time.sleep(0.25)
print(f"\ndone ok={ok} fail={fail}")
