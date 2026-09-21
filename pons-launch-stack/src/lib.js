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
export function deriveWorkers(count, start = 0) {
  const mnemonic = env("MNEMONIC");
  if (!mnemonic) throw new Error("MNEMONIC در .env تنظیم نشده");
  const hd = HDNodeWallet.fromPhrase(mnemonic, undefined, "m");
  const out = [];
  for (let i = start; i < start + count; i++) {
    const child = hd.derivePath(`44'/60'/0'/0/${i}`);
    out.push({ index: i, address: child.address, wallet: new Wallet(child.privateKey, provider) });
  }
  return out;
}

// منبع واحدِ offset مشتق‌گیری در کل تولکیت: فلگ --worker-start، وگرنه WORKER_START در env، وگرنه ۰
// ⚠️ این آفست باید در fund/launch/batch_buy/exit/sell یکی باشد — وگرنه مجموعه‌ی ولت‌ها از هم می‌شکافد
export const workerStart = (a = {}) => Math.max(0, Number(a["worker-start"] ?? env("WORKER_START", "0")) || 0);

// فلگ بولی: --x، --x=true فعال | --x=false و --x=0 غیرفعال (رفع تله‌ی رشته‌ی "false" که truthy است)
export const truthy = (v) => v !== undefined && v !== false && v !== "false" && v !== "0" && v !== 0;

// عدد اعتبارسنجی‌شده برای فلگ‌های عددی — NaN/Infinity/خارج‌بازه = خطای صریح، نه رفتار ساکت
export function numOpt(v, def, { min = -Infinity, max = Infinity, name = "عدد" } = {}) {
  const n = v === undefined ? def : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} مقدار نامعتبر است: ${v}`);
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

export const eth = (x) => parseEther(Number(x).toFixed(6));
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
export function splitRandom(totalEth, n, minShareEth = 0) {
  const weights = Array.from({ length: n }, () => Math.random() + 0.05);
  const sum = weights.reduce((a, b) => a + b, 0);
  let shares = weights.map((w) => (totalEth * w) / sum);
  shares = shares.map((s) => Math.max(s, minShareEth));
  const scale = totalEth / shares.reduce((a, b) => a + b, 0);
  return shares.map((s) => s * scale);
}

export function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
