#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
warp-scan - اسکن endpoint های Cloudflare WARP برای یافتن کشور خروجی دلخواه

مشکل: WARP با anycast همیشه به نزدیک‌ترین گره وصل می‌شود، پس سرور آلمانی
      همیشه خروجی آلمان می‌گیرد. راه‌حل: endpoint را دستی عوض کنید.

روش کار: اینترفیس WARP را بالا نگه می‌دارد و با `wg set` فقط endpoint را
         عوض می‌کند (سریع، بدون tear down) و بعد با cdn-cgi/trace می‌بیند
         آن endpoint کاربر را در کدام کشور نشان می‌دهد.

استفاده:
    sudo python3 warp-scan.py --iface wgcf --scan
    sudo python3 warp-scan.py --iface wgcf --scan --want DE,NL,US
    sudo python3 warp-scan.py --iface wgcf --check
"""

from __future__ import annotations

import argparse
import ipaddress
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

# --- محدوده‌های IP و پورت‌های endpoint کلادفلر ---
ENDPOINT_CIDRS = [
    "162.159.192.0/24",
    "162.159.193.0/24",
    "162.159.195.0/24",
    "162.159.204.0/24",
    "188.114.96.0/24",
    "188.114.97.0/24",
    "188.114.98.0/24",
    "188.114.99.0/24",
]

ENDPOINT_PORTS = [
    500, 854, 859, 864, 878, 880, 890, 891, 894, 903, 908, 928, 934, 939,
    942, 943, 945, 946, 955, 968, 987, 988, 1002, 1010, 1014, 1018, 1070,
    1074, 1180, 1387, 1701, 1843, 2371, 2408, 2506, 3138, 3476, 3581, 3854,
    4177, 4198, 4233, 4500, 5279, 5956, 7103, 7152, 7156, 7281, 7559, 8319,
    8742, 8854, 8886,
]

TRACE_HOST = "https://www.cloudflare.com/cdn-cgi/trace"
C_OK, C_ERR, C_WARN, C_OFF = "\033[32m", "\033[31m", "\033[33m", "\033[0m"


def sh(cmd: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


# ---------------------------------------------------------------------------
# تشخیص
# ---------------------------------------------------------------------------

def warp_peer_pubkey(iface: str) -> Optional[str]:
    """کلید عمومی peer اینترفیس WARP."""
    r = sh(["wg", "show", iface, "peers"])
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return r.stdout.strip().splitlines()[0].strip()


def trace(iface: Optional[str] = None, timeout: int = 8) -> Optional[dict]:
    """cdn-cgi/trace را می‌خواند؛ اگر iface داده شود، ترافیک از آن می‌رود."""
    cmd = ["curl", "-s", "--max-time", str(timeout)]
    if iface:
        cmd += ["--interface", iface]
    cmd.append(TRACE_HOST)
    try:
        r = sh(cmd, timeout=timeout + 5)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode != 0 or not r.stdout:
        return None
    out = {}
    for line in r.stdout.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out if "ip" in out else None


def set_endpoint(iface: str, pubkey: str, host: str, port: int) -> bool:
    """endpoint را روی اینترفیس زنده عوض می‌کند (بدون tear down)."""
    r = sh(["wg", "set", iface, "peer", pubkey, "endpoint", f"{host}:{port}"])
    return r.returncode == 0


def tcp_latency(host: str, port: int, timeout_s: float = 2.5) -> Optional[float]:
    """تأخیر TCP ساده به endpoint (فقط برای مرتب‌سازی اولیه)."""
    import socket
    t0 = time.time()
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            return round((time.time() - t0) * 1000, 1)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# حالت check
# ---------------------------------------------------------------------------

def do_check(iface: str) -> int:
    print(f"\n{'='*66}\n  تشخیص وضعیت WARP روی اینترفیس «{iface}»\n{'='*66}\n")

    r = sh(["ip", "link", "show", iface])
    if r.returncode != 0:
        print(f"{C_ERR}[x] اینترفیس {iface} وجود ندارد.{C_OFF}")
        print("    اول با wgcf آن را بسازید:  wgcf register && wgcf generate")
        return 1
    print(f"{C_OK}[+]{C_OFF} اینترفیس {iface} موجود است")

    pub = warp_peer_pubkey(iface)
    if not pub:
        print(f"{C_ERR}[x] peer پیدا نشد — اینترفیس بالا نیست{C_OFF}")
        return 1
    print(f"{C_OK}[+]{C_OFF} peer: {pub[:24]}...")

    r = sh(["wg", "show", iface, "endpoints"])
    print(f"    endpoint فعلی: {r.stdout.strip() or '(نامشخص)'}")

    mtu_r = sh(["ip", "-o", "link", "show", iface])
    m = re.search(r"mtu (\d+)", mtu_r.stdout)
    mtu = int(m.group(1)) if m else None
    if mtu:
        if mtu > 1300:
            print(f"{C_WARN}[!]{C_OFF} MTU = {mtu}  ← زیاد است، کندی می‌آورد")
            print(f"       پیشنهاد: MTU = 1280")
        else:
            print(f"{C_OK}[+]{C_OFF} MTU = {mtu}  (خوب)")

    print("\n--- trace بدون WARP (مستقیم) ---")
    direct = trace(None)
    if direct:
        print(f"    ip={direct.get('ip')}  colo={direct.get('colo')}  loc={direct.get('loc')}")
    else:
        print("    (ناموفق)")

    print("\n--- trace از داخل WARP ---")
    via = trace(iface)
    if not via:
        print(f"{C_ERR}[x] از داخل تونل جواب نگرفتیم{C_OFF}")
        return 1
    print(f"    ip={via.get('ip')}  colo={via.get('colo')}  loc={via.get('loc')}")
    print(f"    warp={via.get('warp')}  gateway={via.get('gateway')}")

    if via.get("warp") != "on":
        print(f"{C_WARN}[!]{C_OFF} warp=on نیست — ترافیک از تونل نمی‌رود")
    if direct and via.get("loc") == direct.get("loc"):
        print(f"{C_WARN}[!]{C_OFF} کشور خروجی با حالت مستقیم یکی است ({via.get('loc')})")
        print("       یعنی endpoint فعلی به گره‌ای می‌رود که کاربر را در همان کشور نشان می‌دهد.")
        print("       برای عوض کردن:  --scan --want DE,NL,US")

    print("\nخلاصه:")
    print(f"  گره لبه (colo)      : {via.get('colo')}")
    print(f"  کشوری که سایت‌ها می‌بینند (loc) : {via.get('loc')}   ← این مهم است")
    print(f"  IP خروجی            : {via.get('ip')}  (آی‌پی کلادفلر — طبیعی است)")
    print()
    return 0


# ---------------------------------------------------------------------------
# حالت scan
# ---------------------------------------------------------------------------

def candidate_endpoints(sample_per_subnet: int) -> list[tuple[str, int]]:
    out = []
    for cidr in ENDPOINT_CIDRS:
        net = list(ipaddress.ip_network(cidr).hosts())
        step = max(1, len(net) // sample_per_subnet)
        for ip in net[::step][:sample_per_subnet]:
            for port in (2408, 500, 1701, 890, 880):
                out.append((str(ip), port))
    return out


def do_scan(iface: str, want: Optional[set[str]], workers: int, sample: int, top: int) -> int:
    pub = warp_peer_pubkey(iface)
    if not pub:
        print(f"{C_ERR}[x] اینترفیس {iface} بالا نیست یا peer ندارد{C_OFF}")
        return 1

    cands = candidate_endpoints(sample)
    print(f"\n[*] {len(cands)} endpoint برای بررسی")
    if want:
        print(f"[*] فقط کشورهای: {', '.join(sorted(want))}")
    print(f"[*] تست با {workers} رشته ...\n")

    results: list[dict] = []
    lock = __import__("threading").Lock()

    def probe(host: str, port: int):
        lat = tcp_latency(host, port)
        if lat is None:
            return None
        with lock:
            if not set_endpoint(iface, pub, host, port):
                return None
            time.sleep(0.35)                      # فرصت برای برقراری
            t = trace(iface, timeout=5)
        if not t:
            return None
        t.update({"host": host, "port": port, "tcp_ms": lat})
        return t

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(probe, h, p) for h, p in cands]
        done = 0
        for f in as_completed(futs):
            done += 1
            try:
                r = f.result()
            except Exception:
                r = None
            if r:
                results.append(r)
            if done % 25 == 0:
                print(f"    ... {done}/{len(cands)}  (موفق: {len(results)})", file=sys.stderr)

    if not results:
        print(f"{C_ERR}[x] هیچ endpointی جواب نداد{C_OFF}")
        print("    احتمالاً اینترفیس بالا نیست. اول:  sudo wg-quick up wgcf")
        return 1

    # گروه‌بندی بر اساس کشور
    by_loc: dict[str, list[dict]] = {}
    for r in results:
        by_loc.setdefault(r.get("loc", "??"), []).append(r)
    for v in by_loc.values():
        v.sort(key=lambda x: x["tcp_ms"])

    if want:
        found = {k: v for k, v in by_loc.items() if k in want}
        missing = want - set(by_loc)
    else:
        found, missing = by_loc, set()

    print(f"\n{'='*66}\n  کشورهای پیدا‌شده ({len(found)})\n{'='*66}\n")
    print(f"  {'loc':<5} {'colo':<6} {'endpoint':<24} {'tcp':>8}  {'ip خروجی'}")
    print("  " + "-" * 62)
    for loc in sorted(found):
        for r in found[loc][:top]:
            star = f"{C_OK}*{C_OFF}" if not want else " "
            print(f"  {loc:<5} {str(r.get('colo')):<6} "
                  f"{r['host'] + ':' + str(r['port']):<24} "
                  f"{r['tcp_ms']:>7.1f}ms  {r.get('ip')}")
        print()

    if missing:
        print(f"{C_WARN}[!]{C_OFF} این کشورها در این دور پیدا نشدند: {', '.join(sorted(missing))}")
        print("    با --sample بیشتر یا --full دوباره امتحان کنید.\n")

    # بهترین‌ها را در فایل بنویس
    best_lines = []
    for loc in sorted(found):
        r = found[loc][0]
        best_lines.append(f"{loc}\t{r['host']}:{r['port']}\t{r['tcp_ms']}ms\tcolo={r.get('colo')}")
    if best_lines:
        with open("warp-best.txt", "w", encoding="utf-8") as f:
            f.write("# کشور\tendpoint\tتأخیر\tگره\n")
            f.write("\n".join(best_lines) + "\n")
        print(f"{C_OK}[+]{C_OFF} بهترین endpoint هر کشور ذخیره شد: warp-best.txt")

    # مقایسه با حالت قبلی
    print("\nبرای اعمال یک endpoint مشخص:")
    if found:
        loc0 = sorted(found)[0]
        r0 = found[loc0][0]
        print(f"  sudo wg set {iface} peer {pub[:16]}... endpoint {r0['host']}:{r0['port']}")
    print()
    return 0


# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="اسکن endpoint های WARP برای کشور خروجی دلخواه",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="مثال:\n"
               "  sudo python3 warp-scan.py --iface wgcf --check\n"
               "  sudo python3 warp-scan.py --iface wgcf --scan --want DE,NL,US\n",
    )
    ap.add_argument("--iface", "-i", default="wgcf", help="نام اینترفیس WARP")
    ap.add_argument("--check", action="store_true", help="تشخیص وضعیت فعلی")
    ap.add_argument("--scan", action="store_true", help="اسکن endpoint ها")
    ap.add_argument("--want", "-w", help="فقط این کشورها: DE,NL,US")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--sample", type=int, default=12, help="نمونه در هر subnet")
    ap.add_argument("--top", type=int, default=3, help="چند نتیجه در هر کشور")
    args = ap.parse_args()

    for tool in ("wg", "curl", "ip"):
        if not __import__("shutil").which(tool):
            print(f"{C_ERR}[x] ابزار لازم نصب نیست: {tool}{C_OFF}")
            return 1

    if args.check or not args.scan:
        return do_check(args.iface)
    want = set(x.strip().upper() for x in args.want.split(",")) if args.want else None
    return do_scan(args.iface, want, args.workers, args.sample, args.top)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[!] لغو شد")
        sys.exit(130)
