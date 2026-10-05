# تانل ایران → خارج با خروجی چندکشوری

راهنمای کامل پیاده‌سازی معماری **رله + خروجی چندکشوری** با Xray و WireGuard.
ساخته‌شده برای شرایطی که فقط IP ایران قابل‌دسترس است و کاربر به آی‌پی کشورهای مختلف نیاز دارد.

---

## معماری

```
   👤 کاربران ایران
        │  VLESS + REALITY  (پورت 443)
        ▼
┌──────────────────────────────┐
│  🇮🇷 سرور ایران  (Relay)      │   ← فقط این IP برای کاربران قابل‌دسترس است
│                              │
│  inbound: users-in           │
│  routing بر اساس email:      │
│    ali-de   → exit-de        │
│    ali-nl   → exit-nl        │
│    ali-us   → exit-us        │
└──────────────────────────────┘
        │  تونل REALITY، یک اتصال به‌ازای هر کشور
        ▼
┌──────────────────────────────┐
│  🌍 سرور خارجی (Exit)         │
│                              │
│  inbound per country:        │
│    :10443 → wg-de            │
│    :18443 → wg-nl            │
│    :20443 → wg-us            │
│        │                     │
│  sockopt.mark = 1000/1001/…  │
└──────────────────────────────┘
        │  WireGuard، اینترفیس جدا برای هر کشور
        ▼
   ┌─────────┬─────────┬─────────┐
   │  wg0    │  wg1    │  wg2    │
   │ 🇩🇪 DE   │ 🇳🇱 NL   │ 🇺🇸 US   │
   └─────────┴─────────┴─────────┘
        ▼
   🌐 سایت مقصد  →  آی‌پی کشور انتخابی را می‌بیند
```

**چرا این کار می‌کند:** در شرایط whitelisting، فقط IP داخل ایران قابل‌دسترس است. سرور ایران نقطه‌ی ورود می‌شود، ولی از آنجا که اتصال *خروجی* آن محدود نیست، تونل به خارج می‌زند. سرور خارجی هم با اینترفیس‌های WireGuard مجزا، خروجی هر کشور را تأمین می‌کند.

---

## پیش‌نیازها

| مورد | توضیح |
|---|---|
| سرور ایران | Ubuntu 22.04+، ۱ vCPU کافی است (فقط رله است، پردازش سنگین ندارد) |
| سرور خارجی | Ubuntu 22.04+، بهتر است پهنای باند بالا داشته باشد |
| دامنه | برای REALITY **لازم نیست** دامنه‌ی خودتان باشد — از SNI سایت واقعی استفاده می‌کنیم |
| Xray | روی هر دو سرور |
| WireGuard | فقط روی سرور خارجی |

نصب یک‌خطی Xray روی هر دو سرور:
```bash
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
```

---

## مرحله ۱ — سرور خارجی: آماده‌سازی خروجی‌های چندکشوری

### ۱.۱ فایل‌های WireGuard را بگذارید

برای هر کشور یک فایل `.conf` بسازید و در `/etc/wireguard/countries/` قرار دهید:

```bash
sudo mkdir -p /etc/wireguard/countries
sudo nano /etc/wireguard/countries/Germany.conf
```

قالب استاندارد (همان چیزی که همه‌ی سرویس‌دهنده‌ها می‌دهند):

```ini
[Interface]
PrivateKey = <کلید خصوصی>
Address = 10.66.0.2/32

[Peer]
PublicKey = <کلید عمومی سرور>
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = de1.provider.net:51820
PersistentKeepalive = 25
```

همین کار را برای هر کشور تکرار کنید: `Netherlands.conf`، `USA.conf`، `France.conf`، ...

### ۱.۲ اسکریپت multipath را اجرا کنید

```bash
sudo python3 wg-multipath.py up --dir /etc/wireguard/countries
```

خروجی:
```
[*] 3 کانفیگ پیدا شد: Germany, Netherlands, USA
[*] مسیر پیش‌فرض سیستم: via 10.0.0.1 dev eth0
[+] Germany → wg0 (mark 1000)
[+] Netherlands → wg1 (mark 1001)
[+] USA → wg2 (mark 1002)
[+] نقشه ذخیره شد: /etc/wireguard/countries/country-map.json

کشور            اینترفیس  mark    وضعیت     آخرین handshake
Germany         wg0       1000    فعال      1 minute ago  ↓2.4 MiB
Netherlands     wg1       1001    فعال      45 seconds ago  ↓1.1 MiB
USA             wg2       1002    فعال      2 minutes ago  ↓890 KiB
```

