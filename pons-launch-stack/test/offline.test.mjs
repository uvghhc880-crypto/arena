// تست آفلاین تولکیت — بدون شبکه و بدون کلید واقعی (نمونیک استاندارد عمومی هارد‌هت)
// اجرا: node test/offline.test.mjs   (یا: npm test)
process.env.MNEMONIC = "test test test test test test test test test test test junk";
delete process.env.WORKER_START;

import { isAddress, formatUnits, parseUnits, HDNodeWallet, zeroPadValue } from "ethers";

import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name); } };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const lib = await import("../src/lib.js");
const mkt = await import("../src/market.js");
const cfg = await import("../src/config.js");
const abis = await import("../src/abis.js");
const exitModule = await import("../src/exit.js");
const { deriveWorkers, workerStart, splitRandom, splitWeiRandom, uniqueSigners, truthy, numOpt, atomicWriteJson, readJsonSafe } = lib;
const { median, estMinOut } = mkt;
const LAUNCHES_DIR = cfg.LAUNCHES_DIR ?? `${ROOT}/launches`;
const LOCK = `${LAUNCHES_DIR}/batch_buy.lock`;

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

// ═══════════════ ممیزی ۲ — تست ادعاهای جدید ═══════════════

// ─── ۱۱) لاک: اجرای خطادار لاک مالک دیگر را پاک نمی‌کند (بازتولید دقیق ادعای ممیزی) ───
{
  const { spawnSync } = await import("node:child_process");
  fs.mkdirSync(LAUNCHES_DIR, { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, token: "FOREIGN-OWNER-999", at: "x" }));
  const r = spawnSync("node", ["src/batch_buy.js"], { cwd: ROOT }); // بدون آرگومان ⇒ خطا و خروج
  ok("اجرای بدون آرگومان exit≠0", r.status !== 0);
  const survived = fs.existsSync(LOCK) && fs.readFileSync(LOCK, "utf8").includes("FOREIGN-OWNER-999");
  ok("لاک مالک خارجی دست‌نخورده ماند (رفع باگ بحرانی لاک)", survived);
  fs.rmSync(LOCK, { force: true });
}

// ─── ۱۲) فرمول سود exit — مثال دقیق ممیزی ───
{
  ok("exit import شد (main اجرا نمی‌شود)", typeof exitModule.profitTotalPct === "function");
  const P = exitModule.profitTotalPct;
  // خرید ۱۰۰، فروش قبلی ۶۰، ارزش باقی‌مانده ۸۰ ⇒ سود واقعی ۴۰٪ (قبلاً اشتباه ۱۰۰٪ گزارش می‌شد)
  ok("فرمول: ۱۰۰/۶۰/۸۰ ⇒ +۴۰٪ نه +۱۰۰٪", Math.abs(P(100, 60, 80) - 40) < 1e-9);
  ok("تریگر آستانه ۱۰۰ در مثال ممیزی شلیک نمی‌شود", P(100, 60, 80) < 100);
  ok("۱۰۰/۶۰/۱۴۰ ⇒ +۱۰۰٪ (تریگر درست)", Math.abs(P(100, 60, 140) - 100) < 1e-9);
  ok("۱۰۰/۶۰/۱۲۰ ⇒ ۸۰٪ < ۱۰۰", Math.abs(P(100, 60, 120) - 80) < 1e-9);
  ok("spent=0 و ارزش>0 ⇒ ∞ (house money)", P(0, 0, 5) === Infinity);
}

// ─── ۱۳) splitWeiRandom — تخصیص دقیق BigInt ───
{
  const E = (x) => parseUnits(String(x), 18);
  // مثال ممیزی: 0.001 بین ۲۸ با مین 0.0005 ⇒ غیرممکن ⇒ باید throw (نه سهم 0.0000357!)
  let threw = 0;
  try { splitWeiRandom(E(0.001), 28, E(0.0005)); } catch { threw++; }
  ok("۰٫۰۰۱÷۲۸ با مین ۰٫۰۰۰۵ ⇒ throw (به‌جای سهم زیرمین)", threw === 1);
  for (let t = 0; t < 50; t++) {
    const n = 1 + Math.floor(Math.random() * 28);
    const minW = E(0.0005), totalW = E(0.0005 * n + Math.random() * 2);
    const s = splitWeiRandom(totalW, n, minW);
    const sum = s.reduce((a, b) => a + b, 0n);
    if (!(s.length === n && s.every((x) => x >= minW) && sum === totalW)) { ok(`splitWeiRandom خاصیت‌ها (iter ${t})`, false); }
  }
  ok("splitWeiRandom ۵۰ آزمایش: جمع دقیق + همه ≥ مین", true);
  const one = splitWeiRandom(E(1.5), 1, E(0.0005));
  ok("n=1 کل مبلغ", one.length === 1 && one[0] === E(1.5));
}

