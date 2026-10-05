#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wg-multipath — راه‌اندازی چند تونل WireGuard موازی روی یک سرور خروجی

هر کانفیگ WireGuard (هر کشور) روی یک اینترفیس جدا بالا می‌آید و یک
routing table + fwmark مخصوص خودش می‌گیرد. Xray سپس با sockopt.mark
ترافیک هر کاربر را به اینترفیس کشور مورد نظرش می‌فرستد.

    کاربر → سرور ایران (REALITY) ──تانل──> سرور خارج
                                             ├── mark 1000 → wg0 → 🇩🇪 آلمان
                                             ├── mark 1001 → wg1 → 🇳🇱 هلند
                                             └── mark 1002 → wg2 → 🇺🇸 آمریکا

استفاده:
    sudo python3 wg-multipath.py up      --dir /etc/wireguard/countries
    sudo python3 wg-multipath.py status  --dir /etc/wireguard/countries
    sudo python3 wg-multipath.py down    --dir /etc/wireguard/countries
    sudo python3 wg-multipath.py render  --dir /etc/wireguard/countries --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# تنظیمات پایه
# ---------------------------------------------------------------------------

MARK_BASE = 1000          # اولین fwmark / شماره جدول
IFACE_PREFIX = "wg"
MTU = 1420                # MTU مناسب WireGuard (۱۵۰۰ منهای سربار)
MAP_FILENAME = "country-map.json"

C_OK, C_WARN, C_ERR, C_OFF = "\033[32m", "\033[33m", "\033[31m", "\033[0m"


def log(msg: str, kind: str = "info") -> None:
    color = {"info": "", "ok": C_OK, "warn": C_WARN, "err": C_ERR}.get(kind, "")
    prefix = {"info": "[*]", "ok": "[+]", "warn": "[!]", "err": "[x]"}.get(kind, "[*]")
    print(f"{color}{prefix} {msg}{C_OFF if color else ''}", file=sys.stderr)


def run(cmd: List[str], check: bool = True, dry: bool = False) -> subprocess.CompletedProcess:
    if dry:
        print("  DRY-RUN: " + " ".join(cmd), file=sys.stderr)
        return subprocess.CompletedProcess(cmd, 0, "", "")
    return subprocess.run(cmd, capture_output=True, text=True, check=False) if not check else \
           subprocess.run(cmd, capture_output=True, text=True)


# ---------------------------------------------------------------------------
# پارس کانفیگ WireGuard
# ---------------------------------------------------------------------------

class WgConfigError(Exception):
    pass


def parse_wg_conf(path: Path) -> Dict[str, object]:
    """کانفیگ استاندارد wg-quick را می‌خواند. [Interface] + [Peer]."""
    if not path.exists():
        raise WgConfigError(f"فایل وجود ندارد: {path}")

    section: Optional[str] = None
    iface: Dict[str, str] = {}
    peer: Dict[str, str] = {}

    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^\[(.+)\]$", line)
        if m:
            section = m.group(1).strip().lower()
            continue
        if "=" not in line or section is None:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip()
        if section == "interface":
            iface[k] = v
        elif section == "peer":
            if k not in peer:          # اولین peer کافی است
                peer[k] = v

    missing = [k for k in ("PrivateKey", "Address") if k not in iface]
    if missing:
        raise WgConfigError(f"{path.name}: فیلد(های) گم‌شده در [Interface]: {', '.join(missing)}")
    if "PublicKey" not in peer:
        raise WgConfigError(f"{path.name}: PublicKey در [Peer] پیدا نشد")
    if "Endpoint" not in peer:
        raise WgConfigError(f"{path.name}: Endpoint در [Peer] پیدا نشد")

    endpoint = peer["Endpoint"]
    host, _, port = endpoint.rpartition(":")
    if not host or not port.isdigit():
        raise WgConfigError(f"{path.name}: Endpoint نامعتبر: {endpoint}")

    return {
        "name": path.stem,
        "private_key": iface["PrivateKey"],
        "address": iface["Address"],
        "public_key": peer["PublicKey"],
        "endpoint_host": host,
        "endpoint_port": int(port),
        "psk": peer.get("PresharedKey"),
        "keepalive": peer.get("PersistentKeepalive", "25"),
        "source_file": str(path),
    }


def discover(dirpath: Path) -> List[Dict[str, object]]:
    """همه‌ی .conf ها را پیدا و پارس می‌کند."""
    if not dirpath.is_dir():
        raise WgConfigError(f"پوشه وجود ندارد: {dirpath}")
    confs = sorted(p for p in dirpath.glob("*.conf"))
    if not confs:
        raise WgConfigError(f"هیچ فایل .conf در {dirpath} پیدا نشد")
    out = []
    for p in confs:
        try:
            out.append(parse_wg_conf(p))
        except WgConfigError as e:
            log(str(e), "warn")
    return out


# ---------------------------------------------------------------------------
# ساخت کانفیگ نهایی wg-quick
# ---------------------------------------------------------------------------