**چه کاری انجام می‌دهد:**
- برای هر کشور یک اینترفیس `wgN` می‌سازد
- یک **جدول مسیریابی مجزا** به هر کدام می‌دهد (`1000+N`)
- یک **fwmark** به هر کدام می‌دهد تا Xray بتواند ترافیک را به کشور دلخواه بفرستد
- هیچ مسیر سراسری‌ای تغییر نمی‌کند — پس SSH شما قطع نمی‌شود ✅

دستورات مفید:
```bash
sudo python3 wg-multipath.py status --dir /etc/wireguard/countries   # وضعیت
sudo python3 wg-multipath.py render --dir /etc/wireguard/countries   # پیش‌نمایش
sudo python3 wg-multipath.py down   --dir /etc/wireguard/countries   # خاموش‌کردن
```

### ۱.۳ کلید REALITY سرور خارجی

```bash
xray x25519
# Private key: <این را در کانفیگ بگذارید>
# Public key:  <این را برای سرور ایران بردارید>
```

### ۱.۴ کانفیگ Xray

```bash
sudo cp configs/foreign-exit.json /usr/local/etc/xray/config.json
sudo nano /usr/local/etc/xray/config.json   # مقادیر REPLACE_WITH_... را پر کنید
sudo systemctl restart xray && sudo systemctl status xray
```

> ⚠️ مهم: `mark` ها در کانفیگ Xray باید **دقیقاً** با خروجی `wg-multipath.py` یکی باشند.

---

## مرحله ۲ — سرور ایران: نقطه‌ی ورود

```bash
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
xray x25519    # کلید REALITY مخصوص سرور ایران
```

```bash
sudo cp configs/iran-relay.json /usr/local/etc/xray/config.json
sudo nano /usr/local/etc/xray/config.json
```

مقادیر زیر را پر کنید:

| فیلد | مقدار |
|---|---|
| `privateKey` (در inbound) | کلید خصوصی REALITY سرور ایران |
| `FOREIGN_SERVER_IP` | IP سرور خارجی |
| `publicKey` (در outbounds) | کلید عمومی REALITY سرور خارجی |
| UUID ها | هر کاربر برای هر کشور یک UUID |

```bash
sudo systemctl restart xray && sudo systemctl status xray
sudo journalctl -u xray -f      # دیدن لاگ زنده
```

### تست سریع

```bash
# از سرور ایران، آیا به پورت‌های سرور خارجی می‌رسیم؟
for p in 10443 18443 20443; do
  timeout 3 bash -c "echo > /dev/tcp/FOREIGN_IP/$p" 2>/dev/null \
    && echo "  ✓ پورت $p باز است" || echo "  ✗ پورت $p بسته است"
done
```

---

## مرحله ۳ — ساخت کانفیگ برای کاربران

```bash
python3 gen-links.py --template --out ./out      # ساخت فایل نمونه
nano out/users.template.json                     # پر کردن
python3 gen-links.py --spec out/users.template.json --out ./out
```

خروجی:
```
[+] ساخته شد:
    ali              3 کانفیگ   →  ./out/ali.txt  +  ali_base64.txt
    reza             2 کانفیگ   →  ./out/reza.txt  +  reza_base64.txt
    ALL              8 کانفیگ   →  ./out/ALL_base64.txt
```

فایل `ali_base64.txt` را به کاربر بدهید — در **v2rayNG** یا **Hiddify**:
`Add subscription from clipboard` → تمام کانفیگ‌هایش اضافه می‌شود.

> 🔑 **نکته‌ی مهم:** UUID هر کاربر برای هر کشور باید **یکتا** باشد.
> فرمت email که در کانفیگ سرور ایران گذاشتیم (`ali-de`) همان چیزی است که
> routing بر اساسش تصمیم می‌گیرد. پس الگو را نگه دارید: `<username>-<country>`.

---

## مرحله ۴ — بهینه‌سازی

### فعال‌سازی BBR (روی هر دو سرور)

```bash
cat | sudo tee /etc/sysctl.d/99-bbr.conf <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_fastopen = 3
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
EOF
sudo sysctl --system
```

### MTU و پرفورمنس

