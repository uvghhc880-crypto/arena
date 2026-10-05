#!/usr/bin/env bash
# ==============================================================
#  نصب‌کننده‌ی خودکار جعبه‌ابزار
#  استفاده:  bash install.sh
# ==============================================================
set -euo pipefail

C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
ok(){ echo "${C_OK}[+]${C_OFF} $*"; }
err(){ echo "${C_ERR}[x]${C_OFF} $*"; }
warn(){ echo "${C_WARN}[!]${C_OFF} $*"; }
dim(){ echo "${C_DIM}    $*${C_OFF}"; }

DEST="${DEST:-$HOME/.local/share/censorship-toolkit}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo
echo "════════════════════════════════════════════════════════"
echo "   نصب جعبه‌ابزار دسترسی آزاد"
echo "════════════════════════════════════════════════════════"
echo

# --- ۱. بررسی پیش‌نیازها ---
echo "── بررسی پیش‌نیازها ──"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  err "Python 3 پیدا نشد"
  dim "نصب:  sudo apt install -y python3"
  exit 1
fi
PV=$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')
if "$PY" -c 'import sys;sys.exit(0 if sys.version_info>=(3,7) else 1)'; then
  ok "Python $PV"
else
  err "Python $PV خیلی قدیمی است (حداقل ۳.۷ لازم است)"
  exit 1
fi

# ابزارهای اختیاری
have_wg=0; have_ip=0; have_curl=0; have_gh=0
command -v wg    >/dev/null 2>&1 && have_wg=1
command -v ip    >/dev/null 2>&1 && have_ip=1
command -v curl  >/dev/null 2>&1 && have_curl=1
command -v gh    >/dev/null 2>&1 && have_gh=1
[ "$have_wg"   = 1 ] && ok "wireguard-tools"   || warn "wireguard-tools نیست (برای wg-multipath لازم است)"
[ "$have_ip"   = 1 ] && ok "iproute2"          || warn "iproute2 نیست (برای wg-multipath لازم است)"
[ "$have_curl" = 1 ] && ok "curl"              || warn "curl نیست (برای warp-scan لازم است)"
[ "$have_gh"   = 1 ] && ok "gh (github cli)"   || dim "gh نیست — iran-access به آینه‌ها برمی‌گردد (اشکالی ندارد)"
if [ "$have_wg" = 0 ] || [ "$have_ip" = 0 ] || [ "$have_curl" = 0 ]; then
  dim "نصب موارد لازم:  sudo apt install -y wireguard-tools iproute2 curl"
fi

# --- ۲. کپی فایل‌ها ---
echo
echo "── نصب فایل‌ها ──"
mkdir -p "$DEST"
rm -rf "$DEST"/* 2>/dev/null || true
cp -r "$SRC"/iran-access "$SRC"/iran-tunnel "$SRC"/warp "$DEST"/ 2>/dev/null || true
chmod +x "$DEST"/*/*.py 2>/dev/null || true
find "$DEST" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
ok "نصب شد در: $DEST"

# --- ۳. ساخت دستورهای میان‌بر ---
echo
echo "── ساخت دستورهای میان‌بر ──"
BINDIR="${BINDIR:-$HOME/.local/bin}"
mkdir -p "$BINDIR"

write_wrapper(){
  cat > "$BINDIR/$1" <<WEOF
#!/usr/bin/env bash
exec "$PY" "$DEST/$2" "\$@"
WEOF
  chmod +x "$BINDIR/$1"
}

write_wrapper free-config  "iran-access/iran-access.py"
write_wrapper wg-multipath "iran-tunnel/wg-multipath.py"
write_wrapper gen-links    "iran-tunnel/gen-links.py"
write_wrapper gen-clash    "iran-tunnel/gen-clash.py"
write_wrapper warp-scan    "warp/warp-scan.py"
ok "۵ دستور ساخته شد: free-config, wg-multipath, gen-links, gen-clash, warp-scan"

# --- ۴. بررسی PATH ---
echo
echo "── بررسی PATH ──"
case ":$PATH:" in
  *":$BINDIR:"*) ok "$BINDIR در PATH هست" ;;
  *)
     warn "$BINDIR در PATH نیست — این خط را به ~/.bashrc اضافه کنید:"
     echo
     echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
     echo
     ;;
esac

# --- ۵. تست سریع ---
echo
echo "── تست سریع ──"
if "$PY" "$DEST/iran-access/iran-access.py" --help >/dev/null 2>&1; then
  ok "iran-access کار می‌کند"
else
  err "iran-access خطا داد"
fi
if "$PY" "$DEST/warp/warp-scan.py" --help >/dev/null 2>&1; then
  ok "warp-scan کار می‌کند"
else
  err "warp-scan خطا داد"
fi
if "$PY" -c "import ast,sys
for f in ['iran-tunnel/wg-multipath.py','iran-tunnel/gen-links.py','iran-tunnel/gen-clash.py']:
    ast.parse(open('$DEST/'+f,encoding='utf-8').read())
" 2>/dev/null; then
  ok "اسکریپت‌های iran-tunnel سالم‌اند"
else
  err "یک اسکریپت iran-tunnel خطا دارد"
fi

echo
echo "════════════════════════════════════════════════════════"
ok "نصب کامل شد!"
echo "════════════════════════════════════════════════════════"
echo
echo "  برای شروع، این را بخوانید:"
echo "    ${C_OK}cat $DEST/README-START.md${C_OFF}"
echo
echo "  یا مستقیم امتحان کنید:"
echo "    ${C_OK}free-config --list${C_OFF}                     لیست ۸۸ کشور"
echo "    ${C_OK}free-config -c DE,NL --test -n 20${C_OFF}     ۲۰ کانفیگ سریع"
echo