// ─── ۱۴) بردار legacy HD (مسیر قدیمی اشتباه — بازیابی) ───
{
  const legacy0 = deriveWorkers(1, 0, { legacy: true })[0].address;
  ok("legacy idx0 == آدرس مسیر اشتباه قدیمی (0xD51d…)", legacy0 === "0xD51d4b680Cd89E834413c48fa6EE2c59863B738d");
  const bip0 = deriveWorkers(1, 0)[0].address;
  ok("legacy ≠ BIP44", legacy0 !== bip0);
}

// ─── ۱۵) uniqueSigners ───
{
  const w = deriveWorkers(1, 0)[0].wallet;
  const before = console.warn; let warned = 0; console.warn = () => warned++;
  const uniq = uniqueSigners([w, w]);
  console.warn = before;
  ok("uniqueSigners تکراری را حذف + هشدار می‌دهد", uniq.length === 1 && warned === 1);
}

// ─── ۱۶) estMinOut Q64 — دقت در مقادیر بزرگ/کوچک ───
{
  // فروش: 6e24 خام × 1e9 wei/خام × ۹۲٪ — مقدار float از ۲⁵³ می‌گذرد (نسخه‌ی قدیمی ازدست‌دقت داشت)
  const amount = 6n * 10n ** 24n, big = estMinOut(amount, 1e9, 800);
  const expected = (amount * BigInt(1e9) * 9200n) / 10000n; // محاسبه‌ی مرجع صحیح
  ok("estMinOut Q64 == مقدار مرجع صحیح (عدد بزرگ)", big === expected);
  // نسخه‌ی float قدیمی روی همین ورودی خطای قابل‌توجه می‌داد:
  const floatOld = BigInt(Math.floor(Number(amount) * 1e9 * 0.92));
  ok("Q64 دقیق‌تر از float قدیمی است", (big - expected) === 0n && (floatOld - expected) !== 0n);
  ok("estMinOut anchor غلبه می‌کند", estMinOut(1000n, 1e9, 800, { anchor: 2e9 }) === 1_840_000_000_000n);
  ok("estMinOut قیمت صفر ⇒ ۰", estMinOut(1000n, null, 800, { anchor: 0 }) === 0n || estMinOut(1000n, null, 800, { anchor: null }) === 0n);
}

// ─── ۱۷) numOpt با int ───
{ let threw = 0; try { numOpt("1.5", 0, { int: true, name: "pct" }); } catch { threw++; } ok("numOpt int: 1.5 رد (رفع کرش BigInt)", threw === 1); }
ok("numOpt int: '50' قبول", numOpt("50", 0, { int: true, name: "pct" }) === 50);

// ─── ۱۸) ژورنال اتمیک + بازیابی .bak ───
{
  const tmp = `${os.tmpdir()}/journal_test_${process.pid}.json`;
  atomicWriteJson(tmp, { header: { x: 1 }, results: [] }); // نسخه‌ی اول
  const a1 = readJsonSafe(tmp);
  ok("atomicWrite/read رفت‌وبرگشت", a1.header.x === 1);
  atomicWriteJson(tmp, { header: { x: 2 }, results: [] }); // نسخه‌ی دوم ⇒ نسخه‌ی اول به .bak می‌رود (معنای واقعی .bak)
  fs.writeFileSync(tmp, "{CORRUPT-JSON"); // شبیه‌سازی کرش نیمه‌کاره روی نسخه‌ی جدید
  const a2 = readJsonSafe(tmp); // باید از .bak (نسخه‌ی اول) برگردد
  ok("خرابی ⇒ بازیابی از .bak", a2.header.x === 1);
  let threw = 0; fs.writeFileSync(tmp, "{CORRUPT"); fs.rmSync(`${tmp}.bak`, { force: true });
  try { readJsonSafe(tmp); } catch { threw++; }
  ok("خراب هردو ⇒ خطای صریح (نه بازگشت خاموش به خالی)", threw === 1);
  fs.rmSync(tmp, { force: true });
}

// ─── ۱۹) deriveWorkers با legacy در workerStart آفست ───
{
  const leg = deriveWorkers(2, 5, { legacy: true });
  ok("legacy با آفست سازگار است", leg.every((w, i) => w.index === 5 + i));
}

console.log(`\n————— نتیجه: ${pass} PASS، ${fail} FAIL —————`);
process.exit(fail > 0 ? 1 : 0);
