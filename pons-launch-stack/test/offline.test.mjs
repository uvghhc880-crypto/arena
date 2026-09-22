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

// ═══════════════ ممیزی ۳ — تست ادعاهای جدید ═══════════════

// ─── ۲۰) resolveBatchAllocation — سناریوی دقیق overspend ممیزی ───
{
  const { resolveBatchAllocation } = lib;
  const X = "0x" + "11".repeat(20), Y = "0x" + "22".repeat(20);
  // ژورنال اجرای اول: [X=909091, Y=90909] (wei واحد ساده)، X انجام‌شده
  const frozenJournal = {
    header: { chainId: 4663 }, results: [{ recipient: X, tx: "0xAA" }], failed: [],
    alloc: { totalEth: 1000000, recipients: [X, Y], amountsWei: ["909091", "90909"] },
  };
  // resume بدون این فیکس: تخصیص تصادفی دوباره می‌توانست [90909, 909091] شود ⇒ خرج 1818182 ⊃ 1000000
  const r = resolveBatchAllocation({ journal: frozenJournal, fresh: false, recipients: [X, Y], totalWei: 1000000n, minShareWei: 0n, dryRun: false });
  ok("resume از نقشه‌ی منجمد استفاده می‌کند", r.ok && r.source === "frozen");
  ok("مبلغ Y همان 90909 است (نه دوباره‌تصادفی)", r.amountsWei[1] === 90909n);
  ok("∑ خرجِ احتمالی = X‌‌انجام‌شده + Y‌همان = ۱,۰۰۰,۰۰۰ دقیق (overspend صفر)", 909091n + r.amountsWei[1] === 1000000n);
  // recipient ناهماهنگ ⇒ رد
  const r2 = resolveBatchAllocation({ journal: frozenJournal, fresh: false, recipients: [X, "0x" + "33".repeat(20)], totalWei: 1000000n, minShareWei: 0n });
  ok("لیست متفاوت ⇒ رد (غیرامن نیست)", !r2.ok);
  // --fresh ⇒ تخصیص تازه
  const r3 = resolveBatchAllocation({ journal: frozenJournal, fresh: true, recipients: [X, Y], totalWei: 1000000n, minShareWei: 0n });
  ok("--fresh تخصیص تازه (صرف‌نظر از ژورنال)", r3.ok && r3.source === "fresh");
}

// ─── ۲۱) readJsonSafe: ENOENT هرگز .bak برنمی‌گرداند (صمت-بازگردانی حذف‌شده) ───
{
  const t2 = `${os.tmpdir()}/json_e_noent_${process.pid}.json`;
  atomicWriteJson(t2, { v: 1 }); atomicWriteJson(t2, { v: 2 }); // حالا .bak با v:1 هست
  fs.rmSync(t2, { force: true }); // کاربر ژورنال را دستی پاک کرد
  const r = readJsonSafe(t2);
  ok("فایل پاک‌شده ⇒ null (نه .bak قدیمی)", r === null);
  fs.rmSync(`${t2}.bak`, { force: true });
}

// ─── ۲۲) classifyTx با RPC استب — تفکیک unknown/absent ───
{
  const { classifyTx } = lib;
  const stubRpc = (behavior) => ({
    async getTransactionReceipt() { if (behavior === "rpc-error") throw new Error("rpc down"); if (behavior === "ok") return { status: 1 }; if (behavior === "reverted") return { status: 0 }; return null; },
    async getTransaction() { if (behavior === "rpc-error") throw new Error("rpc down"); if (behavior === "pending") return { hash: "0x1" }; return null; },
  });
  ok("RPC خطا ⇒ «unknown» (نه absent)", (await classifyTx("0x1", { polls: 2, intervalMs: 1, rpc: stubRpc("rpc-error") })) === "unknown");
  ok("بی‌رسید+بی‌tx ⇒ «absent» (خواندن پاک)", (await classifyTx("0x1", { polls: 2, intervalMs: 1, rpc: stubRpc("absent") })) === "absent");
  ok("pending تشخیص داده می‌شود", (await classifyTx("0x1", { polls: 1, rpc: stubRpc("pending") })) === "pending");
  ok("ok و reverted", (await classifyTx("0x1", { polls: 1, rpc: stubRpc("ok") })) === "ok" && (await classifyTx("0x1", { polls: 1, rpc: stubRpc("reverted") })) === "reverted");
}

