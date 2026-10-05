#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen-clash - تبدیل مشخصات کاربران به کانفیگ Clash Meta / Mihomo

چرا Clash؟ چون گروه‌بندی و انتخاب خودکار سریع‌ترین سرور را می‌دهد -
همان تجربه‌ای که اپ‌هایی مثل Octohide دارند: لیست کشور + اتصال یک‌کلیکی.

استفاده:
    python3 gen-clash.py --spec users.json --out ./out
    python3 gen-clash.py --spec users.json --out ./out --user ali
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

COUNTRIES = {
    "de": ("\U0001F1E9\U0001F1EA", "آلمان"),
    "nl": ("\U0001F1F3\U0001F1F1", "هلند"),
    "us": ("\U0001F1FA\U0001F1F8", "آمریکا"),
    "fr": ("\U0001F1EB\U0001F1F7", "فرانسه"),
    "gb": ("\U0001F1EC\U0001F1E7", "بریتانیا"),
    "tr": ("\U0001F1F9\U0001F1F7", "ترکیه"),
    "ae": ("\U0001F1E6\U0001F1EA", "امارات"),
    "jp": ("\U0001F1EF\U0001F1F5", "ژاپن"),
    "sg": ("\U0001F1F8\U0001F1EC", "سنگاپور"),
    "in": ("\U0001F1EE\U0001F1F3", "هند"),
    "ru": ("\U0001F1F7\U0001F1FA", "روسیه"),
    "br": ("\U0001F1E7\U0001F1F7", "برزیل"),
    "ca": ("\U0001F1E8\U0001F1E6", "کانادا"),
    "se": ("\U0001F1F8\U0001F1EA", "سوئد"),
    "ch": ("\U0001F1E8\U0001F1ED", "سوئیس"),
    "at": ("\U0001F1E6\U0001F1F9", "اتریش"),
    "fi": ("\U0001F1EB\U0001F1EE", "فنلاند"),
    "pl": ("\U0001F1F5\U0001F1F1", "لهستان"),
    "es": ("\U0001F1EA\U0001F1F8", "اسپانیا"),
    "it": ("\U0001F1EE\U0001F1F9", "ایتالیا"),
    "kr": ("\U0001F1F0\U0001F1F7", "کره"),
    "hk": ("\U0001F1ED\U0001F1F0", "هنگ‌کنگ"),
    "tw": ("\U0001F1F9\U0001F1FC", "تایوان"),
    "my": ("\U0001F1F2\U0001F1FE", "مالزی"),
    "th": ("\U0001F1F9\U0001F1ED", "تایلند"),
    "vn": ("\U0001F1FB\U0001F1F3", "ویتنام"),
    "id": ("\U0001F1EE\U0001F1E9", "اندونزی"),
    "au": ("\U0001F1E6\U0001F1FA", "استرالیا"),
    "nz": ("\U0001F1F3\U0001F1FF", "نیوزیلند"),
    "za": ("\U0001F1FF\U0001F1E6", "آفریقای جنوبی"),
    "il": ("\U0001F1EE\U0001F1F1", "اسرائیل"),
    "sa": ("\U0001F1F8\U0001F1E6", "عربستان"),
    "qa": ("\U0001F1F6\U0001F1E6", "قطر"),
    "kw": ("\U0001F1F0\U0001F1FC", "کویت"),
    "om": ("\U0001F1F4\U0001F1F2", "عمان"),
    "bh": ("\U0001F1E7\U0001F1ED", "بحرین"),
    "jo": ("\U0001F1EF\U0001F1F4", "اردن"),
    "lb": ("\U0001F1F1\U0001F1E7", "لبنان"),
    "az": ("\U0001F1E6\U0001F1FF", "آذربایجان"),
    "am": ("\U0001F1E6\U0001F1F2", "ارمنستان"),
    "ge": ("\U0001F1EC\U0001F1EA", "گرجستان"),
    "kz": ("\U0001F1F0\U0001F1FF", "قزاقستان"),
    "ua": ("\U0001F1FA\U0001F1E6", "اوکراین"),
    "cz": ("\U0001F1E8\U0001F1FF", "چک"),
    "ro": ("\U0001F1F7\U0001F1F4", "رومانی"),
    "hu": ("\U0001F1ED\U0001F1FA", "مجارستان"),
    "bg": ("\U0001F1E7\U0001F1EC", "بلغارستان"),
    "gr": ("\U0001F1EC\U0001F1F7", "یونان"),
    "pt": ("\U0001F1F5\U0001F1F9", "پرتغال"),
    "ie": ("\U0001F1EE\U0001F1EA", "ایرلند"),
    "no": ("\U0001F1F3\U0001F1F4", "نروژ"),
    "dk": ("\U0001F1E9\U0001F1F0", "دانمارک"),
    "be": ("\U0001F1E7\U0001F1EA", "بلژیک"),
    "lu": ("\U0001F1F1\U0001F1FA", "لوکزامبورگ"),
    "md": ("\U0001F1F2\U0001F1E9", "مولداوی"),
    "rs": ("\U0001F1F7\U0001F1F8", "صربستان"),
    "hr": ("\U0001F1ED\U0001F1F7", "کرواسی"),
    "sk": ("\U0001F1F8\U0001F1F0", "اسلواکی"),
    "si": ("\U0001F1F8\U0001F1EE", "اسلوونی"),
    "lt": ("\U0001F1F1\U0001F1F9", "لیتوانی"),
    "lv": ("\U0001F1F1\U0001F1FB", "لتونی"),
    "ee": ("\U0001F1EA\U0001F1EA", "استونی"),
    "mx": ("\U0001F1F2\U0001F1FD", "مکزیک"),
    "ar": ("\U0001F1E6\U0001F1F7", "آرژانتین"),
    "cl": ("\U0001F1E8\U0001F1F1", "شیلی"),
    "co": ("\U0001F1E8\U0001F1F4", "کلمبیا"),
    "pe": ("\U0001F1F5\U0001F1EA", "پرو"),
}


