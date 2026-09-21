#!/usr/bin/env python3
"""Robust Blockscout fetcher (v2) with global deadline + incremental dumps.

Design goals:
  * never exceed the job budget (deadline) -> always reach the upload step
  * write each page as it arrives so partial data survives a timeout
  * fail fast on permanent errors (404/422) so one bad endpoint cannot stall
    the whole run
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://robinhoodchain.blockscout.com"
OUT = os.path.join(HERE, "raw2")
os.makedirs(OUT, exist_ok=True)

DEADLINE = time.time() + float(os.environ.get("DEADLINE_SECONDS", 1500))
CFG = json.load(open(os.path.join(HERE, "targets.json")))
PAGES = CFG.get("pages", {})
SKIP = set()


def log(*a):
    print(*a, flush=True)


def get(url):
    if time.time() > DEADLINE:
        raise TimeoutError("deadline")
    last = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(
                url, headers={"accept": "application/json", "user-agent": "analysis/1.0"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            last = "HTTP %s" % exc.code
            if exc.code in (400, 401, 403, 404, 422):
                raise RuntimeError(last)
            time.sleep(2)
        except Exception as exc:  # noqa: BLE001
            last = repr(exc)[:160]
            time.sleep(2)
    raise RuntimeError(last or "unknown")


def dump(name, path, max_pages=20, kind="list"):
    out_path = os.path.join(OUT, name + ".json")
    if os.path.exists(out_path) and os.path.getsize(out_path) > 60:
        log("SKIP", name)
        return
    if path in SKIP:
        return
    items, obj, pages, url, err = [], None, 0, BASE + path, None
    while url and pages < max_pages:
        try:
            data = get(url)
        except TimeoutError:
            err = "deadline"
            break
        except RuntimeError as exc:
            err = str(exc)
            break
        pages += 1
        if isinstance(data, dict) and "items" in data:
            chunk = data.get("items") or []
            items.extend(chunk)
            nxt = data.get("next_page_params")
            if nxt and chunk and time.time() < DEADLINE:
                q = "&".join("%s=%s" % (k, v) for k, v in nxt.items())
                url = BASE + path + ("&" if "?" in path else "?") + q
            else:
                url = None
        else:
            obj, url = data, None
        time.sleep(0.25)
    if err in ("HTTP 404", "HTTP 422", "HTTP 400"):
        SKIP.add(path)
    payload = obj if kind == "obj" else {
        "name": name, "path": path, "pages": pages, "err": err,
        "count": len(items), "items": items,
    }
    if err and not items and obj is None:
        payload = {"name": name, "path": path, "err": err, "items": None}
    with open(out_path, "w") as fh:
        json.dump(payload, fh)
    n = 1 if kind == "obj" else len(items)
    log("OK %-42s pages=%s n=%s err=%s" % (name, pages, n, err))


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else "all"

    for label, addr in CFG.get("contracts", {}).items():
        if only in ("all", "contracts"):
            dump("contract_%s" % label, "/api/v2/addresses/%s" % addr, 1, "obj")
            dump("contract_%s_counters" % label, "/api/v2/addresses/%s/counters" % addr, 1, "obj")

    if only in ("all", "wallets"):
        for i, w in enumerate(CFG.get("wallets", [])):
            if time.time() > DEADLINE:
                break
            w = w.lower()
            tag = "wallet%02d_%s" % (i, w[2:8])
            dump(tag + "_info", "/api/v2/addresses/%s" % w, 1, "obj")
            dump(tag + "_counters", "/api/v2/addresses/%s/counters" % w, 1, "obj")
            dump(tag + "_txs", "/api/v2/addresses/%s/transactions" % w, PAGES.get("txs", 15))
            dump(tag + "_tt",
                 "/api/v2/addresses/%s/token-transfers?type=ERC-20" % w, PAGES.get("tt", 15))
            dump(tag + "_itx", "/api/v2/addresses/%s/internal-transactions" % w,
                 PAGES.get("itx", 8))

    if only in ("all", "tokens"):
        for i, t in enumerate(CFG.get("tokens", [])):
            if time.time() > DEADLINE:
                break
            tok = t["token"].lower()
            tag = "token%02d_%s" % (i, tok[2:8])
            dump(tag + "_info", "/api/v2/tokens/%s" % tok, 1, "obj")
            dump(tag + "_counters", "/api/v2/tokens/%s/counters" % tok, 1, "obj")
            dump(tag + "_holders", "/api/v2/tokens/%s/holders" % tok, PAGES.get("holders", 15))
            dump(tag + "_transfers", "/api/v2/tokens/%s/transfers" % tok,
                 PAGES.get("transfers", 25))
            dump(tag + "_txs", "/api/v2/addresses/%s/transactions" % tok,
                 PAGES.get("token_txs", 25))
            dump(tag + "_addr", "/api/v2/addresses/%s" % tok, 1, "obj")


if __name__ == "__main__":
    t0 = time.time()
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        log("FATAL", repr(exc)[:300])
    log("done in %.1fs" % (time.time() - t0))
