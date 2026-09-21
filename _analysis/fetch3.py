#!/usr/bin/env python3
"""Threaded Blockscout fetcher for Robinhood Chain (chain 4663).

* tasks paginate sequentially, tasks run in a thread pool
* every page is written to disk incrementally (partial data survives)
* hard global deadline so the CI job always reaches the commit step
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://robinhoodchain.blockscout.com"
OUT = os.path.join(HERE, "raw")
os.makedirs(OUT, exist_ok=True)

DEADLINE = time.time() + float(os.environ.get("DEADLINE_SECONDS", 1500))
CFG = json.load(open(os.path.join(HERE, "targets.json")))
PAGES = CFG.get("pages", {})
PRINT_LOCK = threading.Lock()
SKIP_PATHS = set()


def log(*a):
    with PRINT_LOCK:
        print(*a, flush=True)


def get(url, tries=3):
    if time.time() > DEADLINE:
        raise TimeoutError("deadline")
    err = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url, headers={"accept": "application/json", "user-agent": "analysis/1.0"}
            )
            with urllib.request.urlopen(req, timeout=25) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            err = "HTTP %s" % exc.code
            if exc.code < 500 and exc.code != 429:
                raise RuntimeError(err)
            time.sleep(1 + attempt)
        except Exception as exc:  # noqa: BLE001
            err = repr(exc)[:120]
            time.sleep(1 + attempt)
    raise RuntimeError(err or "unknown")


def fetch_pages(name, path, max_pages, kind="list"):
    out_path = os.path.join(OUT, name + ".json")
    if os.path.exists(out_path) and os.path.getsize(out_path) > 60:
        return name + ":skip"
    items, obj, pages, url, err = [], None, 0, BASE + path, None
    while url and pages < max_pages and time.time() < DEADLINE:
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
            items.extend(data.get("items") or [])
            nxt = data.get("next_page_params")
            if nxt and items:
                q = "&".join("%s=%s" % (k, v) for k, v in nxt.items())
                url = BASE + path + ("&" if "?" in path else "?") + q
            else:
                url = None
        else:
            obj, url = data, None
    payload = obj if kind == "obj" else {
        "name": name, "path": path, "pages": pages, "err": err,
        "count": len(items), "items": items,
    }
    with open(out_path, "w") as fh:
        json.dump(payload, fh)
    n = 1 if kind == "obj" else len(items)
    log("OK %-40s pages=%-3s n=%-5s %s" % (name, pages, n, err or ""))
    return "%s:n=%s" % (name, n)


def build_tasks():
    tasks = []
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    if only in ("all", "contracts"):
        for label, addr in CFG.get("contracts", {}).items():
            a = addr.lower()
            tasks.append(("contract_%s" % label, "/api/v2/addresses/%s" % a, 1, "obj"))
            tasks.append(("contract_%s_counters" % label,
                          "/api/v2/addresses/%s/counters" % a, 1, "obj"))
    if only in ("all", "wallets"):
        for i, w in enumerate(CFG.get("wallets", [])):
            w = w.lower()
            tag = "wallet%02d_%s" % (i, w[2:8])
            tasks.append((tag + "_info", "/api/v2/addresses/%s" % w, 1, "obj"))
            tasks.append((tag + "_counters", "/api/v2/addresses/%s/counters" % w, 1, "obj"))
            tasks.append((tag + "_txs", "/api/v2/addresses/%s/transactions" % w,
                          PAGES.get("txs", 15), "list"))
            tasks.append((tag + "_tt", "/api/v2/addresses/%s/token-transfers?type=ERC-20" % w,
                          PAGES.get("tt", 15), "list"))
            tasks.append((tag + "_itx", "/api/v2/addresses/%s/internal-transactions" % w,
                          PAGES.get("itx", 8), "list"))
    if only in ("all", "tokens"):
        for i, t in enumerate(CFG.get("tokens", [])):
            tok = t["token"].lower()
            tag = "token%02d_%s" % (i, tok[2:8])
            tasks.append((tag + "_info", "/api/v2/tokens/%s" % tok, 1, "obj"))
            tasks.append((tag + "_counters", "/api/v2/tokens/%s/counters" % tok, 1, "obj"))
            tasks.append((tag + "_holders", "/api/v2/tokens/%s/holders" % tok,
                          PAGES.get("holders", 15), "list"))
            tasks.append((tag + "_transfers", "/api/v2/tokens/%s/transfers" % tok,
                          PAGES.get("transfers", 25), "list"))
            tasks.append((tag + "_txs", "/api/v2/addresses/%s/transactions" % tok,
                          PAGES.get("token_txs", 25), "list"))
            tasks.append((tag + "_addr", "/api/v2/addresses/%s" % tok, 1, "obj"))
            tasks.append((tag + "_src", "/api/v2/smart-contracts/%s" % tok, 1, "obj"))
    return tasks


def main():
    tasks = build_tasks()
    log("tasks=%d deadline_in=%.0fs" % (len(tasks), DEADLINE - time.time()))
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(fetch_pages, *t) for t in tasks]
        for fut in futures:
            try:
                fut.result()
            except Exception as exc:  # noqa: BLE001
                log("TASKFAIL", repr(exc)[:200])


if __name__ == "__main__":
    t0 = time.time()
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        log("FATAL", repr(exc)[:300])
    log("done in %.1fs" % (time.time() - t0))
