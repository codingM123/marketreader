"""
Live NSE tick recorder. Captures a real trading session to disk so the whole
system can be developed and demoed deterministically over the weekend, when
the market is closed. This file is a dev tool, not part of the product.
"""
import json, os, sys, time, urllib.request, urllib.parse, urllib.error, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TICKS = os.path.join(DATA, "ticks.jsonl")
BARS = os.path.join(DATA, "bars")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

SYMBOLS = [
    "^NSEI", "^NSEBANK",
    "RELIANCE", "HDFCBANK", "TCS", "INFY", "ICICIBANK", "SBIN", "ITC", "LT",
    "AXISBANK", "BHARTIARTL", "HINDUNILVR", "KOTAKBANK", "BAJFINANCE", "MARUTI",
    "SUNPHARMA", "TITAN", "ASIANPAINT", "NESTLEIND", "ULTRACEMCO", "WIPRO",
    "HCLTECH", "TECHM", "ONGC", "COALINDIA", "NTPC", "POWERGRID", "GRASIM",
    "TATAMOTORS", "TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL", "ADANIENT",
    "ADANIPORTS", "ETERNAL", "PAYTM", "IRFC", "SUZLON", "YESBANK", "IDEA",
    "JIOFIN", "TATAPOWER", "BEL", "RVNL", "IREDA", "HAL", "DLF", "BANKBARODA",
    "PNB", "CANBK",
]

def yurl(sym):
    y = sym if sym.startswith("^") else sym + ".NS"
    return f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(y)}?interval=1m&range=1d"

def fetch(url, timeout=12):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def snapshot(sym, res):
    m = res.get("meta", {}) or {}
    return {
        "sym": sym,
        "poll_ts": round(time.time(), 3),
        "mkt_ts": m.get("regularMarketTime"),
        "state": m.get("currentTradingPeriod", {}).get("regular") and "REGULAR" or None,
        "ltp": m.get("regularMarketPrice"),
        "prev_close": m.get("chartPreviousClose") or m.get("previousClose"),
        "day_high": m.get("regularMarketDayHigh"),
        "day_low": m.get("regularMarketDayLow"),
        "vol": m.get("regularMarketVolume"),
        "w52_high": m.get("fiftyTwoWeekHigh"),
        "w52_low": m.get("fiftyTwoWeekLow"),
        "ccy": m.get("currency"),
        "exch": m.get("exchangeName"),
        "tz_off": m.get("gmtoffset"),
    }

def main():
    os.makedirs(BARS, exist_ok=True)
    cycle = 0
    while True:
        cycle += 1
        ok = fail = 0
        with open(TICKS, "a", encoding="utf-8") as tf:
            for sym in SYMBOLS:
                try:
                    d = fetch(yurl(sym))
                    res = (d.get("chart", {}).get("result") or [None])[0]
                    if not res:
                        fail += 1; continue
                    tf.write(json.dumps(snapshot(sym, res), separators=(",", ":")) + "\n")
                    # full 1m series, overwritten each cycle -> last write is the complete day
                    with open(os.path.join(BARS, sym.replace("^", "_") + ".json"), "w", encoding="utf-8") as bf:
                        json.dump(res, bf, separators=(",", ":"))
                    ok += 1
                except Exception as e:
                    fail += 1
                    print(f"  !{sym}: {type(e).__name__}", file=sys.stderr, flush=True)
                time.sleep(0.18)
        print(f"[{datetime.datetime.now():%H:%M:%S}] cycle {cycle}  ok={ok} fail={fail}", flush=True)
        time.sleep(8)

if __name__ == "__main__":
    main()