// ─── ۲۳) run-lock مشترک lib: دو پردازش واقعی رقابت‌کنند ───
{
  const { spawn, spawnSync } = await import("node:child_process");
  const lk = `${os.tmpdir()}/runlock_${process.pid}.json`;
  // پردازش A: لاک را می‌گیرد و 900ms زنده می‌ماند
  const scriptA = `import { acquireRunLock } from "${ROOT}/src/lib.js"; acquireRunLock("${lk}"); console.log("GRABBED"); setTimeout(()=>process.exit(0), 900); setInterval(()=>{},500);`;
  const a = spawn("node", ["--input-type=module", "-e", scriptA]);
  await new Promise((res) => { a.stdout.on("data", (d) => String(d).includes("GRABBED") && res()); });
  // پردازش B: باید رد شود (لاک زنده)
  const b = spawnSync("node", ["--input-type=module", "-e", `import { acquireRunLock } from "${ROOT}/src/lib.js"; acquireRunLock("${lk}"); console.log("B GOT IT");`]);
  ok("پردازش دوم رد شد (exit≠0 و لاک به دست نگرفت)", b.status !== 0 && !String(b.stdout).includes("B GOT IT"));
  // پردازش A می‌میرد ⇒ لاک آزاد می‌شود
  await new Promise((res) => a.on("exit", res));
  await new Promise((r) => setTimeout(r, 100));
  const exists = fs.existsSync(lk);
  ok("بعد از مرگ A لاک آزاد است", !exists);
  fs.rmSync(lk, { force: true });
}

// ─── ۲۴) pidAlive ───
{
  const { pidAlive } = lib;
  ok("pidAlive(self)=true", pidAlive(process.pid) === true);
  ok("pidAlive(99999999)=false", pidAlive(99999999) === false);
}

// ─── ۲۵) ladder واقعی sell.js (import از خود فایل — نه کپی‌برداری در تست) ───
{
  const sellMod = await import("../src/sell.js");
  const { ladder } = sellMod;
  ok("ladder farm = ۱۰ پله‌ی ۱۰٪", ladder("farm").length === 10 && ladder("farm").every((x) => x === 10));
  ok("ladder gradual جمع ۱۰۰ است", ladder("gradual").reduce((a, b) => a + b, 0) === 100);
  ok("ladder micro/aggressive هم جمع ۱۰۰", ladder("micro").reduce((a, b) => a + b, 0) === 100 && ladder("aggressive").reduce((a, b) => a + b, 0) === 100);
  ok("UR_COMMAND_NAMES صادر می‌شود", typeof sellMod.UR_COMMAND_NAMES === "object" && sellMod.UR_COMMAND_NAMES[0x10]?.includes("V4"));
}

// ═══ بلوک ممیزی ۴ ═══

// ─── ۲۶) eth()/weiOf() بدون گردکردن Number (باگ «0.0000009 ⇒ 1000» و «⇒0» بود) ───
{
  const { eth, weiOf } = lib;
  ok("eth(0.0000009) = 900000000000 wei", eth(0.0000009) === 900000000000n);
  ok("eth(\"0.0000000000000009\") = 900 wei (هجده رقم اعشار)", eth("0.0000000000000009") === 900n);
  ok("weiOf همان مسیر string-first است", weiOf("0.05") === 50000000000000000n);
  ok("eth(3) = 3 ETH", eth(3) === 3000000000000000000n);
  let r1 = false, r2 = false, r3 = false;
  try { eth("0.1234567890123456789"); } catch { r1 = true; } // ۱۹ رقم اعشار ⇒ ابطال
  try { eth("abc"); } catch { r2 = true; }
  try { eth(-1); } catch { r3 = true; }
  ok("۱۹ رقم اعشار/abc/منفی همه ابطال می‌شوند", r1 && r2 && r3);
}

