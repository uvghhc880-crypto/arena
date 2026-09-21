#!/usr/bin/env python3
"""Threaded, rate-limit-aware Blockscout fetcher for Robinhood Chain (chain 4663).

* tasks paginate sequentially, tasks run in a small thread pool
* global token-bucket rate limiter + 429 backoff (public Blockscout throttles hard)
* every page is written to disk; a hard deadline keeps the CI job inside budget
"""
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://robinhoodchain.blockscout.com"
OUT = os.path.join(HERE, "raw")
os.makedirs(OUT, exist_ok=True)

DEADLINE = time.time() + float(os.environ.get("DEADLINE_SECONDS", 1500))
CFG = json.load(open(os.path.join(HERE, "targets.json")))
PAGES = CFG.get("pages", {})
PRINT_LOCK = threading.Lock()
RL_LOCK = threading.Lock()
REQ_TIMES = deque()
MAX_RPS = float(os.environ.get("MAX_RPS", 2.5))
RETRY_AFTER = [0.0]

BROWSER_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "origin": BASE,
    "referer": BASE + "/",
    "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
}


def log(*a):
    with PRINT_LOCK:
        print(*a, flush=True)


def rate_limit():
    while True:
        with RL_LOCK:
            now = time.time()
            if now < RETRY_AFTER[0]:
                wait = RETRY_AFTER[0] - now
            else:
                while REQ_TIMES and now - REQ_TIMES[0] > 1.0:
                    REQ_TIMES.popleft()
                if len(REQ_TIMES) < MAX_RPS:
                    REQ_TIMES.append(now)
                    return
                wait = 1.0 - (now - REQ_TIMES[0]) + 0.05
        time.sleep(max(0.05, min(wait, 5)) + random.random() * 0.2)


def note_429():
    with RL_LOCK:
        RETRY_AFTER[0] = max(RETRY_AFTER[0], time.time() + 20 + random.random() * 10)


def get(url, tries=8):
    if time.time() > DEADLINE:
        raise TimeoutError("deadline")
    err = None
    for attempt in range(tries):
        rate_limit()
        try:
            req = urllib.request.Request(url, headers=BROWSER_HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            err = "HTTP %s" % exc.code
            if exc.code == 429:
                note_429()
                time.sleep(5 + attempt * 3)
                continue
            if exc.code < 500:
                raise RuntimeError(err)
            time.sleep(2 + attempt)
        except TimeoutError:
            raise
        except Exception as exc:  # noqa: BLE001
            err = repr(exc)[:120]
            time.sleep(2 + attempt)
    raise RuntimeError(err or "unknown")


def fetch_pages(name, path, max_pages, kind="list"):
    out_path = os.path.join(OUT, name + ".json")
    if os.path.exists(out_path) and os.path.getsize(out_path) > 60:
        try:
            prev = json.load(open(out_path))
            if not (isinstance(prev, dict) and prev.get("err")):
                return name + ":skip"
        except Exception:  # noqa: BLE001
            pass
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
    log("OK %-40s pages=%-3s n=%-6s %s" % (name, pages, n, err or ""))
    return "%s:n=%s" % (name, n)


def add_wallet_tasks(tasks, prefix, addr, pages):
    a = addr.lower()
    tag = "%s_%s" % (prefix, a[2:8])
    tasks.append((tag + "_info", "/api/v2/addresses/%s" % a, 1, "obj"))
    tasks.append((tag + "_counters", "/api/v2/addresses/%s/counters" % a, 1, "obj"))
    tasks.append((tag + "_txs", "/api/v2/addresses/%s/transactions" % a, pages.get("txs", 15)))
    tasks.append((tag + "_tt", "/api/v2/addresses/%s/token-transfers?type=ERC-20" % a,
                  pages.get("tt", 15)))
    tasks.append((tag + "_itx", "/api/v2/addresses/%s/internal-transactions" % a,
                  pages.get("itx", 10)))


def build_tasks():
    tasks = []
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    order = CFG.get("order") or ["tokens", "wallets", "watch", "contracts"]
    if only != "all":
        order = [only]
    for group in order:
        if group == "tokens":
            for i, t in enumerate(CFG.get("tokens", [])):
                tok = t["token"].lower()
                tag = "token%02d_%s" % (i, tok[2:8])
                tasks.append((tag + "_info", "/api/v2/tokens/%s" % tok, 1, "obj"))
                tasks.append((tag + "_counters", "/api/v2/tokens/%s/counters" % tok, 1, "obj"))
                tasks.append((tag + "_holders", "/api/v2/tokens/%s/holders" % tok,
                              PAGES.get("holders", 12)))
                tasks.append((tag + "_transfers", "/api/v2/tokens/%s/transfers" % tok,
                              PAGES.get("transfers", 60)))
                tasks.append((tag + "_txs", "/api/v2/addresses/%s/transactions" % tok,
                              PAGES.get("token_txs", 30)))
                tasks.append((tag + "_addr", "/api/v2/addresses/%s" % tok, 1, "obj"))
                tasks.append((tag + "_src", "/api/v2/smart-contracts/%s" % tok, 1, "obj"))
        elif group == "wallets":
            for i, w in enumerate(CFG.get("wallets", [])):
                add_wallet_tasks(tasks, "wallet%02d" % i, w, PAGES)
        elif group == "watch":
            for i, w in enumerate(CFG.get("watch", [])):
                add_wallet_tasks(tasks, "watch%02d" % i, w,
                                 {"txs": PAGES.get("watch_txs", 4), "tt": PAGES.get("watch_tt", 4),
                                  "itx": PAGES.get("watch_itx", 2)})
        elif group == "contracts":
            for label, addr in CFG.get("contracts", {}).items():
                a = addr.lower()
                tasks.append(("contract_%s" % label, "/api/v2/addresses/%s" % a, 1, "obj"))
                tasks.append(("contract_%s_counters" % label,
                              "/api/v2/addresses/%s/counters" % a, 1, "obj"))
    return tasks


def main():
    tasks = build_tasks()
    log("tasks=%d deadline_in=%.0fs max_rps=%.1f" % (len(tasks), DEADLINE - time.time(), MAX_RPS))
    workers = int(os.environ.get("WORKERS", 3))
    with ThreadPoolExecutor(max_workers=workers) as pool:
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
