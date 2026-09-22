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
// ممیزی ۵ — بازنویسی کامل با الگوریتم «cut-point» (uint256-safe):
// هر ورودی معتبر تضمین‌شده: Σسهم == totalWei دقیقاً، و هر سهم ≥ minWei — بدون هیچ حالت استثنایی.
// روش: excess = total − n×min را به‌صورت تصادفی بین n سهم پخش می‌کنیم (cut-point کافی‌تیک گردوخak را فقط +۱wei می‌دهد،
// که هرگز سهمی را زیر min نمی‌برد چون هر سهم از قبل ≥ min است).
import crypto from "node:crypto";
export function splitWeiRandom(totalWei, n, minWei = 0n) {
  totalWei = BigInt(totalWei); minWei = BigInt(minWei);
  if (!Number.isInteger(n) || n < 1) throw new Error(`تعداد بخش نامعتبر: ${n}`);
  if (n === 1) {
    if (totalWei < minWei) throw new Error(`جمع (${fmt(totalWei)} ETH) از حداقل سهم (${fmt(minWei)} ETH) کمتر است`);
    return [totalWei];
  }
  if (totalWei < minWei * BigInt(n))
    throw new Error(`جمع (${fmt(totalWei)} ETH) کمتر از ${n} × حداقل سهم (${fmt(minWei)} ETH = جمع ${fmt(minWei * BigInt(n))}) است — قابل‌تخصیص نیست`);
  const excess = totalWei - minWei * BigInt(n);
  if (excess === 0n) return Array.from({ length: n }, () => minWei);
  // وزن‌های تصادفی ۱۲۸بیتی (کافی برای نسبت‌های دقیق — خطای نسبت < ۱ wei)
  const w = Array.from({ length: n }, () => BigInt("0x" + crypto.randomBytes(16).toString("hex")) + 1n);
  const wSum = w.reduce((a, b) => a + b, 0n);
  const s = w.map((wi) => minWei + (excess * wi) / wSum);
  // گردوخاک: هر floor حداکثر ۱wei کم کرده ⇒ باقی‌مانده < n؛ +۱wei به هر سهمِ باقی (هر سهم ≥ min بوده، پس امن)
  let rem = totalWei - s.reduce((a, b) => a + b, 0n);
  if (rem > 0n) {
    // به ترتیب شافل‌شده پخش کن (عدالت) — یک‌وب به هریک تا پایان باقی‌مانده
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let idx = 0;
    while (rem > 0n) { s[order[idx % n]] += 1n; rem -= 1n; idx++; }
  } else if (rem < 0n) {
    // نظریتاً ناممکن (floor فقط کم می‌کند نه زیاد) ولی برای امنیت: از بزرگ‌ترین‌ها کم کن
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (s[b] > s[a] ? 1 : s[b] < s[a] ? -1 : 0));
    let idx = 0;
    while (rem < 0n) {
      const i = order[idx % n];
      if (s[i] > minWei) { s[i] -= 1n; rem += 1n; }
      idx++;
      if (idx > n * n) throw new Error("اشکال داخلی در موازنه‌ی گردوخاک splitWeiRandom");
    }
  }
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
    // ممیزی ۵: نقشه‌ی منجمد هم اعتبارسنجی می‌شود (طول/عدم‌منفی/خوانایی BigInt) — ژورنال دست‌کاری‌شده قابل‌استفاده نیست
    let frozen;
    try {
      if (!Array.isArray(al.amountsWei) || al.amountsWei.length !== recipients.length) return { ok: false, reason: "alloc-length-mismatch" };
      frozen = al.amountsWei.map((w) => BigInt(w));
      if (frozen.some((w) => w < 0n)) return { ok: false, reason: "alloc-negative" };
      if (frozen.reduce((x, y) => x + y, 0n) <= 0n) return { ok: false, reason: "alloc-zero-total" };
    } catch { return { ok: false, reason: "alloc-corrupt" }; }
    return { ok: true, source: "frozen", amountsWei: frozen };
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
// ممیزی ۵: contention دیگر process.exit نمی‌کند — throw می‌شود تا کالر بتواند لاک‌های قبلاً گرفته‌شده را رول‌بک کند
export class LockBusyError extends Error {
  constructor(file, detail) { super(`run-lock فعال است (${file}): ${detail}`); this.code = "LOCK_BUSY"; this.file = file; }
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
        throw new LockBusyError(file, `${prevRaw}${alive ? " (مالک لاک «زنده» است!)" : ""}`);
      }
      if (prev?.pid && pidAlive(prev.pid) && !forceLivePid) {
        throw new LockBusyError(file, `مالک (PID ${prev.pid}) هنوز زنده است — --force مجاز نیست`);
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
  try {
    for (let i = 0; i < files.length; i++) acquireOne(files[i], { token, force, forceLivePid });
  } catch (e) {
    // رول‌بک کامل: لاک‌های تازه گرفته‌شده در همین فراخوان آزاد شوند (ممیزی ۵ — خروج بدون stale-lock محلی)
    for (const f of files) { if (lockState.get(f) === token) { try { fs.unlinkSync(f); } catch {} lockState.delete(f); } }
    if (e.code === "LOCK_BUSY") { console.log(`⛔ ${e.message}\nاگر اجرای قبلی واقعاً مرده، با --force دوباره بیا. (لاک‌های نیمه‌گرفته‌شده‌ی این اجرا آزاد شدند)`); process.exit(1); }
    throw e;
  }
  lockGroups.set(file, files);
  process.on("exit", () => releaseRunLock(file));
  return token;
}

// ─── لاک سراسری «به‌ازای امضاکننده» (ممیزی ۵): همه‌ی عملیات یک یکی‌پول یک nonce می‌خواهند ───
// هر ابزاری که قرار است با signer تراکنش بفرستد، اول لاک سراسری همان آدرس را می‌گیرد:
// pons-signer-<chainId>-<address> — دو ابزار مختلف روی یکچیز هم‌زمان تراکنش نمی‌زنند.
const signerLocksHeld = new Set(); // addr (lower)
export async function acquireSignerLocks(signers, { chainId = CHAIN.id, force = false, forceLivePid = false, label = "", retryMs = 0 } = {}) {
  const addrs = [...new Set(signers.map((s) => (typeof s === "string" ? s : s.address).toLowerCase()))].filter(Boolean);
  const token = `signer-${process.pid}-${Date.now()}`;
  const acquired = [];
  const t0 = Date.now();
  for (;;) {
    try {
      for (const addr of addrs) {
        if (signerLocksHeld.has(addr)) { acquired.push({ addr, skip: true }); continue; }
        acquireOne(globalLockPath(`pons-signer-${chainId}-${addr}`), { token: `${token}-${addr}`, force, forceLivePid });
        signerLocksHeld.add(addr);
        acquired.push({ addr, skip: false });
      }
      break;
    } catch (e) {
      if (e.code !== "LOCK_BUSY" || Date.now() - t0 >= retryMs) throw e;
      await sleep(1500);
    }
  }
  if (acquired.some((x) => !x.skip) && label) console.log(`🔐 لاک سراسری امضاکننده‌ها گرفته شد (${acquired.filter((x) => !x.skip).length}/${addrs.length} آدرس) — ${label}`);
  process.on("exit", () => releaseSignerLocks());
  return addrs;
}
export function releaseSignerLocks() {
  for (const addr of [...signerLocksHeld]) {
    const f = globalLockPath(`pons-signer-${CHAIN.id}-${addr}`);
    releaseOne(f, lockState.get(f));
    signerLocksHeld.delete(addr);
  }
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