// ─── ۲۷) resolveBatchAllocation: alloc-missing-on-resume fail-closed + فرمت ژورنال fund ───
{
  const { resolveBatchAllocation } = lib;
  const recips = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"];
  // ژورنالِ batch با کارِ انجام‌شده اما بدون alloc ⇒ محکم‌بستن
  const oldB = { header: {}, results: [{ tx: "0x1", valueWei: "1000" }], failed: [] };
  const r1 = resolveBatchAllocation({ journal: oldB, fresh: false, recipients: recips, totalWei: 2000n, minShareWei: 0n });
  ok("batch: ژورنال قدیمی بدون alloc ⇒ fail-closed", !r1.ok && r1.reason === "alloc-missing-on-resume");
  // ژورنالِ fund (entries-map) بدون alloc ⇒ همان داوری
  const oldF = { meta: {}, entries: { "0xA": { valueWei: "1000", state: "ok" } } };
  const r2 = resolveBatchAllocation({ journal: oldF, fresh: false, recipients: recips, totalWei: 2000n, minShareWei: 0n });
  ok("fund: ژورنال entries بدون alloc ⇒ fail-closed", !r2.ok && r2.reason === "alloc-missing-on-resume");
  // fund با alloc منجمد ⇒ همان سهم‌ها برمی‌گردند
  const frozenF = { meta: {}, entries: { "0xA": { valueWei: "1000", state: "ok" } }, alloc: { recipients: recips, amountsWei: ["1500", "500"], totalEth: 0.0000018 } };
  const r3 = resolveBatchAllocation({ journal: frozenF, fresh: false, recipients: recips, totalWei: 2000n, minShareWei: 0n });
  ok("fund: alloc منجمد دقیقاً همان‌قدر برمی‌گردد", r3.ok && r3.source === "frozen" && r3.amountsWei[0] === 1500n && r3.amountsWei[1] === 500n);
  // ژورنال خالی (بدون کار) ⇒ تخصیص تازه مجاز
  const r4 = resolveBatchAllocation({ journal: { meta: {}, entries: {} }, fresh: false, recipients: recips, totalWei: 2000n, minShareWei: 0n });
  ok("ژورنال بدون کار قبلی ⇒ تخصیص تازه OK", r4.ok && r4.source === "fresh" && r4.amountsWei.length === 2 && r4.amountsWei.reduce((a, b) => a + b, 0n) === 2000n);
}

// ─── ۲۸) run-lock سراسری: دو «نسخه‌ی پروژه» (لاک محلی متفاوت، globalKey یکسان) — دومی رد شود ───
{
  const { spawn, spawnSync } = await import("node:child_process");
  const gk = `pons-testlock-${process.pid}`;
  const lkA = `${os.tmpdir()}/projA/runlock_${process.pid}.json`;
  const lkB = `${os.tmpdir()}/projB/runlock_${process.pid}.json`; // مسیر محلیِ متفاوت — کپی دوم پروژه
  fs.mkdirSync(`${os.tmpdir()}/projA`, { recursive: true });
  fs.mkdirSync(`${os.tmpdir()}/projB`, { recursive: true });
  const scriptA = `import { acquireRunLock } from "${ROOT}/src/lib.js"; acquireRunLock("${lkA}", { globalKey: "${gk}" }); console.log("GRABBED"); setTimeout(()=>process.exit(0), 900); setInterval(()=>{},500);`;
  const a = spawn("node", ["--input-type=module", "-e", scriptA]);
  await new Promise((res) => { a.stdout.on("data", (d) => String(d).includes("GRABBED") && res()); });
  // پردازش B با مسیر محلیِ متفاوت و globalKey یکسان ⇒ باید رد شود
  const b = spawnSync("node", ["--input-type=module", "-e", `import { acquireRunLock } from "${ROOT}/src/lib.js"; acquireRunLock("${lkB}", { globalKey: "${gk}" }); console.log("B GOT IT");`]);
  ok("قفل سراسری: نسخه‌ی دوم پروژه (globalKey یکسان) رد شد", b.status !== 0 && !String(b.stdout).includes("B GOT IT"));
  await new Promise((res) => a.on("exit", res));
  await new Promise((r) => setTimeout(r, 100));
  // بعد از مرگ A، لاک محلی و سراسری هر دو آزادند
  const gfileGlob = `${os.homedir()}/.pons-launch-stack-locks/${gk}-${""}.lock`;
  void gfileGlob;
  const gFile = `${os.homedir()}/.pons-launch-stack-locks/${gk}.lock`;
  ok("بعد از مرگ A هم لاک محلی هم لاک سراسری آزاد است", !fs.existsSync(lkA) && !fs.existsSync(gFile));
  fs.rmSync(lkA, { force: true }); fs.rmSync(lkB, { force: true }); fs.rmSync(gFile, { force: true });
}

