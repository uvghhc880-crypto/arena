#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iran-access — جمع‌آور کانفیگ‌های رایگان Xray/V2Ray تفکیک‌شده بر اساس کشور

هدف: دسترسی به اینترنت آزاد برای کاربران در کشورهای با فیلترینگ شدید.
منابع: مخازن عمومی و داوطلبانه‌ی گیت‌هاب که کانفیگ‌ها را آزادانه منتشر می‌کنند.

استفاده:
    python3 iran-access.py --list                     # لیست کشورهای موجود
    python3 iran-access.py --countries DE,NL,US,FR    # کانفیگ این کشورها
    python3 iran-access.py --all --out sub.txt        # همه کشورها
    python3 iran-access.py --countries DE --test      # + تست پینگ TCP

خروجی برای کلاینت‌های: v2rayNG, Hiddify, NekoBox, sing-box, Streisand, V2Box
"""

import argparse
import base64
import json
import os
import re
import socket
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# ---------------------------------------------------------------------------
# منابع عمومی (مخازن داوطلبانه روی گیت‌هاب)
# ---------------------------------------------------------------------------

SOURCE_COUNTRY = {
    "repo": "Argh94/V2RayAutoConfig",
    "path": "configs",           # configs/<Country>.txt
    "kind": "by_country",
}

SOURCE_MIXED = [
    # (repo, path)  — فایل‌های ترکیبی همه‌پروتکلی
    ("MatinGhanbari/v2ray-configs", "subscriptions/v2ray/all_sub.txt"),
    ("MatinGhanbari/v2ray-configs", "subscriptions/v2ray/super-sub.txt"),
    ("barry-far/V2ray-Config", "All_Config_base64_Sub.txt"),
    ("Epodonios/v2ray-configs", "All_Configs_base64_Sub.txt"),
]

# آینه‌ها برای دسترسی از داخل ایران (به ترتیب تلاش)
MIRRORS = [
    "https://raw.githubusercontent.com/{repo}/{branch}/{path}",
    "https://cdn.jsdelivr.net/gh/{repo}@{branch}/{path}",
    "https://gh-proxy.com/raw.githubusercontent.com/{repo}/{branch}/{path}",
    "https://ghfast.top/raw.githubusercontent.com/{repo}/{branch}/{path}",
]

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
TIMEOUT = 25

# ---------------------------------------------------------------------------
# واکشی
# ---------------------------------------------------------------------------


def fetch(repo: str, path: str, branch: str = "main") -> str | None:
    """فایل را از اولین آینه‌ی در دسترس می‌گیرد."""
    for tmpl in MIRRORS:
        url = tmpl.format(repo=repo, branch=branch, path=path)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                data = r.read()
            if not data:
                continue
            text = data.decode("utf-8", "ignore")
            # اگر base64 بود، باز کن
            if "://" not in text:
                try:
                    text = base64.b64decode(text + "=" * (-len(text) % 4)).decode("utf-8", "ignore")
                except Exception:
                    pass
            if "://" in text:
                return text
        except Exception:
            continue
    return None


def list_countries() -> list[str]:
    """لیست کشورهای موجود در منبع تفکیک‌شده."""
    # از API گیت‌هاب (اگر gh نصب باشد) یا وب
    try:
        import subprocess

        out = subprocess.run(
            ["gh", "api", f"/repos/{SOURCE_COUNTRY['repo']}/contents/{SOURCE_COUNTRY['path']}",
             "--jq", ".[].name"],
            capture_output=True, text=True, timeout=45,
        )
        if out.returncode == 0 and out.stdout.strip():
            names = out.stdout.strip().splitlines()
        else:
            raise RuntimeError("gh failed")
    except Exception:
        # fallback: خواندن README
        txt = fetch(SOURCE_COUNTRY["repo"], "README.md")
        names = re.findall(r"\|\s*([A-Za-z]+)\s*\|", txt or "") or []
        names = [n + ".txt" for n in names]

    skip = {"README.md", "Hysteria2.txt", "WireGuard.txt", "Tuic.txt",
            "Trojan.txt", "Vless.txt", "Vmess.txt", "ShadowSocks.txt", "ShadowSocksR.txt"}
    return sorted(n[:-4] for n in names if n.endswith(".txt") and n not in skip)


# ---------------------------------------------------------------------------
# پارس و اعتبارسنجی کانفیگ
# ---------------------------------------------------------------------------

SCHEMES = ("vless://", "vmess://", "trojan://", "ss://", "ssr://", "hysteria2://",
           "hy2://", "tuic://", "wireguard://", "wg://")


def extract_configs(text: str) -> list[str]:
    """همه‌ی خطوط کانفیگ را از متن بیرون می‌کشد."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        if line.startswith(SCHEMES):
            out.append(line)
    return out


