#!/usr/bin/env python3
"""Probe which egress paths reach Robinhood Chain data from a CI runner."""
import json
import urllib.parse
import urllib.request

BS = "https://robinhoodchain.blockscout.com"
TARGET = BS + "/api/v2/addresses/0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e/counters"
RPC = "https://rpc.mainnet.chain.robinhood.com"

BROWSER = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": BS,
    "Referer": BS + "/",
}


def show(label, url, headers=None, data=None, timeout=25):
    try:
        req = urllib.request.Request(url, headers=headers or {}, data=data)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(400).decode("utf-8", "replace")
            print("[%-22s] %s :: %s" % (label, resp.status, body.replace("\n", " ")[:300]))
    except Exception as exc:  # noqa: BLE001
        extra = ""
        if hasattr(exc, "read"):
            try:
                extra = exc.read(300).decode("utf-8", "replace").replace("\n", " ")
            except Exception:  # noqa: BLE001
                pass
        print("[%-22s] ERR %s :: %s" % (label, repr(exc)[:90], extra[:250]))


def rpc(label, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    show(label, RPC, {"content-type": "application/json"}, body)


enc = urllib.parse.quote(TARGET, safe="")
show("direct-plain", TARGET)
show("direct-browser", TARGET, BROWSER)
show("allorigins", "https://api.allorigins.win/raw?url=" + enc)
show("codetabs", "https://api.codetabs.com/v1/proxy?quest=" + enc)
show("corsproxy.io", "https://corsproxy.io/?" + enc)
show("cors.lol", "https://api.cors.lol/?url=" + enc)
show("whateverorigin", "https://whateverorigin.org/get?url=" + enc)
show("jina", "https://r.jina.ai/" + TARGET, {"accept": "application/json"})
show("textance", "https://api.scraperapi.com/?url=" + enc)
rpc("rpc-chainid", "eth_chainId", [])
rpc("rpc-block", "eth_blockNumber", [])
rpc("rpc-balance", "eth_getBalance",
    ["0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e", "latest"])
rpc("rpc-getlogs", "eth_getLogs",
    [{"address": "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e", "fromBlock": "0x1", "toBlock": "latest"}])
rpc("rpc-txcount", "eth_getTransactionCount",
    ["0x6eCd4Ff6Ca25A6D71236d6Ad66cBD86c25d4055F", "latest"])
