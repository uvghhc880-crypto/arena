#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen-links — تولید کانفیگ VLESS+REALITY برای هر کاربر در هر کشور

ورودی: یک فایل JSON با مشخصات سرور و کاربران
خروجی: لینک vless:// برای هر کاربر×کشور + فایل ساب‌اسکریپشن

استفاده:
    python3 gen-links.py --spec users.json --out ./out
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.parse
from pathlib import Path

# ---------------------------------------------------------------------------
# نمونه‌ی مشخصات — با مقادیر واقعی خودتان عوض کنید
# ---------------------------------------------------------------------------

SPEC_TEMPLATE = {
    "server": {
        "address": "IRAN_SERVER_IP_OR_DOMAIN",
        "port": 443,
        "sni": "www.samsung.com",
        "public_key": "IRAN_REALITY_PUBLIC_KEY",
        "short_id": "a1b2c3d4e5f60718",
        "fingerprint": "chrome",
        "flow": "xtls-rprx-vision",
        "spider_x": "/",
        "security": "reality",
        "type": "tcp"
    },
    "country_names": {
        "de": "🇩🇪 آلمان",
        "nl": "🇳🇱 هلند",
        "us": "🇺🇸 آمریکا",
        "fr": "🇫🇷 فرانسه",
        "gb": "🇬🇧 بریتانیا",
        "tr": "🇹🇷 ترکیه",
        "ae": "🇦🇪 امارات",
        "jp": "🇯🇵 ژاپن",
        "sg": "🇸🇬 سنگاپور",
        "in": "🇮🇳 هند",
        "ru": "🇷🇺 روسیه",
        "br": "🇧🇷 برزیل",
        "ca": "🇨🇦 کانادا",
        "se": "🇸🇪 سوئد",
        "ch": "🇨🇭 سوئیس",
        "at": "🇦🇹 اتریش",
        "fi": "🇫🇮 فنلاند",
        "pl": "🇵🇱 لهستان",
        "es": "🇪🇸 اسپانیا",
        "it": "🇮🇹 ایتالیا"
    },
    "users": [
        {
            "name": "ali",
            "countries": {
                "de": "11111111-1111-1111-1111-111111111111",
                "nl": "22222222-2222-2222-2222-222222222222",
                "us": "33333333-3333-3333-3333-333333333333"
            }
        }
    ]
}


# ---------------------------------------------------------------------------

def build_uri(spec: dict, uuid: str, cc: str, label: str) -> str:
    """یک لینک vless:// می‌سازد."""
    s = spec["server"]
    params = {
        "type": s["type"],
        "security": s["security"],
        "pbk": s["public_key"],
        "fp": s["fingerprint"],
        "sni": s["sni"],
        "sid": s["short_id"],
        "spx": s["spider_x"],          # urlencode خودش انکود می‌کند
        "flow": s["flow"],
        "encryption": "none",
    }
    # safe="/" تا اسلش‌های مسیر سالم بمانند؛ بقیه انکود می‌شوند
    q = urllib.parse.urlencode(params, safe="/", quote_via=urllib.parse.quote)
    tag = urllib.parse.quote(f"{label} | {cc.upper()}", safe="")
    return f"vless://{uuid}@{s['address']}:{s['port']}?{q}#{tag}"


def main() -> int:
    ap = argparse.ArgumentParser(description="تولید کانفیگ چندکشوری برای کاربران")
    ap.add_argument("--spec", "-s", help="فایل JSON مشخصات (اگر ندهید، نمونه نوشته می‌شود)")
    ap.add_argument("--out", "-o", default="./out", help="پوشه‌ی خروجی")
    ap.add_argument("--template", action="store_true", help="فقط نوشتن فایل نمونه")
    args = ap.parse_args()

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    if args.template or not args.spec:
        tpl = outdir / "users.template.json"
        tpl.write_text(json.dumps(SPEC_TEMPLATE, indent=2, ensure_ascii=False))
        print(f"[+] نمونه نوشته شد: {tpl}")
        print("    آن را ویرایش کنید و بعد اجرا کنید:")
        print(f"    python3 {Path(__file__).name} --spec {tpl}")
        return 0

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    if "server" not in spec or "users" not in spec:
        print("[x] فایل مشخصات باید کلیدهای «server» و «users» داشته باشد", file=sys.stderr)
        return 1

    names = spec.get("country_names", {})
    all_lines: list[str] = []
    summary: list[tuple[str, int]] = []

    for user in spec["users"]:
        uname = user["name"]
        countries = user.get("countries", {})
        if not countries:
            print(f"[!] {uname}: هیچ کشوری تعریف نشده", file=sys.stderr)
            continue

        links = []
        for cc, uuid in countries.items():
            label = names.get(cc.lower(), cc.upper())
            links.append(build_uri(spec, uuid, cc, f"{uname} · {label}"))

        # فایل مخصوص این کاربر
        ufile = outdir / f"{uname}.txt"
        ufile.write_text("\n".join(links) + "\n", encoding="utf-8")

        # ساب‌اسکریپشن base64 (استاندارد کلاینت‌ها)
        b64file = outdir / f"{uname}_base64.txt"
        b64file.write_text(
            base64.b64encode(("\n".join(links) + "\n").encode()).decode(),
            encoding="utf-8",
        )

        # فایل «همه» — همه‌ی کاربران همه‌ی کشورها
        for ln in links:
            name = ln.split("#", 1)[1]
            all_lines.append(ln)

        summary.append((uname, len(links)))

    if all_lines:
        (outdir / "ALL.txt").write_text("\n".join(all_lines) + "\n", encoding="utf-8")
        (outdir / "ALL_base64.txt").write_text(
            base64.b64encode(("\n".join(all_lines) + "\n").encode()).decode(),
            encoding="utf-8")

    print("\n[+] ساخته شد:")
    for uname, n in summary:
        print(f"    {uname:<16} {n} کانفیگ   →  {outdir}/{uname}.txt  +  {uname}_base64.txt")
    if all_lines:
        print(f"    {'ALL':<16} {len(all_lines)} کانفیگ   →  {outdir}/ALL_base64.txt")
    print("\n    نکته: برای هر کاربر لینک base64 را بدهید — در v2rayNG/Hiddify")
    print("          با «Add subscription from clipboard» مستقیم اضافه می‌شود.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