def cc_label(cc: str) -> str:
    flag, name = COUNTRIES.get(cc.lower(), ("\U0001F310", cc.upper()))
    return f"{flag} {name}"


def build_proxy(spec: dict, uuid: str, cc: str, uname: str) -> dict:
    s = spec["server"]
    return {
        "name": f"{cc_label(cc)} | {uname}",
        "type": "vless",
        "server": s["address"],
        "port": int(s["port"]),
        "uuid": uuid,
        "network": s.get("type", "tcp"),
        "tls": True,
        "udp": True,
        "flow": s.get("flow", "xtls-rprx-vision"),
        "servername": s["sni"],
        "client-fingerprint": s.get("fingerprint", "chrome"),
        "reality-opts": {
            "public-key": s["public_key"],
            "short-id": s.get("short_id", ""),
        },
    }


HEADER = """# ==============================================================
#  config.yaml -- Clash Meta / Mihomo
#  ساخته‌شده با gen-clash.py
#
#  کلاینت‌های سازگار:
#    Android : FlClash, ClashMetaForAndroid (CMFA), Hiddify
#    Windows : Clash Verge Rev, FlClash, Mihomo Party
#    macOS   : Clash Verge Rev, Mihomo Party
#    iOS     : Shadowrocket, Stash, Karing
#    Router  : OpenWrt (mihomo), Keenetic
# ==============================================================

mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
find-process-mode: strict
unified-delay: true
tcp-concurrent: true

profile:
  store-selected: true
  store-fake-ip: true

sniffer:
  enable: true
  sniff:
    HTTP:
      ports: [80, 8080-8880]
    TLS:
      ports: [443, 8443]
    QUIC:
      ports: [443, 8443]
  skip-domain:
    - "Mijia Cloud"
    - "dlg.io.mi.com"

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - "*.lan"
    - "*.local"
    - "localhost.ptlogin2.qq.com"
  default-nameserver:
    - 223.5.5.5
    - 1.1.1.1
  nameserver:
    - https://dns.cloudflare.com/dns-query
    - https://dns.google/dns-query
  fallback:
    - https://1.1.1.1/dns-query
    - https://8.8.8.8/dns-query
"""