def config_host_port(cfg: str) -> tuple[str | None, int | None]:
    """هاست و پورت را از کانفیگ استخراج می‌کند."""
    try:
        if cfg.startswith("vmess://"):
            raw = cfg[8:]
            raw = base64.b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8", "ignore")
            j = json.loads(raw)
            return j.get("add"), int(j.get("port", 0)) or None
        # vless/trojan/ss/hy2/tuic : scheme://[user@]host:port?...
        body = re.sub(r"^[a-z0-9]+://", "", cfg, flags=re.I)
        body = body.split("#")[0].split("?")[0]
        if "@" in body:
            body = body.rsplit("@", 1)[1]
        if body.startswith("["):                      # IPv6
            host, _, port = body.partition("]")
            return host.strip("[]"), int(port.lstrip(":")) if port.lstrip(":").isdigit() else None
        if ":" in body:
            host, _, port = body.rpartition(":")
            if port.isdigit():
                return host, int(port)
        return body or None, None
    except Exception:
        return None, None


def config_country_hint(cfg: str) -> str:
    """کد/نام کشور را از تگ کانفیگ حدس می‌زند (فقط برای گزارش)."""
    tag = cfg.split("#", 1)[1] if "#" in cfg else ""
    try:
        tag = urllib.parse.unquote(tag)
    except Exception:
        pass
    return tag.strip()[:60]


