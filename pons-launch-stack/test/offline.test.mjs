// تست آفلاین تولکیت — بدون شبکه و بدون کلید واقعی (نمونیک استاندارد عمومی هارد‌هت)
// اجرا: node test/offline.test.mjs   (یا: npm test)
process.env.MNEMONIC = "test test test test test test test test test test test junk";
delete process.env.WORKER_START;

import { isAddress, formatUnits, parseUnits, HDNodeWallet, zeroPadValue } from "ethers";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name); } };

const lib = await import("../src/lib.js");
const mkt = await import("../src/market.js");
const cfg = await import("../src/config.js");
const abis = await import("../src/abis.js");
const { deriveWorkers, workerStart, splitRandom, truthy, numOpt } = lib;
const { median, estMinOut } = mkt;

// ─── ۱) مسیر HD استاندارد BIP44 (بردار مرجع رسمی هارد‌هت) ───
{
  const w0 = deriveWorkers(1, 0)[0], w1 = deriveWorkers(2, 0)[1];
  ok("BIP44 idx0 == 0xf39F… (بردار مرجع)", w0.address === "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  ok("BIP44 idx1 == 0x7099… (بردار مرجع)", w1.address === "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  ok("آدرس ≠ مسیر اشتباه قدیمی (m/…/0/0/i)", w0.address !== "0xD51d4b680Cd89E834413c48fa6EE2c59863B738d");
  const a8 = deriveWorkers(8, 0).map((w) => w.address);
  ok("derive(3,5) == derive(8,0)[5..7]", JSON.stringify(deriveWorkers(3, 5).map((w) => w.address)) === JSON.stringify(a8.slice(5, 8)));
  ok("index همراه آفست", deriveWorkers(2, 5).every((w, i) => w.index === 5 + i));
}

// ─── ۲) truthy / numOpt ───
ok("truthy: undefined→false", truthy(undefined) === false);
ok("truthy: 'false'→false", truthy("false") === false);
ok("truthy: '0'→false", truthy("0") === false);
ok("truthy: 'true'→true", truthy("true") === true);
ok("truthy: 1→true", truthy(1) === true);
{ let threw = 0; try { numOpt("abc", 0, { name: "x" }); } catch { threw++; } ok("numOpt NaN→throw", threw === 1); }
{ let threw = 0; try { numOpt("200", 0, { max: 100, name: "x" }); } catch { threw++; } ok("numOpt خارج بازه→throw", threw === 1); }
ok("numOpt def وقتی undefined", numOpt(undefined, 42, {}) === 42);

// ─── ۳) parseArgs ───
{
  const a = cfg.parseArgs(["--dry-run", "--x=5", "--y", "0.5", "--flag=false"]);
  ok("parseArgs: --dry-run=true", a["dry-run"] === "true");
  ok("parseArgs: --x=5", a.x === "5");
  ok("parseArgs: --y 0.5", a.y === "0.5");
  ok("parseArgs+truthy: --flag=false خاموش است", truthy(a.flag) === false);
}

// ─── ۴) nردبان فروش — پله‌ی آخر = باقی‌مانده (رفع باگ گزارش‌شده) ───
for (const steps of [[16, 16, 16, 16, 16, 20], [45, 45, 10], [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 10, 10]]) {
  const bal = 1_000_000n, toSell = bal; let remaining = toSell, sold = 0n;
  for (let i = 0; i < steps.length; i++) {
    const stepAmt = i === steps.length - 1 ? remaining : (toSell * BigInt(steps[i])) / 100n;
    if (stepAmt === 0n) continue;
    if (stepAmt > remaining) break; // قبلاً همین خطا باعث revert می‌شد
    remaining -= stepAmt; sold += stepAmt;
  }
  ok(`نردبان Σ${steps.length}: پله‌ها هرگز > باقی‌مانده نیستند و کل فروخته می‌شود`, sold === toSell && remaining === 0n);
}

// ─── ۵) estMinOut ───
{
  // فروش: ۱e6 واحد خام × ۱e9 wei/خام × (۱−۸٪) = 9.2e14 wei
  ok("estMinOut فروش", estMinOut(1_000_000n, 1e9, 800) === 920_000_000_000_000n);
  ok("estMinOut بدون قیمت → 0", estMinOut(1_000_000n, null, 800) === 0n);
  ok("estMinOut bps=5000 (۵۰٪)", estMinOut(1000n, 1e9, 5000) === 500_000_000_000n);
}

// ─── ۶) median / fillFactor / مارک مستقل از decimals / نرمال‌سازی ───
ok("median odd/even/empty", median([1, 2, 3]) === 2 && median([1, 2, 3, 4]) === 2.5 && median([]) === null);
{
  const fill = (s, f) => Math.max(0.1, Math.min(1, 1 - s / (2 * f)));
  ok("fill 50%=0.75 | 100%=0.5 | کف 0.1", Math.abs(fill(50, 100) - 0.75) < 1e-12 && Math.abs(fill(100, 100) - 0.5) < 1e-12 && fill(1000, 100) === 0.1);
}
for (const D of [6n, 18n]) {
  const q = 10n ** 18n / 1000n, T = 10n ** D;
  const mark = (Number(1000n * T) * (Number(q) / Number(T))) / 1e18;
  ok(`mark D=${D} == 1.0`, Math.abs(mark - 1) < 1e-9);
}
{
  const total = 3.0; let amt = splitRandom(total, 28).map((x) => Math.max(x, 0.0005));
  const s = amt.reduce((a, b) => a + b, 0); if (s > total) amt = amt.map((x) => (x * total) / s);
  ok("renorm Σ≤total", amt.reduce((a, b) => a + b, 0) <= total + 1e-9 && amt.every((x) => x > 0));
}
for (let t = 0; t < 20; t++) {
  const n = 1 + Math.floor(Math.random() * 28), total = Math.random() * 10;
  const sh = splitRandom(total, n);
  if (!(sh.length === n && sh.every((x) => x > 0) && Math.abs(sh.reduce((a, b) => a + b, 0) - total) < 1e-9)) ok("splitRandom تصادفی", false);
}
ok("splitRandom ۲۰ آزمایش", true);

// ─── ۷) salt نرمال‌سازی / safeName / workerStart / E2E رکورد ───
{
  const { normalizeBytes32 } = lib;
  ok("salt '0x1' (هگز فرد) → 32 بایت", normalizeBytes32("0x1").length === 66 && normalizeBytes32("0x1").endsWith("0001"));
  ok("salt '123' (عددی) → 0x…7b", normalizeBytes32("0x" + BigInt("123").toString(16)).endsWith("007b"));
  ok("salt 64هگز دست‌نخورده", normalizeBytes32("0x" + "ab".repeat(32)) === "0x" + "ab".repeat(32));
  let threw = 0; try { normalizeBytes32("0xXYZ"); } catch { threw++; } ok("salt نامعتبر → throw", threw === 1);
}
{
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "TOKEN";
  ok("safeName path traversal دفع", safeName("../../../../tmp/pwn") === "tmppwn");
  ok("safeName معمولی", safeName("MYT-2_x") === "MYT-2_x");
}
ok("workerStart فلگ>env>۰", (() => { const a = workerStart({ "worker-start": "7" }) === 7; process.env.WORKER_START = "9"; const b = workerStart({}) === 9 && workerStart({ "worker-start": "3" }) === 3; delete process.env.WORKER_START; return a && b && workerStart({}) === 0; })());
{
  const rec = { workerStart: 5, exemptions: deriveWorkers(4, 5).map((w) => w.address) };
  const sim = (rec, args) => { const a = { ...args }; if (a["worker-start"] === undefined && rec.workerStart !== undefined) a["worker-start"] = String(rec.workerStart); return workerStart(a); };
  const recips = deriveWorkers(4, sim(rec, {})).map((w) => w.address);
  ok("E2E: recipients == exemptions رکورد (پس از ترتیب اصلاح‌شده)", JSON.stringify(recips) === JSON.stringify(rec.exemptions));
  ok("E2E: فلگ بر رکورد غلبه دارد", sim(rec, { "worker-start": "9" }) === 9);
}

// ─── ۸) حذف تکراری recipient + چک زیرمجموعه ───
{
  const list = ["0xA", "0xa", "0xB"];
  const seen = new Set(); const out = list.filter((r) => { const k = r.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  ok("dedupe (case-insensitive)", out.length === 2);
  const exSet = new Set(["0x1", "0x2"]);
  const extra = ["0x1", "0x9"].filter((r) => !exSet.has(r.toLowerCase()));
  ok("subset check: 0x9 خارج است", extra.length === 1 && extra[0] === "0x9");
}

// ─── ۹) ABI گراف: تاپیک‌ها و سلکتورها ───
{
  const { Interface, id } = await import("ethers");
  const ci = new Interface(abis.BONDING_CURVE_ABI);
  ok("CurveBuy topic تعریف‌شده", typeof ci.getEvent("CurveBuy").topicHash === "string");
  ok("sell selector درست", ci.encodeFunctionData("sell", [10n, 0n, "0x0000000000000000000000000000000000000001"]).slice(0, 10) === id("sell(uint256,uint256,address)").slice(0, 10));
  const lab = new Interface(abis.LAUNCH_AND_BUY_ABI);
  ok("launchAndBuy قابل انکود است", lab.encodeFunctionData("launchAndBuy", [
    { name: "N", symbol: "S", logo: "", description: "", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }, creatorFeeRecipient: "0x000000000000000000000000000000000000dEaD", creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: "0x" + "0".repeat(64), salt: "0x" + "0".repeat(64) },
    0, "0x0000000000000000000000000000000000000000", 0n, 0n, "0x000000000000000000000000000000000000dEaD", [],
  ]).startsWith("0x"));
}

// ─── ۱۰) isAddress و formatUnits ───
ok("isAddress", isAddress("0xe33e9e479df8802cb0866d5d05258bec4cf62948") && !isAddress("0xGGGG") && !isAddress("0x1234"));
ok("formatUnits", formatUnits(parseUnits("1234.5", 6), 6) === "1234.5");

console.log(`\n————— نتیجه: ${pass} PASS، ${fail} FAIL —————`);
process.exit(fail > 0 ? 1 : 0);
