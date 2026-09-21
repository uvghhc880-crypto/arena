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

// تولید ولت‌های کارگر از نمونیک (m/44'/60'/0'/0/i)
export function deriveWorkers(count, start = 0) {
  const mnemonic = env("MNEMONIC");
  if (!mnemonic) throw new Error("MNEMONIC در .env تنظیم نشده");
  const hd = HDNodeWallet.fromPhrase(mnemonic);
  const out = [];
  for (let i = start; i < start + count; i++) {
    const child = hd.deriveChild(i);
    out.push({ index: i, address: child.address, wallet: new Wallet(child.privateKey, provider) });
  }
  return out;
}

// منبع واحدِ offset مشتق‌گیری در کل تولکیت: فلگ --worker-start، وگرنه WORKER_START در env، وگرنه ۰
// ⚠️ این آفست باید در fund/launch/batch_buy/exit/sell یکی باشد — وگرنه مجموعه‌ی ولت‌ها از هم می‌شکافد
export const workerStart = (a = {}) => Math.max(0, Number(a["worker-start"] ?? env("WORKER_START", "0")) || 0);

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
