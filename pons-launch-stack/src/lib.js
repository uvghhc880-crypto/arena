// زیرساخت مشترک: provider، ولت‌ها، گس، ابزارهای تصادفی و زمان
import { JsonRpcProvider, Wallet, HDNodeWallet, parseEther, formatEther } from "ethers";
import { CHAIN, env } from "./config.js";

export const provider = new JsonRpcProvider(CHAIN.rpcUrl, CHAIN.id);

// ولت مستر (کریتور)
export function masterWallet() {
  const pk = env("PRIVATE_KEY");
  if (!pk) throw new Error("PRIVATE_KEY در .env تنظیم نشده");
  return new Wallet(pk, provider);
}

// ولت کلیمر (جدا از مستر — الگوی موج دوم)
export function claimerWallet() {
  const pk = env("CLAIMER_PRIVATE_KEY");
  if (pk) return new Wallet(pk, provider);
  return masterWallet();
}

// تولید ولت‌های کارگر از نمونیک — مسیر استاندارد BIP44: m/44'/60'/0'/0/i
// (تأییدشده با بردارهای مرجع: ایندکس ۰ نمونیک تست = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)
// ⚠️ BREAKING: نسخه‌ی قبلی به اشتباه m/44'/60'/0'/0/0/i می‌ساخت
// legacy=true مسیر قدیمی اشتباه را می‌دهد — فقط برای بازیابی ولت‌های لانچ‌های قبلی (--legacy-hd)
export function deriveWorkers(count, start = 0, { legacy = false } = {}) {
  const mnemonic = env("MNEMONIC");
  if (!mnemonic) throw new Error("MNEMONIC در .env تنظیم نشده");
  const hd = HDNodeWallet.fromPhrase(mnemonic, undefined, "m");
  const out = [];
  for (let i = start; i < start + count; i++) {
    const child = hd.derivePath(legacy ? `44'/60'/0'/0/0/${i}` : `44'/60'/0'/0/${i}`);
    out.push({ index: i, address: child.address, wallet: new Wallet(child.privateKey, provider) });
  }
  return out;
}

// فلگ بازیابی مسیر قدیمی: --legacy-hd
export const legacyHd = (a = {}) => truthy(a["legacy-hd"]);

// منبع واحدِ offset مشتق‌گیری در کل تولکیت: فلگ --worker-start، وگرنه WORKER_START در env، وگرنه ۰
// ⚠️ این آفست باید در fund/launch/batch_buy/exit/sell یکی باشد — وگرنه مجموعه‌ی ولت‌ها از هم می‌شکافد
export const workerStart = (a = {}) => Math.max(0, Number(a["worker-start"] ?? env("WORKER_START", "0")) || 0);

// فلگ بولی: --x، --x=true فعال | --x=false و --x=0 غیرفعال (رفع تله‌ی رشته‌ی "false" که truthy است)
export const truthy = (v) => v !== undefined && v !== false && v !== "false" && v !== "0" && v !== 0;