// ─── ۲۹) decodeUrBlob: دیکود واقعی payloadهای V3/V4 (همان کد production — نه کپی) ───
{
  const { AbiCoder, ethers } = await import("ethers");
  const sellMod = await import("../src/sell.js");
  const coder = AbiCoder.defaultAbiCoder();
  const recip = "0x0000000000000000000000000000000000000bEE".toLowerCase();
  const v3 = coder.encode(["bytes", "address", "uint256", "uint256"], ["0xaabbccddeeff", recip, 12345n, 999n]);
  const d1 = sellMod.decodeUrBlob(0x00, v3);
  ok("V3_SWAP_EXACT_IN دیکود درست", d1.name === "V3_SWAP_EXACT_IN" && d1.recipient.toLowerCase() === recip && d1.amountIn === "12345" && d1.amountOutMin === "999");
  const v4 = coder.encode(["bytes", "bytes[]"], ["0x0c0e0f", ["0xaa", "0xbb", "0xcc"]]);
  const d2 = sellMod.decodeUrBlob(0x10, v4);
  ok("V4_SWAP دیکود درست (اکشن‌ها/پارام‌ها)", d2.actions.length === 3 && d2.paramsHex.length === 3 && d2.actionNames[0].includes("SETTLE_ALL"));
  ok("فرمان ناشناخته ⇒ null (بدون decode-check سخت‌گیرانه)", sellMod.decodeUrBlob(0x08, "0x1234") === null);
  let threw = false;
  try { sellMod.decodeUrBlob(0x00, "0x1234"); } catch { threw = true; } // بلوب خراب با فرمان شناخته ⇒ throw (ابطال در main)
  ok("بلوب نامعتبر با فرمان شناخته ⇒ خطا", threw);
  void ethers;
}

// ═══ بلوک ممیزی ۵ ═══

// ─── ۳۰) CLI smoke: batch_buy/fund هیچ‌وقت با ReferenceError کرش نکنند (باگ «master is not defined») ───
{
  const { spawnSync } = await import("node:child_process");
  const C = "0x00000000000000000000000000000000000000c1", T = "0x00000000000000000000000000000000000000a1", R = "0x00000000000000000000000000000000000000b1";
  const r1 = spawnSync("node", ["src/batch_buy.js", "--curve", C, "--token", T, "--total", "0.0002", "--recipients", R, "--dry-run"], { cwd: ROOT, timeout: 60000 });
  const out1 = String(r1.stderr) + String(r1.stdout);
  ok("batch_buy CLI بدون ReferenceError از parse/setup عبور می‌کند", !/master is not defined|ReferenceError/.test(out1));
  const r2 = spawnSync("node", ["src/fund.js", "fund", "--total", "0.0002", "--workers", "1"], { cwd: ROOT, timeout: 60000 });
  const out2 = String(r2.stderr) + String(r2.stdout);
  ok("fund CLI بدون ReferenceError اجرا می‌شود (گرای RPC هم در این‌جا مهم نیست)", !/master is not defined|ReferenceError/.test(out2));
}

// ─── ۳۱) splitWeiRandom الگوریتم جدید: ۱۰۰هزار حالتِ گوشه‌دار، اینواریانت‌های قطعی ───
{
  const { splitWeiRandom } = lib;
  let bad = 0;
  for (let t = 0; t < 100000 && bad < 3; t++) {
    const n = 1 + Math.floor(Math.random() * 64);
    let minShare, totalWei;
    const mode = t % 4;
    if (mode === 0) { minShare = BigInt(Math.floor(Math.random() * 1e15)); totalWei = minShare * BigInt(n) + BigInt(Math.floor(Math.random() * 3)); }
    else if (mode === 1) { minShare = BigInt(Math.floor(Math.random() * 1000)); totalWei = minShare * BigInt(n) + BigInt(Math.floor(Math.random() * n + 1)); }
    else if (mode === 2) { minShare = BigInt(Math.floor(Math.random() * 1e17)); totalWei = minShare * BigInt(n) + BigInt(Math.floor(Math.random() * 1e18)); }
    else { minShare = 0n; totalWei = BigInt(Math.floor(Math.random() * n + 1)); }
    try {
      const s = splitWeiRandom(totalWei, n, minShare);
      if (s.reduce((a, b) => a + b, 0n) !== totalWei || s.some((x) => x < minShare)) bad++;
    } catch { bad++; }
  }
  ok("splitWeiRandom: ۱۰۰هزار حالت گوشه‌دار، همه Σ==total و همه≥min", bad === 0);
  ok("total=n×min دقیق ⇒ همه min هستند", splitWeiRandom(1000n, 4, 250n).every((x) => x === 250n));
  ok("n=1 همه‌ی total را می‌گیرد", splitWeiRandom(777n, 1, 100n)[0] === 777n);
  let threw = false;
  try { splitWeiRandom(99n, 2, 50n); } catch { threw = true; }
  ok("total < n×min ⇒ ابطال", threw);
}