| مورد | پیشنهاد |
|---|---|
| MTU اینترفیس WireGuard | `1420` (در اسکریپت تنظیم شده) |
| Mux | فعال با `concurrency: 8` — برای تونل ایران→خارج خیلی مؤثر است |
| پروتکل کاربران | `VLESS + REALITY + xtls-rprx-vision` — بهترین نسبت پرفورمنس/مقاومت |
| پورت | 443 روی سرور ایران |

### تست پرفورمنس

```bash
# از سرور ایران
sudo apt install -y iperf3
iperf3 -c FOREIGN_IP -p 5201        # روی سرور خارجی: iperf3 -s
```

### اگر WireGuard کند بود

گزینه‌های بهتر برای مسیر سرور خارجی:
- **AmneziaWG** — نسخه‌ی مبهم‌شده‌ی WireGuard، مقاوم‌تر به DPI
- **sing-box** با outbound از نوع WireGuard (اگر Xray را دوست ندارید)
- **VLESS outbound** به یک سرور واسط دیگر به‌جای WireGuard

---

## 🔴 هشدار حقوقی — مهم است بخوانید

### استفاده از اشتراک VPN تجاری روی سرور

اکثر سرویس‌دهندگان VPN در شرایط استفاده (ToS) خود **صراحتاً** ممنوع می‌کنند که:
- حساب شخصی روی سرور اجرا شود
- دسترسی به چندین کاربر واگذار شود
- برای مقاصد تجاری یا «reselling» استفاده شود

نقض ToS معمولاً پیامد حقوقی ندارد ولی **به قطع حساب می‌انجامد** — و وقتی حساب قطع شود، تمام کانفیگ‌های شما یک‌جا می‌خوابند. اگر روی این معماری برای ده‌ها نفر حساب می‌کنید، این ریسک جدی است.

### راه‌های جایگزین (پیشنهاد جدی)

| راه | توضیح | هزینه |
|---|---|---|
| **VPS در هر کشور** | دقیقاً همان اینترفیس WireGuard را می‌دهد، مال خودتان است | از ۲-۳ دلار ماهانه |
| **Oracle Cloud Always Free** | در چند منطقه، رایگان دائمی (ARM) | ۰ |
| **سرویس‌های پروکسی** | به‌جای WireGuard از SOCKS/HTTP proxy استفاده کنید | متغیر |
| **سرویس‌دهنده‌ای که اجازه می‌دهد** | بعضی سرویس‌ها فرق می‌گذارند (Mullvad, IVPN, AirVPN روی سرور شخصی) | متغیر |
| **Cloudflare WARP** | رایگان، ولی انتخاب کشور ندارد | ۰ |

**پیشنهاد من:** اگر هدف کمک به چند نفر است، با Oracle Cloud Always Free چند سرور در کشورهای مختلف بگیرید. رایگان، پایدار، قانونی، و هیچ‌وقت یک‌جا نمی‌خوابد.

---

## ⚠️ ملاحظات امنیتی

| ریسک | توضیح | راهکار |
|---|---|---|
| **سرور ایران هانی‌پات** | سرویس‌دهنده‌ی ایرانی می‌تواند ترافیک را دیده باشد | REALITY + TLS؛ در نظر داشته باشید که نقطه‌ی ورود همیشه ضعیف‌ترین حلقه است |
| **همبستگی ورود و خروج** | اگر یک کاربر هم‌زمان از ورود و خروج ترافیک بفرستد، تحلیل‌گر می‌تواند مرتبطشان کند | فاصله‌گذاری، استفاده‌ی ترتیبی |
| **افشای تنظیمات** | اگر کانفیگ سرور پخش شود، همه‌چیز از دست می‌رود | UUID جدا برای هر کاربر؛ پنل مدیریت با احراز هویت |
| **حملات کاهشی (DPI)** | اگر REALITY کشف شود | SNI واقعی و پرطرفدار انتخاب کنید؛ `spiderX` مقدار تصادفی |
| **DDOS / سوءاستفاده** | پورت باز می‌تواند اسکن شود | `fail2ban` + محدودیت نرخ + مانیتورینگ |

### کنترل دسترسی

اگر افراد زیادی استفاده می‌کنند، Xray API را برای آمار و مدیریت فعال کنید:

```bash
# در کانفیگ، بخش api را اضافه کنید و این را اجرا کنید:
xray api statsquery --server=127.0.0.1:10085
```

یا از یک پنل آماده استفاده کنید (پایین را ببینید).

---

## 🚀 راه ساده‌تر: پنل‌های آماده

اگر نمی‌خواهید همه‌ی این‌ها را دستی بچینید، پنل‌ها **تانل/رله را بومی** پشتیبانی می‌کنند:

