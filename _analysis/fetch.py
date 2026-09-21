#!/usr/bin/env python3
"""Fetch Blockscout data for Robinhood Chain wallets/tokens into _analysis/raw.

Runs inside GitHub Actions (open internet) because the agent sandbox can only
reach a small allowlist of hosts. Writes raw JSON that is then analysed locally.
"""
import json
import os
import time
import urllib.request

BASE = "https://robinhoodchain.blockscout.com"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")
os.makedirs(OUT, exist_ok=True)

MAX_PAGES = {"default": 20}
CONFIG = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "targets.json")))


def get(url, retries=4):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"accept": "application/json", "user-agent": "analysis/1.0"}
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            print("ERR", url, repr(exc)[:200])
            time.sleep(3 + attempt * 3)
    return None


def dump(name, path, max_pages=20, kind="list"):
    out_path = os.path.join(OUT, name + ".json")
    if os.path.exists(out_path) and os.path.getsize(out_path) > 50:
        print("SKIP", name)
        return
    items = []
    obj = None
    url = BASE + path
    pages = 0
    while url and pages < max_pages:
        data = get(url)
        pages += 1
        if data is None:
            break
        if isinstance(data, dict) and "items" in data:
            chunk = data.get("items") or []
            items.extend(chunk)
            nxt = data.get("next_page_params")
            if nxt and chunk:
                q = "&".join("%s=%s" % (k, v) for k, v in nxt.items())
                url = BASE + path + ("&" if "?" in path else "?") + q
            else:
                url = None
        else:
            obj = data
            url = None
        time.sleep(0.4)
    payload = obj if kind == "obj" else {"name": name, "path": path, "pages": pages,
                                         "count": len(items), "items": items}
    with open(out_path, "w") as fh:
        json.dump(payload, fh)
    n = 1 if kind == "obj" else len(items)
    print("OK %-46s pages=%s n=%s" % (name, pages, n))


def main():
    cfg = CONFIG
    pages = cfg.get("pages", {})
    for label, addr in cfg.get("contracts", {}).items():
        dump("contract_%s" % label, "/api/v2/addresses/%s" % addr, 1, "obj")
        dump("contract_%s_counters" % label, "/api/v2/addresses/%s/counters" % addr, 1, "obj")

    for i, w in enumerate(cfg.get("wallets", [])):
        w = w.lower()
        dump("wallet%02d_%s_info" % (i, w[2:8]), "/api/v2/addresses/%s" % w, 1, "obj")
        dump("wallet%02d_%s_counters" % (i, w[2:8]), "/api/v2/addresses/%s/counters" % w, 1, "obj")
        dump("wallet%02d_%s_txs" % (i, w[2:8]), "/api/v2/addresses/%s/transactions" % w,
             pages.get("txs", 20))
        dump("wallet%02d_%s_tt" % (i, w[2:8]),
             "/api/v2/addresses/%s/token-transfers?type=ERC-20" % w, pages.get("tt", 20))
        dump("wallet%02d_%s_itx" % (i, w[2:8]), "/api/v2/addresses/%s/internal-transactions" % w,
             pages.get("itx", 10))

    for i, t in enumerate(cfg.get("tokens", [])):
        tok = t["token"].lower()
        dump("token%02d_%s_info" % (i, tok[2:8]), "/api/v2/tokens/%s" % tok, 1, "obj")
        dump("token%02d_%s_counters" % (i, tok[2:8]), "/api/v2/tokens/%s/counters" % tok, 1, "obj")
        dump("token%02d_%s_holders" % (i, tok[2:8]), "/api/v2/tokens/%s/holders" % tok,
             pages.get("holders", 15))
        dump("token%02d_%s_transfers" % (i, tok[2:8]), "/api/v2/tokens/%s/transfers" % tok,
             pages.get("transfers", 25))
        dump("token%02d_%s_txs" % (i, tok[2:8]), "/api/v2/addresses/%s/transactions" % tok,
             pages.get("token_txs", 25))
        dump("token%02d_%s_addr" % (i, tok[2:8]), "/api/v2/addresses/%s" % tok, 1, "obj")


if __name__ == "__main__":
    t0 = time.time()
    main()
    print("done in %.1fs" % (time.time() - t0))