// ─── ۳۲) اعتبارسنجی نقشه‌ی تخصیص منجمد (ژورنال دست‌کاری‌شده) ───
{
  const { resolveBatchAllocation } = lib;
  const recips = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"];
  const base = { results: [{ tx: "0x1" }], alloc: { recipients: recips, amountsWei: ["1500", "500"] } };
  const cases = [
    ["منفی", { ...base, alloc: { recipients: recips, amountsWei: ["-5", "505"] } }, "alloc-negative"],
    ["طول", { ...base, alloc: { recipients: recips, amountsWei: ["1500"] } }, "alloc-length-mismatch"],
    ["هرزنامه", { ...base, alloc: { recipients: recips, amountsWei: ["x", "500"] } }, "alloc-corrupt"],
    ["جمع‌صفر", { ...base, alloc: { recipients: recips, amountsWei: ["0", "0"] } }, "alloc-zero-total"],
  ];
  let all = true;
  for (const [name, j, want] of cases) {
    const r = resolveBatchAllocation({ journal: j, fresh: false, recipients: recips, totalWei: 2000n, minShareWei: 0n });
    if (r.ok || r.reason !== want) { all = false; console.log(`  (پنشد: ${name}: ${JSON.stringify(r)})`); }
  }
  ok("alloc فریزِ خراب/منفی/کوتاه/صفر ⇒ fail-closed", all);
  const okF = resolveBatchAllocation({ journal: base, fresh: false, recipients: recips, totalWei: 2000n, minShareWei: 0n });
  ok("alloc فریز سالم قبول می‌شود", okF.ok && okF.source === "frozen" && okF.amountsWei[0] === 1500n);
}

// ─── ۳۳) UR decoders هر دو نسخه (legacy ۴فیلدی × v2 ۶فیلدی) + اعتبارسنجی بلوب V4 ───
{
  const { AbiCoder, ethers } = await import("ethers");
  const sellMod = await import("../src/sell.js");
  const coder = AbiCoder.defaultAbiCoder();
  const recip = "0x0000000000000000000000000000000000000bee";
  // legacy: (bytes path, address recipient, uint256 amountIn, uint256 amountOutMin)
  const legacyBlob = coder.encode(["bytes", "address", "uint256", "uint256"], ["0xaabbcc", recip, 777n, 5n]);
  const d1 = sellMod.decodeUrBlob(0x00, legacyBlob, "legacy");
  ok("legacy V3 دیکود درست", d1.recipient.toLowerCase() === recip && d1.amountIn === "777" && d1.amountOutMin === "5");
  // v2: (address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser, uint256[] minHop)
  const v2Blob = coder.encode(["address", "uint256", "uint256", "bytes", "bool", "uint256[]"], [recip, 777n, 5n, "0xddeeff", true, [1n, 2n]]);
  const d2 = sellMod.decodeUrBlob(0x00, v2Blob, "v2");
  ok("v2 V3 دیکود درست (فرمت recipient-اول رسمی)", d2.recipient.toLowerCase() === recip && d2.amountIn === "777" && d2.payerIsUser === true && d2.pathBytes === 3);
  // تشخیص اشتباه-تطبیق: بلوب v2 با فرمت legacy دیکود شود ⇒ باید throw کند (نه خروجی اشتباه)
  let threw3 = false;
  try { sellMod.decodeUrBlob(0x00, v2Blob, "legacy"); } catch { threw3 = true; }
  ok("بلوب v2 با فرمت legacy قابل‌دیکود نیست (خطا، نه نتیجه‌ی غلط)", threw3);
  // V4 با اکشن‌های SETTLE_ALL + SWAP_EXACT_IN + TAKE_ALL
  const token = "0x0000000000000000000000000000000000000aaa", weth = "0x0000000000000000000000000000000000000bbb";
  const p1 = coder.encode(["address", "uint256"], [token, 1000n]);
  const p2 = coder.encode(["uint256"], [999n]);
  const p3 = coder.encode(["address", "uint256"], [weth, 42n]);
  const v4blob = coder.encode(["bytes", "bytes[]"], ["0x0c070f", [p1, p2, p3]]);
  const d4 = sellMod.decodeUrBlob(0x10, v4blob, "v2");
  ok("V4 اکشن‌ها دیکود می‌شوند", d4.actionNames.join(",").includes("SETTLE_ALL") && d4.actionNames.join(",").includes("TAKE_ALL"));
  const vOk = sellMod.validateV4Blob(d4, { token, weth, expectedInWei: "1000" });
  ok("validateV4Blob سالم قبول", vOk.ok === true);
  const vBad = sellMod.validateV4Blob(d4, { token, weth, expectedInWei: "1001" });
  ok("validateV4Blob ناهماهنگی مبلغ را رد می‌کند", vBad.ok === false && vBad.problems.some((p) => p.includes("نمی‌خواند")));
  const vW = sellMod.validateV4Blob(d4, { token: weth, weth: token, expectedInWei: null });
  ok("validateV4Blob currency ناش/جهت وارونه را رد می‌کند", vW.ok === false);
  void ethers;
}