### Hiddify Manager (پیشنهاد اول برای ایران)
تانل را با چند کلیک راه می‌اندازد و ۶ روش دارد:

| روش | توضیح |
|---|---|
| **WST tunnel** | تونل WebSocket — معمولاً بهترین در ایران |
| **Dokodemo-Door** | تونل Xray به Xray — سبک و سریع |
| **GOST** | پشتیبانی از چند سرور خارجی به‌طور هم‌زمان |
| **HA-Proxy** | شفاف، بدون کانفیگ اضافی |
| **Socat** | ساده‌ترین، کمترین سربار |
| **IPTables** | در سطح کرنل، سریع‌ترین |

نصب:
```bash
curl -L https://github.com/hiddify/hiddify-manager/releases/latest/download/install.sh | bash
```
بعد در پنل: `Relay Server` → `Add` → نوع تانل را انتخاب کنید.

### Marzban
نصب سریع، دارای CLI برای مدیریت کاربران:
```bash
sudo bash -c "$(curl -sL https://github.com/Gozargah/Marzban-scripts/raw/master/marzban.sh)" @ install
```
تانل را با ویرایش `routing` و `outbounds` (همان الگوی `dialerProxy` که در کانفیگ‌های این پوشه هست) اضافه می‌کنید.

### 3x-ui
پنل گرافیکی ساده با پشتیبانی از outbound chaining.

---

## 🔧 عیب‌یابی

| مشکل | علت احتمالی | راه‌حل |
|---|---|---|
| کاربر وصل می‌شود ولی اینترنت ندارد | سرور ایران به خارج نمی‌رسد | `curl -v https://FOREIGN_IP:10443` از سرور ایران |
| کانفیگ کار می‌کند ولی IP ایران است | rule مسیریابی اجرا نشده | `sudo python3 wg-multipath.py status` — handshake دارد؟ |
| IP آلمان می‌دهد ولی سایت می‌گوید ایران | DNS نشتی دارد | بخش `dns-de` را در `routing` چک کنید |
| SSH قطع می‌شود | مسیر پیش‌فرض سیستم عوض شده | اسکریپت این‌کار را نمی‌کند؛ `Table = off` را چک کنید |
| `wg-quick up شکست خورد` | کانفیگ نامعتبر | `sudo wg-quick up /etc/wireguard/wg0.conf` را دستی بزنید |
| سرعت خیلی کم | دو بار رمزنگاری | BBR را فعال کنید؛ Mux را تنظیم کنید؛ MTU را ۱۳۸۰ امتحان کنید |
| یکی از کشورها کار نمی‌کند | اشتراک آن قطع شده | `status` بزنید — handshake تازه می‌شود؟ |
| `mark` اشتباه | جدول‌ها جابه‌جا شده | `country-map.json` را با کانفیگ Xray تطبیق دهید |

---

## ساختار فایل‌ها

```
iran-tunnel/
├── README.md                  ← همین راهنما
├── CLIENTS.md                 ← راهنمای انتخاب کلاینت (کدام اپ برای کدام پلتفرم)
├── wg-multipath.py            ← راه‌اندازی چند تونل WireGuard موازی
├── gen-links.py               ← تولید لینک vless:// برای کاربران
├── gen-clash.py               ← تولید کانفیگ Clash Meta (لیست کشور + انتخاب خودکار)
└── configs/
    ├── iran-relay.json        ← کانفیگ Xray سرور ایران
    └── foreign-exit.json      ← کانفیگ Xray سرور خارجی
```

### تست انجام‌شده

| بخش | وضعیت |
|---|---|
| پارس کانفیگ WireGuard (۳ نمونه) | ✅ |
| تشخیص کانفیگ ناقص و نامعتبر | ✅ |
| تولید config برای هر کشور | ✅ |
| تخصیص خودکار mark/table | ✅ |
| اعتبارسنجی JSON هر دو کانفیگ Xray | ✅ |
| تولید و اعتبارسنجی لینک‌های `vless://` | ✅ |
| تولید و اعتبارسنجی کانفیگ Clash Meta (YAML) | ✅ |
| اجرای زنده روی سرور | ⏳ نیازمند دو سرور واقعی |

---

*این پروژه برای دسترسی آزاد به اینترنت ساخته شده. مسئولیت رعایت قوانین محلی و شرایط استفاده‌ی سرویس‌دهندگان بر عهده‌ی اجراکننده است.*