def tcp_ping(host: str, port: int, timeout: float = 3.0) -> float | None:
    """تأخیر اتصال TCP به میلی‌ثانیه. None اگر ناموفق."""
    if not host or not port:
        return None
    t0 = time.time()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return round((time.time() - t0) * 1000, 1)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(
        description="جمع‌آور کانفیگ رایگان تفکیک‌شده بر اساس کشور برای دسترسی آزاد",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--list", action="store_true", help="لیست کشورهای موجود")
    ap.add_argument("--countries", "-c", help="کدهای کشور با کاما: DE,NL,US")
    ap.add_argument("--all", action="store_true", help="همه‌ی کشورها")
    ap.add_argument("--mixed", action="store_true", help="فقط منابع ترکیبی")
    ap.add_argument("--out", "-o", default="subscription.txt", help="فایل خروجی")
    ap.add_argument("--limit", "-n", type=int, default=0, help="حداکثر تعداد کانفیگ (۰=بی‌نهایت)")
    ap.add_argument("--test", action="store_true", help="تست اتصال TCP و مرتب‌سازی بر اساس تأخیر")
    ap.add_argument("--workers", type=int, default=40, help="تعداد رشته‌های تست")
    args = ap.parse_args()

    if args.list:
        cs = list_countries()
        print(f"کشورهای موجود ({len(cs)}):\n")
        for i in range(0, len(cs), 6):
            print("  " + "".join(f"{c:<14}" for c in cs[i:i + 6]))
        print(f"\nمثال:  python3 {os.path.basename(__file__)} --countries DE,NL,FR,US -o sub.txt")
        return 0

    configs: list[str] = []

    # --- منابع ترکیبی ---
    if args.mixed or args.all:
        print("[*] واکشی منابع ترکیبی ...", file=sys.stderr)
        for repo, path in SOURCE_MIXED:
            txt = fetch(repo, path)
            if txt:
                got = extract_configs(txt)
                configs += got
                print(f"    + {repo}/{path}  ->  {len(got)}", file=sys.stderr)
            else:
                print(f"    ! {repo}/{path}  در دسترس نبود", file=sys.stderr)

    # --- منابع تفکیک‌شده بر اساس کشور ---
    wanted: list[str] = []
    if args.countries:
        wanted = [c.strip() for c in args.countries.split(",") if c.strip()]
    elif args.all:
        wanted = list_countries()
    elif not args.mixed:
        print("خطا: یکی از --list / --countries / --all / --mixed را بدهید.\n"
              "برای دیدن لیست کشورها:  --list", file=sys.stderr)
        return 2

    for c in wanted:
        txt = fetch(SOURCE_COUNTRY["repo"], f"{SOURCE_COUNTRY['path']}/{c}.txt")
        if txt:
            got = extract_configs(txt)
            configs += got
            print(f"    + {c:<24} ->  {len(got)}", file=sys.stderr)
        else:
            print(f"    ! {c:<24}  در دسترس نبود", file=sys.stderr)

    # --- حذف تکراری ---
    seen, uniq = set(), []
    for cfg in configs:
        key = cfg.split("#")[0]
        if key not in seen:
            seen.add(key)
            uniq.append(cfg)

    print(f"\n[*] کل کانفیگ یکتا: {len(uniq)}", file=sys.stderr)

    # --- تست اتصال ---
    if args.test and uniq:
        print(f"[*] تست TCP روی {len(uniq)} کانفیگ با {args.workers} رشته ...", file=sys.stderr)

        def probe(cfg: str):
            h, p = config_host_port(cfg)
            return cfg, tcp_ping(h, p)

        alive = []
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = [ex.submit(probe, c) for c in uniq]
            done = 0
            for f in as_completed(futs):
                try:
                    cfg, ms = f.result()
                except Exception:
                    continue
                done += 1
                if ms is not None:
                    alive.append((ms, cfg))
                if done % 100 == 0:
                    print(f"    ... {done}/{len(uniq)}  (سالم: {len(alive)})", file=sys.stderr)

        alive.sort(key=lambda x: x[0])
        uniq = [c for _, c in alive]
        print(f"[*] کانفیگ سالم: {len(uniq)}", file=sys.stderr)

    if not uniq:
        print("[!] هیچ کانفیگی به دست نیامد. اتصال اینترنت/آینه‌ها را بررسی کنید.", file=sys.stderr)
        return 1

    # --- اعمال محدودیت ---
    if args.limit > 0:
        uniq = uniq[: args.limit]

    # --- نوشتن خروجی ---
    header = (
        "# iran-access — subscription\n"
        f"# generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"# configs: {len(uniq)}\n"
        "# sources: Argh94/V2RayAutoConfig, MatinGhanbari/v2ray-configs, "
        "barry-far/V2ray-Config, Epodonios/v2ray-configs\n"
    )
    plain = header + "\n".join(uniq) + "\n"

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(plain)

    b64_out = os.path.splitext(args.out)[0] + "_base64.txt"
    with open(b64_out, "w", encoding="utf-8") as f:
        f.write(base64.b64encode(plain.encode("utf-8")).decode("ascii"))

    print(f"\n[+] ذخیره شد:")
    print(f"    متن ساده : {args.out}   ({len(uniq)} کانفیگ)")
    print(f"    base64   : {b64_out}")
    print(f"\n    در v2rayNG / Hiddify / NekoBox:  Subscription → افزودن از فایل")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[!] لغو شد.", file=sys.stderr)
        sys.exit(130)