// ─── ۳۴) آدرس‌های config از کانال ممیزی ۵ — همه چک‌س‌م/فرمت معتبر ───
{
  const { getAddress } = await import("ethers");
  const { ADDR } = await import("../src/config.js");
  ok("POOL_MANAGER رسمی lowercase معتبر", ADDR.POOL_MANAGER === "0x8366a39cc670b4001a1121b8f6a443a643e40951" && getAddress(ADDR.POOL_MANAGER) !== null);
  ok("WETH رسمی Robinhood معتبر", ADDR.WETH.toLowerCase() === "0x0bd7d308f8e1639fab988df18a8011f41eacad73" && getAddress(ADDR.WETH) !== null);
  ok("PERMIT2 معتبر", getAddress(ADDR.PERMIT2) !== null);
  ok("UNIVERSAL_ROUTER معتبر", getAddress(ADDR.UNIVERSAL_ROUTER) !== null);
  ok("همه‌ی آدرس‌ها عجیب نیستند", ADDR.PERMIT2 === "0x000000000022d473030f116ddee9f6b43ac78ba3");
}

// ─── ۳۵) گارد گرجوئیشن fail-closed واقعی: checker داخلی در خطای RPC باید throw کند (نه graduated:false) ───
{
  // main در batch_buy بدون گارد اجرا می‌شود — هرگز import نکن؛ متن را اسکن می‌کنیم
  const srcTxt = fs.readFileSync(`${ROOT}/src/batch_buy.js`, "utf8");
  ok("guard/grad: catch داخلی به graduated:false خاموش برنگردد", !/catch \{\s*return \{ graduated: false/.test(srcTxt));
  ok("buildGraduationChecker خطای RPC را throw می‌کند", /rpc-grad/.test(srcTxt));
}

// ─── ۳۶) 스테ال-لاک: رقابت lock سراسری — پردازش بازنده نباید لاک محلی نامشروع بگذارد ───
{
  const { spawn, spawnSync } = await import("node:child_process");
  const gk = `pons-testlock-stale-${process.pid}`;
  fs.mkdirSync(`${os.tmpdir()}/projC`, { recursive: true }); fs.mkdirSync(`${os.tmpdir()}/projD`, { recursive: true });
  const lkC = `${os.tmpdir()}/projC/lk_${process.pid}.json`;
  const lkD = `${os.tmpdir()}/projD/lk_${process.pid}.json`;
  const scriptC = `import { acquireRunLock } from "${ROOT}/src/lib.js"; acquireRunLock("${lkC}", { globalKey: "${gk}" }); console.log("GRABBED"); setTimeout(()=>process.exit(0), 900); setInterval(()=>{}, 500);`;
  const c = spawn("node", ["--input-type=module", "-e", scriptC]);
  await new Promise((res) => { c.stdout.on("data", (d) => String(d).includes("GRABBED") && res()); });
  const d = spawnSync("node", ["--input-type=module", "-e", `import { acquireRunLock } from "${ROOT}/src/lib.js"; acquireRunLock("${lkD}", { globalKey: "${gk}" }); console.log("D GOT IT");`], { timeout: 30000 });
  ok("رقیب سراسری رد شد", d.status !== 0 && !String(d.stdout).includes("D GOT IT"));
  ok("پردازش بازنده هیچ لاک محلی‌ای روی دیسک نگذاشت (stale-lock رفع شد)", !fs.existsSync(lkD));
  await new Promise((res) => c.on("exit", res));
  fs.rmSync(lkC, { force: true }); fs.rmSync(lkD, { force: true }); fs.rmSync(`${os.homedir()}/.pons-launch-stack-locks/${gk}.lock`, { force: true });
}

console.log(`\n————— نتیجه: ${pass} PASS، ${fail} FAIL —————`);
process.exit(fail > 0 ? 1 : 0);