def render_wgquick(cfg: Dict[str, object]) -> str:
    """کانفیگ wg-quick با Table=off — مسیرها را خودمان مدیریت می‌کنیم."""
    lines = [
        "[Interface]",
        f"PrivateKey = {cfg['private_key']}",
        f"Address = {cfg['address']}",
        "Table = off",          # ما خودمان route/rule می‌سازیم
        f"MTU = {MTU}",
        "SaveConfig = false",
        "",
        "[Peer]",
        f"PublicKey = {cfg['public_key']}",
    ]
    if cfg.get("psk"):
        lines.append(f"PresharedKey = {cfg['psk']}")
    lines += [
        "AllowedIPs = 0.0.0.0/0, ::/0",
        f"Endpoint = {cfg['endpoint_host']}:{cfg['endpoint_port']}",
        f"PersistentKeepalive = {cfg['keepalive']}",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# عملیات شبکه
# ---------------------------------------------------------------------------

def default_route() -> tuple[Optional[str], Optional[str]]:
    """(gateway, device) مسیر پیش‌فرض فعلی."""
    r = subprocess.run(["ip", "-4", "route", "show", "default"],
                       capture_output=True, text=True)
    for line in r.stdout.splitlines():
        parts = line.split()
        if "via" in parts and "dev" in parts:
            return parts[parts.index("via") + 1], parts[parts.index("dev") + 1]
    return None, None


def iface_exists(name: str) -> bool:
    return subprocess.run(["ip", "link", "show", name],
                          capture_output=True).returncode == 0


def bring_up(cfg: Dict[str, object], idx: int, dry: bool) -> Dict[str, object]:
    """یک کشور را بالا می‌آورد: اینترفیس + جدول + قاعده‌ی fwmark."""
    name = str(cfg["name"])
    iface = f"{IFACE_PREFIX}{idx}"
    table = MARK_BASE + idx
    mark = MARK_BASE + idx

    if dry:
        print(f"--- {name}  →  {iface}  (table={table}, mark={mark}) ---", file=sys.stderr)
        print(render_wgquick(cfg), file=sys.stderr)
        print(f"ip route replace default dev {iface} table {table}", file=sys.stderr)
        print(f"ip rule add fwmark {mark} lookup {table} priority {table}", file=sys.stderr)
        print(file=sys.stderr)
    else:
        wgq = Path(f"/etc/wireguard/{iface}.conf")
        wgq.parent.mkdir(parents=True, exist_ok=True)
        wgq.write_text(render_wgquick(cfg))
        os.chmod(wgq, 0o600)

        if iface_exists(iface):
            subprocess.run(["wg-quick", "down", str(wgq)], capture_output=True)

        r = subprocess.run(["wg-quick", "up", str(wgq)], capture_output=True, text=True)
        if r.returncode != 0:
            raise WgConfigError(f"{name}: wg-quick up شکست خورد → {r.stderr.strip()[:300]}")

        # مسیر پیش‌فرض این کشور فقط در جدول اختصاصی خودش
        subprocess.run(["ip", "-4", "route", "replace", "default",
                        "dev", iface, "table", str(table)], check=True)
        # قاعده‌ی هدایت ترافیک علامت‌خورده به آن جدول
        subprocess.run(["ip", "-4", "rule", "del", "fwmark", str(mark),
                        "lookup", str(table)], capture_output=True)   # پاک‌سازی قبلی
        subprocess.run(["ip", "-4", "rule", "add", "fwmark", str(mark),
                        "lookup", str(table), "priority", str(table)], check=True)

    return {
        "country": name,
        "interface": iface,
        "table": table,
        "mark": mark,
        "endpoint": f"{cfg['endpoint_host']}:{cfg['endpoint_port']}",
        "wg_conf": str(cfg["source_file"]),
    }


def tear_down(entry: Dict[str, object], dry: bool) -> None:
    iface, table, mark = entry["interface"], entry["table"], entry["mark"]
    if dry:
        print(f"  DRY-RUN: down {iface}", file=sys.stderr)
        return
    subprocess.run(["ip", "-4", "rule", "del", "fwmark", str(mark),
                    "lookup", str(table)], capture_output=True)
    subprocess.run(["ip", "-4", "route", "flush", "table", str(table)], capture_output=True)
    if iface_exists(str(iface)):
        subprocess.run(["wg-quick", "down", f"/etc/wireguard/{iface}.conf"],
                       capture_output=True)
    Path(f"/etc/wireguard/{iface}.conf").unlink(missing_ok=True)


def show_status(entries: List[Dict[str, object]]) -> None:
    """وضعیت هر تونل: دست‌دادن، ترافیک، آخرین handshake."""
    print(f"\n{'کشور':<20} {'اینترفیس':<10} {'mark':<7} {'وضعیت':<12} {'آخرین handshake'}")
    print("-" * 82)
    for e in entries:
        iface, mark = e["interface"], e["mark"]
        ok = subprocess.run(["wg", "show", iface], capture_output=True, text=True)
        if ok.returncode != 0:
            print(f"{str(e['country']):<20} {iface:<10} {mark:<7} {C_ERR}پایین{C_OFF}")
            continue
        hs = re.search(r"latest handshake:\s*(.+)", ok.stdout)
        rx = re.search(r"transfer:\s*([\d.]+\s*\w+)\s+received", ok.stdout)
        state = f"{C_OK}فعال{C_OFF}"
        handshake = hs.group(1).strip() if hs else f"{C_WARN}بی‌تماس{C_OFF}"
        extra = f"  ↓{rx.group(1)}" if rx else ""
        print(f"{str(e['country']):<20} {iface:<10} {mark:<7} {state:<21} {handshake}{extra}")
    print()


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="چند تونل WireGuard موازی برای خروجی چندکشوری",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="مثال:\n"
               "  sudo python3 wg-multipath.py up --dir /etc/wireguard/countries\n"
               "  sudo python3 wg-multipath.py status --dir /etc/wireguard/countries\n",
    )
    ap.add_argument("action", choices=["up", "down", "status", "render"])
    ap.add_argument("--dir", "-d", default="/etc/wireguard/countries",
                    help="پوشه‌ی فایل‌های <country>.conf")
    ap.add_argument("--map", default=None, help=f"مسیر فایل نقشه (پیش‌فرض: <dir>/{MAP_FILENAME})")
    ap.add_argument("--dry-run", action="store_true", help="فقط نمایش، بدون تغییر سیستم")
    args = ap.parse_args()

    if not args.dry_run and os.geteuid() != 0 and args.action in ("up", "down"):
        log("برای up/down باید با root (sudo) اجرا شود", "err")
        return 1

    # render و --dry-run هیچ تغییری روی سیستم نمی‌دهند، پس ابزار لازم ندارند
    preview_only = args.dry_run or args.action in ("render", "status")
    if not preview_only:
        for tool in ("wg", "wg-quick", "ip"):
            if not shutil.which(tool):
                log(f"ابزار لازم نصب نیست: {tool}   →   apt install wireguard-tools iproute2", "err")
                return 1

    dirp = Path(args.dir)
    map_path = Path(args.map) if args.map else dirp / MAP_FILENAME

    # --- status: از نقشه‌ی ذخیره‌شده بخوان ---
    if args.action == "status":
        if not map_path.exists():
            log(f"نقشه پیدا نشد: {map_path} — اول «up» را اجرا کنید", "err")
            return 1
        entries = json.loads(map_path.read_text())
        show_status(entries)
        return 0

    # --- down ---
    if args.action == "down":
        if not map_path.exists():
            log("نقشه‌ای برای پایین‌آوردن وجود ندارد", "warn")
            return 0
        entries = json.loads(map_path.read_text())
        for e in entries:
            log(f"پایین‌آوردن {e['country']} ({e['interface']}) ...")
            tear_down(e, args.dry_run)
        if not args.dry_run:
            map_path.unlink(missing_ok=True)
            log("همه‌ی تونل‌ها پایین آمدند", "ok")
        return 0

    # --- up / render ---
    try:
        cfgs = discover(dirp)
    except WgConfigError as e:
        log(str(e), "err")
        return 1

    if not cfgs:
        log("هیچ کانفیگ سالمی پیدا نشد", "err")
        return 1

    log(f"{len(cfgs)} کانفیگ پیدا شد: {', '.join(str(c['name']) for c in cfgs)}")

    if not args.dry_run:
        gw, dev = default_route()
        if not gw or not dev:
            log("مسیر پیش‌فرض اینترنت پیدا نشد", "err")
            return 1
        log(f"مسیر پیش‌فرض سیستم: via {gw} dev {dev}")

    if args.action == "render":
        for i, c in enumerate(cfgs):
            bring_up(c, i, dry=True)
        return 0

    entries: List[Dict[str, object]] = []
    for i, c in enumerate(cfgs):
        try:
            entries.append(bring_up(c, i, args.dry_run))
            if not args.dry_run:
                log(f"{c['name']} → {entries[-1]['interface']} "
                    f"(mark {entries[-1]['mark']})", "ok")
        except Exception as e:
            log(f"{c['name']}: {e}", "err")

    if not args.dry_run and entries:
        map_path.parent.mkdir(parents=True, exist_ok=True)
        map_path.write_text(json.dumps(entries, indent=2, ensure_ascii=False))
        log(f"نقشه ذخیره شد: {map_path}", "ok")

    if not args.dry_run:
        show_status(entries)
        print("  برای Xray در هر outbound از این مقادیر استفاده کنید:", file=sys.stderr)
        for e in entries:
            print(f'    {str(e["country"]):<14} → "sockopt": {{ "mark": {e["mark"]} }}', file=sys.stderr)
        print(file=sys.stderr)

    return 0 if len(entries) == len(cfgs) else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        sys.exit(130)