def build_yaml(spec: dict, user: dict) -> str:
    uname = user["name"]
    countries = user.get("countries", {})
    proxies = [build_proxy(spec, uuid, cc, uname) for cc, uuid in countries.items()]

    lines = [HEADER, "\nproxies:"]
    for p in proxies:
        lines.append(f'  - name: "{p["name"]}"')
        lines.append(f'    type: {p["type"]}')
        lines.append(f'    server: {p["server"]}')
        lines.append(f'    port: {p["port"]}')
        lines.append(f'    uuid: {p["uuid"]}')
        lines.append(f'    network: {p["network"]}')
        lines.append(f'    tls: {"true" if p["tls"] else "false"}')
        lines.append(f'    udp: {"true" if p["udp"] else "false"}')
        lines.append(f'    flow: {p["flow"]}')
        lines.append(f'    servername: {p["servername"]}')
        lines.append(f'    client-fingerprint: {p["client-fingerprint"]}')
        lines.append(f'    reality-opts:')
        lines.append(f'      public-key: {p["reality-opts"]["public-key"]}')
        lines.append(f'      short-id: "{p["reality-opts"]["short-id"]}"')
        lines.append("")

    names = [p["name"] for p in proxies]

    def seq(items, indent=6):
        pad = " " * indent
        return "\n".join(f'{pad}- "{i}"' if i not in ("DIRECT", "REJECT") else f"{pad}- {i}" for i in items)

    lines.append("proxy-groups:")
    lines.append('  - name: "تست خودکار (سریع‌ترین)"')
    lines.append("    type: url-test")
    lines.append("    url: http://www.gstatic.com/generate_204")
    lines.append("    interval: 120")
    lines.append("    tolerance: 50")
    lines.append("    proxies:")
    lines.append(seq(names))
    lines.append("")
    lines.append('  - name: "انتخاب کشور"')
    lines.append("    type: select")
    lines.append("    proxies:")
    lines.append(seq(['تست خودکار (سریع‌ترین)'] + names))
    lines.append("")
    lines.append('  - name: "پروکسی"')
    lines.append("    type: select")
    lines.append("    proxies:")
    lines.append(seq(['انتخاب کشور', 'تست خودکار (سریع‌ترین)', 'DIRECT']))
    lines.append("")
    lines.append('  - name: "تبلیغات"')
    lines.append("    type: select")
    lines.append("    proxies:")
    lines.append(seq(['REJECT']))
    lines.append("")

    lines.append("rules:")
    lines.append("  - GEOIP,PRIVATE,DIRECT,no-resolve")
    lines.append("  - GEOIP,IR,DIRECT")
    lines.append("  - DOMAIN-SUFFIX,.ir,DIRECT")
    lines.append("  - DOMAIN-KEYWORD,irancell,DIRECT")
    lines.append("  - GEOSITE,category-ads-all,تبلیغات")
    lines.append("  - MATCH,پروکسی")
    lines.append("")

    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="تولید کانفیگ Clash Meta برای کاربران")
    ap.add_argument("--spec", "-s", required=True)
    ap.add_argument("--out", "-o", default="./out")
    ap.add_argument("--user", "-u", help="فقط یک کاربر")
    args = ap.parse_args()

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    if "server" not in spec or "users" not in spec:
        print("[x] فایل مشخصات باید 'server' و 'users' داشته باشد", file=sys.stderr)
        return 1

    users = spec["users"]
    if args.user:
        users = [u for u in users if u["name"] == args.user]
        if not users:
            print(f"[x] کاربر '{args.user}' پیدا نشد", file=sys.stderr)
            return 1

    made = []
    for u in users:
        if not u.get("countries"):
            print(f"[!] {u['name']}: کشوری تعریف نشده", file=sys.stderr)
            continue
        y = build_yaml(spec, u)
        f = outdir / f"{u['name']}-clash.yaml"
        f.write_text(y, encoding="utf-8")
        made.append((u["name"], len(u["countries"]), f))

    print("\n[+] کانفیگ Clash ساخته شد:")
    for name, n, f in made:
        print(f"    {name:<14} {n} کشور   ->  {f}")
    if made:
        print("\n    در کلاینت:  Profiles -> New -> Import from file -> انتخاب فایل yaml")
        print("    بعد از اتصال، در تب Proxies گروه «انتخاب کشور» را ببینید.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
