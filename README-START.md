# 🚀 از صفر تا کار کردن — راهنمای شروع سریع

سلام! این جعبه‌ابزار سه بخش دارد. **هر بخش مستقل است** — لازم نیست همه را راه بیندازید.

---

## اول: کدام بخش را لازم دارید؟

| می‌خواهید… | بروید به | زمان لازم |
|---|---|---|
| **همین امروز اینترنت آزاد داشته باشم** | [بخش ۱](#بخش-۱--کانفیگ-رایگان-فوری) | ۵ دقیقه |
| **سرور آلمانی‌ام با WARP لوکیشن عوض کند** | [بخش ۲](#بخش-۲--لویشن-warp) | ۱۵ دقیقه |
| **تانل ایران → خارج با چند کشور بسازم** | [بخش ۳](#بخش-۳--تانل-چندکشوری) | ۱ ساعت |

---

## بخش ۱ — کانفیگ رایگان فوری

این بخش **همین الان** کار می‌کند. به هیچ سرور یا تنظیمی لازم ندارد.

```bash
# ۱) نصب
bash install.sh

# ۲) ببین چه کشورهایی هست
free-config --list
```

خروجی: لیست ۸۸ کشور (آلمان، هلند، آمریکا، فرانسه، انگلیس، ترکیه، ژاپن، …)

```bash
# ۳) کانفیگ بگیر — با تست سرعت
free-config -c DE,NL,US,FR,GB --test -n 30 -o sub.txt
```

خروجی:
```
    + Germany                  ->  1016
    + Netherlands              ->   584
    + USA                      ->   2400
    + France                   ->   428
    + United Kingdom           ->   312

[*] کل کانفیگ یکتا: 4740
[*] کانفیگ سالم: 892

[+] ذخیره شد:
    متن ساده : sub.txt   (30 کانفیگ)
    base64   : sub_base64.txt
```

عبارت `[!] در دسترس نبود` اگر دیدید، یعنی اینترنت آن آینه را بسته — مشکل از ابزار نیست.

### وارد کردن در گوشی

**ساده‌ترین راه:**
1. فایل `sub_base64.txt` را به گوشی بفرستید (تلگرام به خودتان، یا USB)
2. آن را باز کنید، کل متن را کپی کنید
3. در **Hiddify** یا **v2rayNG**: `+` → `Add from clipboard`
4. وصل شوید

**نصب اپ:** `app.hiddify.com` (از Play Store هم هست) — امن‌ترین گزینه

> ⚠️ **فقط از منابع رسمی نصب کنید.** APK هایی که در گروه‌های تلگرام دست‌به‌دست می‌شوند، یکی از رایج‌ترین راه‌های آلودگی گوشی در ایران هستند.

### ⚠️ هشدار امنیتی

کانفیگ رایگان از **آدم ناشناس** یعنی آن اپراتور متادیتای ترافیک شما را می‌بیند.

| استفاده | کدام ابزار |
|---|---|
| 🔴 بانک، ایمیل، هویت | **Psiphon / Lantern / nthLink / Tor** — نه این کانفیگ‌ها |
| 🟢 گشت‌وگذار عادی، یوتیوب، اینستاگرام | این کانفیگ‌ها |

جزئیات بیشتر و ابزارهای امن: `iran-access/README.md`

---

## بخش ۲ — لوکیشن WARP

اگر WARP روی سرورتان هست ولی لوکیشن عوض نمی‌شود و سرعت افت کرده:

```bash
# ۱) اول ببین مشکل کجاست
sudo warp-scan --iface wgcf --check
```

خروجی نمونه:
```
[+] اینترفیس wgcf موجود است
    endpoint فعلی: 162.159.192.1:2408
[!] MTU = 1420  ← زیاد است، کندی می‌آورد
       پیشنهاد: MTU = 1280

--- trace بدون WARP (مستقیم) ---
    ip=5.6.7.8  colo=FRA  loc=DE

--- trace از داخل WARP ---
    ip=188.114.98.58  colo=FRA  loc=DE
    warp=on  gateway=off

[!] کشور خروجی با حالت مستقیم یکی است (DE)     ← 🎯 مشکل اینجاست
```

```bash
# ۲) اسکن کن، کشورهای دلخواهت
sudo warp-scan --iface wgcf --scan --want DE,NL,US,FR
```

```
  loc   colo   endpoint                      tcp
  DE    FRA    188.114.98.58:2408          12.4ms
  NL    AMS    188.114.99.10:2408          24.7ms
  US    IAD    162.159.193.5:1701          98.3ms
```

**نکته‌ی کلیدی:** `colo` گره است، `loc` کشور خروجی. **همیشه `loc` را ببین.**

```bash
# ۳) سرعت — این معمولاً ۸۰٪ مشکل است
sudo nano /etc/wireguard/wgcf.conf
# MTU = 1280        ← اضافه کنید
sudo wg-quick down wgcf && sudo wg-quick up wgcf
```

کاربران گزارش کرده‌اند با تنظیم MTU سرعت از **۴۰ Mbps به ۲۸۵ Mbps** رسیده.

راهنمای کامل: `warp/README.md`

---

## بخش ۳ — تانل چندکشوری

این بخش برای وقتی است که سرور ایران + سرور خارجی دارید.

```
کاربر → سرور ایران (REALITY) → سرور خارجی → ۷۰+ لوکیشن
```

### روی سرور خارجی

```bash
# ۱) کانفیگ‌های WireGuard را بگذارید
sudo mkdir -p /etc/wireguard/countries
sudo nano /etc/wireguard/countries/Germany.conf      # و هلند، آمریکا، ...
# (همان فایلی که سرویس‌دهنده به شما می‌دهد)

# ۲) همه را بالا بیاور
sudo wg-multipath up --dir /etc/wireguard/countries
```

خروجی:
```
[*] 3 کانفیگ پیدا شد: Germany, Netherlands, USA
[+] Germany    → wg0 (mark 1000)
[+] Netherlands → wg1 (mark 1001)
[+] USA        → wg2 (mark 1002)

کشور            اینترفیس  mark    وضعیت     آخرین handshake
Germany         wg0       1000    فعال      1 minute ago
Netherlands     wg1       1001    فعال      45 seconds ago
USA             wg2       1002    فعال      2 minutes ago
```

**هیچ‌وقت SSH شما قطع نمی‌شود** — مسیر پیش‌فرض سیستم دست‌نخورده می‌ماند.

⚠️ برای ۷۰-۸۰ لوکیشن لازم نیست ۸۰ سرور داشته باشید! هر سرور چند لوکیشن می‌دهد و `gen-clash.py` تا ۶۷+ لوکیشن از کلیدهای کشور پشتیبانی می‌کند.

### کانفیگ Xray

```bash
sudo cp iran-tunnel/configs/foreign-exit.json /usr/local/etc/xray/config.json
sudo nano /usr/local/etc/xray/config.json    # مقادیر REPLACE_WITH_... را پر کنید
sudo systemctl restart xray
```

### برای کاربران

```bash
# لینک برای v2rayNG / Hiddify
gen-links --spec users.json --out ./out

# کانفیگ Clash (با گروه انتخاب کشور — تجربه‌ی Octohide)
gen-clash --spec users.json --out ./out
```

خروجی Clash:
```yaml
proxy-groups:
  - name: "تست خودکار (سریع‌ترین)"    ← خودش سریع‌ترین کشور را انتخاب می‌کند
    type: url-test
  - name: "انتخاب کشور"
    proxies:
      - "🇩🇪 آلمان"
      - "🇳🇱 هلند"
      - "🇺🇸 آمریکا"
```

راهنمای کامل: `iran-tunnel/README.md`
انتخاب اپ برای کاربران: `iran-tunnel/CLIENTS.md`

---

## 🧪 تست اینکه همه‌چیز سالم است

```bash
# هر ۵ ابزار
free-config --help
gen-links --help
gen-clash --help
wg-multipath --help
warp-scan --help
```

اگر همهشان خروجی دادند، نصب درست است.

**تست کامل زنجیره:**
```bash
# ساخت کانفیگ نمونه و بررسی
mkdir -p /tmp/t && cd /tmp/t
gen-links --template --out .
# فایل users.template.json ساخته می‌شود، ویرایشش کنید
gen-links --spec users.template.json --out .
gen-clash --spec users.template.json --out .
ls -la
```

---

## 📁 ساختار

```
censorship-toolkit/
├── install.sh                    ← نصب خودکار
├── README-START.md               ← همین فایل
├── iran-access/                  ← کانفیگ‌های رایگان (۸۸ کشور)
│   ├── iran-access.py
│   └── README.md
├── iran-tunnel/                  ← تانل و چندکشوری
│   ├── wg-multipath.py           ← چند تونل WireGuard موازی
│   ├── gen-links.py              ← لینک vless:// برای کاربران
│   ├── gen-clash.py              ← کانفیگ Clash با گروه کشور
│   ├── configs/
│   │   ├── iran-relay.json       ← Xray سرور ایران
│   │   └── foreign-exit.json     ← Xray سرور خارجی
│   ├── README.md
│   └── CLIENTS.md
└── warp/                         ← عیب‌یابی WARP
    ├── warp-scan.py
    └── README.md
```

---

## 🆘 گیر کردی؟

| مشکل | راه‌حل |
|---|---|
| `command not found: free-config` | `export PATH="$HOME/.local/bin:$PATH"` را بزنید |
| `[!] در دسترس نبود` برای همه کشورها | اینترنت شما محدود است — اول Psiphon روشن کنید |
| `اینترفیس wgcf وجود ندارد` | `wgcf register && wgcf generate` بعد `wg-quick up wgcf` |
| `wg` پیدا نشد | `sudo apt install -y wireguard-tools iproute2` |
| اسکن WARP نتیجه نداد | اینترفیس را بالا کنید: `sudo wg-quick up wgcf` |
| سرعت WARP کم است | MTU را ۱۲۸۰ کنید (مهم‌ترین کار) |
| `Permission denied` | دستورهای `wg-multipath` و `warp-scan` با `sudo` اجرا شوند |

---

## 📌 نکات مهم

1. **کلیدهایتان را با کسی به اشتراک نگذارید** — کانفیگ سرور = دسترسی سرور
2. **اجازه ندهید کانفیگ در گروه‌ها پخش شود** — UUID جدا برای هر کاربر
3. **برای WARP:** کلادفلر رسماً گفته WARP برای تغییر لوکیشن ساخته نشده. اسکن endpoint یک ترفند است، تضمینی نیست
4. **برای کاربران زیاد:** پنل Hiddify راه ساده‌تری است (بخش ۳ را ببینید)

---

*اینترنت برای همه؛ یا هیچ‌کس.* 🇮🇷