// عدد اعتبارسنجی‌شده برای فلگ‌های عددی — NaN/Infinity/خارج‌بازه = خطای صریح، نه رفتار ساکت
// int=true: فقط عدد صحیح (رفع کرش BigInt(1.5) برای --pct 1.5)
export function numOpt(v, def, { min = -Infinity, max = Infinity, name = "عدد", int = false } = {}) {
  const n = v === undefined ? def : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} مقدار نامعتبر است: ${v}`);
  if (int && !Number.isInteger(n)) throw new Error(`${name} باید عدد صحیح باشد — مقدار: ${n}`);
  if (n < min || n > max) throw new Error(`${name} باید در بازه‌ی [${min}, ${max}] باشد — مقدار: ${n}`);
  return n;
}

// نرمال‌کردن هر ورودی به bytes32: هگز با طول فرد ("0x1") هم امن می‌شود — جلو رشته نیبل کم می‌خورد
import { zeroPadValue } from "ethers";
export function normalizeBytes32(s) {
  let h = String(s).toLowerCase();
  if (h.startsWith("0x")) h = h.slice(2);
  if (h !== "" && !/^[0-9a-f]+$/.test(h)) throw new Error(`مقدار هگز نامعتبر: ${s}`);
  if (h.length % 2) h = "0" + h;
  return zeroPadValue("0x" + h, 32);
}

// مبالغ مالی: string-first — هیچ گردکردنی از طریق Number نداریم (باگ «0.0000009 ⇒ 0.000001 ETH» و «⇒0!»)
// ورودی string: خودش (تا ۱۸ رقم اعشار)؛ ورودی number: تبدیلِ دقیقِ رشته‌ی خودش + هشدار دقت.
const DEC18 = /^\d+(\.\d{1,18})?$/;
export const eth = (x) => {
  if (typeof x === "string") {
    const s = x.trim();
    if (!DEC18.test(s)) throw new Error(`مقدار ETH نامعتبر (بیش از ۱۸ رقم اعشار یا فرمت بد): "${x}"`);
    return parseEther(s);
  }
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`مقدار ETH نامعتبر: ${x}`);
  if (n < 0) throw new Error(`مقدار ETH منفی مجاز نیست: ${x}`);
  let s = String(n); // دقیق‌ترین نمایش IEEE-754 — ممکن است فرم نماد علمی بگیرد ("9e-7")
  if (/[eE]/.test(s)) s = n.toFixed(18).replace(/0+$/, "").replace(/\.$/, ""); // گسترش فرم علمی به اعشاری ساده
  if (!DEC18.test(s)) throw new Error(`مقدار ETH نامعتبر (بیش از ۱۸ رقم اعشار یا فرمت بد): "${x}"`);
  return parseEther(s);
};
// weiOf فقط اشاره به همان eth است — مسیر واحدهای پول = همیشه string-first
export const weiOf = eth;
export const fmt = formatEther;

export async function gasPrice() {
  const fd = await provider.getFeeData();
  const gp = fd.gasPrice ?? parseEther("0.0000001") / 1000n;
  return gp;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// عدد تصادفی یکنواخت در [min, max]
export const rand = (min, max) => min + Math.random() * (max - min);

// تقسیم یک مبلغ کل به n سهم با وزن‌های تصادفی (سبک Dirichlet)
// ⚠️ نسخه‌ی Number — فقط سازگاری؛ خروجی float دارد و clamp/min/scale دوباره مین را می‌شکند.
//    برای پول واقعی از splitWeiRandom استفاده کن (BigInt دقیق، مین تضمین‌شده، جمع دقیق).
export function splitRandom(totalEth, n, minShareEth = 0) {
  const weights = Array.from({ length: n }, () => Math.random() + 0.05);
  const sum = weights.reduce((a, b) => a + b, 0);
  let shares = weights.map((w) => (totalEth * w) / sum);
  shares = shares.map((s) => Math.max(s, minShareEth));
  const scale = totalEth / shares.reduce((a, b) => a + b, 0);
  return shares.map((s) => s * scale);
}

// ─── تقسیم دقیق BigInt: n سهم تصادفی، هرکدام ≥ minWei و جمع دقیقاً = totalWei ───
// الگوریتم: وزن تصادفی + آب‌پرش (water-filling) صحیح؛ اگر total < n×min ⇒ خطای صریح (غیرممکن)
// (رفع باگ گزارش‌شده «clamp سپس scale مجدد» در ممیزی دوم)
export function splitWeiRandom(totalWei, n, minWei = 0n) {
  totalWei = BigInt(totalWei); minWei = BigInt(minWei);
  if (!Number.isInteger(n) || n < 1) throw new Error(`تعداد بخش نامعتبر: ${n}`);
  if (totalWei < minWei * BigInt(n))
    throw new Error(`جمع (${fmt(totalWei)} ETH) کمتر از ${n} × حداقل سهم (${fmt(minWei)} ETH = جمع ${fmt(minWei * BigInt(n))}) است — قابل‌تخصیص نیست`);
  const SCALE = 1000000n;
  const w = Array.from({ length: n }, () => BigInt(Math.floor((Math.random() + 0.05) * 1000)) * SCALE);
  const wSum = w.reduce((a, b) => a + b, 0n);
  let s = w.map((wi) => (totalWei * wi) / wSum);
  // گردوخاکِ گردکردن را به بزرگ‌ترین سهم بده تا جمع دقیق شود
  let rem = totalWei - s.reduce((a, b) => a + b, 0n);
  if (rem !== 0n) {
    let imax = 0; for (let i = 1; i < n; i++) if (s[i] > s[imax]) imax = i;
    s[imax] += rem;
  }
  // آب‌پرش: کسری سهم‌های < minWei را از مازاد سهم‌های > minWei به نسبت مازاد برمی‌داریم (صحیح، حداکثر n دور)
  for (let iter = 0; iter <= n; iter++) {
    let deficit = 0n, surplus = 0n;
    for (const x of s) { if (x < minWei) deficit += minWei - x; else surplus += x - minWei; }
    if (deficit === 0n) break;
    // اول سهم‌های زیر مین را ببَر به مین
    for (let i = 0; i < n; i++) if (s[i] < minWei) s[i] = minWei;
    // حالا deficit را از surplusها برمی‌داریم
    if (surplus === 0n) throw new Error("تخصیص غیرممکن (surplus=0)"); // نباید رخ دهد چون total ≥ n×min چک شد
    let took = 0n;
    for (let i = 0; i < n; i++) {
      if (took >= deficit) break;
      const avail = s[i] > minWei ? s[i] - minWei : 0n;
      if (avail === 0n) continue;
      let give = (deficit * avail) / surplus;
      if (give === 0n) give = avail >= deficit - took ? deficit - took : avail; // گردوخاک: از سهم‌های آخر بردار
      if (give > avail) give = avail;
      s[i] -= give; took += give;
    }
  }
  // تطبیق نهایی گردوخاک (به‌خاطر گردکردن نسبت‌ها) — روی بزرگ‌ترین سهم
  rem = totalWei - s.reduce((a, b) => a + b, 0n);
  if (rem !== 0n) {
    let imax = 0; for (let i = 1; i < n; i++) if (s[i] > s[imax]) imax = i;
    if (rem < 0n && s[imax] + rem < minWei) {
      // به‌ندرت: اگر کسر از بزرگ‌ترین او را زیر مین برد، از دوم بزرگ‌ترین برمی‌داریم
      const sorted = s.map((x, i) => [x, i]).sort((a, b) => (b[0] > a[0] ? 1 : -1));
      for (const [, i] of sorted) if (s[i] + rem >= minWei) { s[i] += rem; rem = 0n; break; }
    } else { s[imax] += rem; rem = 0n; }
  }
  if (rem !== 0n) throw new Error("اشکال داخلی در splitWeiRandom");
  return s;
}

export function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ─── منیجر نقشه‌ی تخصیص بچ‌بای (تست‌شدنی — سناریوی overspend ممیزی ۳ دقیقاً همین‌جا قفل شد) ───
// resume: اگر ژورنال alloc منجمد دارد و کاری انجام‌شده، همان برمی‌گردد؛ نبودِ اجرا یا --fresh ⇒ تخصیص تازه
// ممیزی ۴ — preflight «این آدرس واقعاً قرارداد است؟» (پول رفتن به آدرس EOA/خالی از جدی‌ترین ریسک‌هاست)
// قبل از هر عملیات حساس: آدرس‌مان code دارد؟ EOA ⇒ ابطال فوری.
export async function assertContract(addr, label = "contract") {
  const code = await provider.getCode(addr);
  if (!code || code === "0x") {
    throw new Error(`⛔ ${label} (${addr}) روی چین ${CHAIN.id} کد ندارد (EOA/آدرس اشتباه) — ادامه ممنوع. آدرس/چین را دوباره چک کن.`);
  }
  return code;
}

export function resolveBatchAllocation({ journal = null, fresh = false, recipients, totalWei, minShareWei, dryRun = false }) {
  const hasWork = journal && (
    (((journal.results ?? []).length + (journal.failed ?? []).length) > 0) ||
    (journal.entries && Object.keys(journal.entries).length > 0) // فرمت ژورنال fund
  );
  if (journal && !fresh && hasWork) {
    // ممیزی ۴: ژورنالِ دارای کارِ انجام‌شده بدون نقشه‌ی منجمد ⇒ محکم‌بستن — هرگز بی‌صدا تخصیص تازه نساز
    if (!journal.alloc) return { ok: false, reason: "alloc-missing-on-resume" };
    const al = journal.alloc;
    const alRecips = (al.recipients ?? []).map((x) => x.toLowerCase());
    const now = recipients.map((r) => r.toLowerCase());
    if (JSON.stringify(alRecips) !== JSON.stringify(now)) return { ok: false, reason: "alloc-recipients-mismatch" };
    return { ok: true, source: "frozen", amountsWei: al.amountsWei.map((w) => BigInt(w)) };
  }
  const amountsWei = splitWeiRandom(BigInt(totalWei), recipients.length, dryRun ? 0n : BigInt(minShareWei));
  return {
    ok: true, source: "fresh", amountsWei,
    journalAlloc: {
      totalEth: Number(fmt(BigInt(totalWei))), minShareEth: Number(fmt(BigInt(minShareWei))),
      recipients: recipients.slice(), amountsWei: amountsWei.map((w) => w.toString()),
    },
  };
}

// ─── خواندن/نوشتن اتمیک JSON (ضد کرش نیمه‌کاره) + بکاپ .bak ───
import fs from "node:fs";
export function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch {}
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // rename روی یک فایل‌سیستم اتمیک است
}
export function readJsonSafe(file, { allowBak = true } = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (typeof e.code === "string" && e.code === "ENOENT") return null; // فایل حذف‌شده = خالی؛ .bak هرگز فایلِ پاک‌شده را «نجات» نمی‌دهد (رفع باگ silence-restore)
    if (allowBak) {
      try {
        const j = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"));
        console.warn(`⚠️ ژورنال اصلی خراب بود — از بکاپ .bak بازیابی شد: ${file}`);
        return j;
      } catch {}
    }
    throw new Error(`ژورنال خراب است و بکاپ هم در دسترس نیست — بازیابی دستی لازم: ${file}`);
  }
}

// ─── وضعیت یک تراکنش: بعد از TIMEOUT/قطعی RPC، مسئله‌ی «ماین شده یا نه» روشن می‌شود ───
// خروجی: "ok" | "reverted" | "pending" (در mempool/لایافته) | "absent" (قطعاً ثبت نشده — retry امن) | "unknown" (RPC خطا داد — retry ممنوع!)
// تفکیک absent/unknown حیاتی است: treat-RPC-error-as-absent ⇒ ارسال تکراری (باگ بحرانی ممیزی ۳)
export async function classifyTx(txHash, { polls = 3, intervalMs = 5000, rpc = null } = {}) {
  const p = rpc ?? provider;
  let rpcFailed = false;
  for (let i = 0; i < polls; i++) {
    try {
      const rc = await p.getTransactionReceipt(txHash);
      if (rc) return rc.status === 1 ? "ok" : "reverted";
      const tx = await p.getTransaction(txHash);
      if (tx) return "pending";
      // این poll «خواندن پیاپ خالص» بود؛ ادامه می‌دهیم
    } catch { rpcFailed = true; }
    if (i < polls - 1) await sleep(intervalMs);
  }
  return rpcFailed ? "unknown" : "absent";
}

// ─── run-lock مالکیت‌دار اتمیک (مشترک بین batch_buy و fund) ───
// ساخت انحصاری با 'wx' (ضد TOCTOU) + توکن مالک: پاک‌کردن فقط وقتی توکن فایل == توکن ما.
// --force: فقط وقتی اجازه که PID مالک زنده نباشد (مگر --force-live-pid صریح).
import process from "node:process";
import os from "node:os";
import path from "node:path";
const lockState = new Map(); // file → token
const lockGroups = new Map(); // file اصلی → [fileها در گروه] (محلی + سراسری)
// لاک سراسری per-chain/per-wallet: جلوی دو نسخه‌ی متفاوت پروژه (دو پوشه/دستگاهِ NFS-مشترک) را می‌گیرد
function globalLockPath(globalKey) {
  const key = String(globalKey).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dir = path.join(os.homedir(), ".pons-launch-stack-locks");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key}.lock`);
}
export function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function acquireOne(file, { token, force = false, forceLivePid = false }) {
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      fs.closeSync(fd);
      lockState.set(file, token);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const prevRaw = (() => { try { return fs.readFileSync(file, "utf8"); } catch { return "?"; } })();
      let prev = null; try { prev = JSON.parse(prevRaw); } catch {}
      if (!force) {
        const alive = prev?.pid && pidAlive(prev.pid);
        console.log(`⛔ run-lock فعال است (${file}): ${prevRaw}${alive ? "\nPID مالک «زنده» است!" : ""}\nاگر اجرای قبلی واقعاً مرده، با --force دوباره بیا.`);
        process.exit(1);
      }
      if (prev?.pid && pidAlive(prev.pid) && !forceLivePid) {
        console.log(`⛔ مالکِ لاک (PID ${prev.pid}) هنوز زنده است — --force مجاز نیست. اگر واقعاً مطمئنی: --force --force-live-pid`);
        process.exit(1);
      }
      console.warn(`⚠️ run-lock قبلی با --force نادیده گرفته شد (${file})`);
      try { fs.unlinkSync(file); } catch (e2) { if (e2.code !== "ENOENT") throw e2; }
    }
  }
}
// globalKey (اختیاری): مثل "pons-batch-2026-0xabc..." — علاوه بر لاک محلی پوشه، لاک جهانی هم می‌گیرد
export function acquireRunLock(file, { force = false, forceLivePid = false, globalKey = null } = {}) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const files = [file, ...(globalKey ? [globalLockPath(globalKey)] : [])];
  for (let i = 0; i < files.length; i++) {
    try { acquireOne(files[i], { token, force, forceLivePid }); }
    catch (e) {
      // رول‌بک: لاک‌های تازه گرفته‌شده در همین فراخوان آزاد شوند
      for (let j = 0; j < i; j++) { lockState.delete(files[j]); try { fs.unlinkSync(files[j]); } catch {} }
      throw e;
    }
  }
  lockGroups.set(file, files);
  process.on("exit", () => releaseRunLock(file));
  return token;
}
export function releaseRunLock(file) {
  const group = lockGroups.get(file) ?? [file];
  for (const f of group) {
    const token = lockState.get(f);
    if (!token) { if (f === file) return; continue; }
    releaseOne(f, token);
    lockGroups.delete(f);
  }
}
function releaseOne(file, token) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j.token !== token) { console.warn("⚠️ لاک متعلق به پردازش دیگری است — دست نخورده ماند"); return; }
    fs.unlinkSync(file);
  } catch {}
  lockState.delete(file);
}

// حذف امضاکننده‌های تکراری بر اساس آدرس — جلوگیری از شمارش مضاعف دارایی و تصادم nonce
export function uniqueSigners(wallets) {
  const seen = new Set(), out = [];
  for (const w of wallets) {
    const k = w.address.toLowerCase();
    if (seen.has(k)) { console.warn(`⚠️ امضاکننده‌ی تکراری (آدرس یکسان) حذف شد: ${w.address}`); continue; }
    seen.add(k); out.push(w);
  }
  return out;
}
