// خرید باندلی «یک‌جا بخر، پخش کن» — الگوی فارم: یک ولت پرداخت‌کننده، توکن برای همه‌ی ولت‌های معاف
// + دیده‌بان خرید خارجی: رد آستانه → توقف باندل + خروج موازی کامل (پیش‌فرض روشن: کریتور+bاندل‌هایِ دارای‌کلید)
// + توقف خودکار در گرجوئیشن (پیش‌فرض روشن)
// + تخصیص دقیق BigInt که در ژورنال «منجمد» می‌شود — resume هرگز نقشه‌ی تخصیص اولیه را عوض نمی‌کند (ثابت شد: وگرنه خارج از total خرج می‌شد)
// + ژورنال اتمیک resume/idempotent با وضعیت‌های tx: ok/reverted/pending/unknown — تراکنش در تعلیق ابتدا تعیین‌تکلیف می‌شود؛
//   خطای RPC هرگز «absent» ترجمه نمی‌شود (ممنوعیت ارسال تکراری)
// + run-lock مالکیت‌دار اتمیک مشترک (lib) — --force فقط وقتی PID مالک مرده باشد
// نکته‌ی طراحی: خریدها عمداً ترتیبی‌اند — قبل از هر ارسال شبیه‌سازی + چک گارد می‌آید.
import fs from "node:fs";
import { Contract, Interface, Wallet, id, isAddress, formatUnits } from "ethers";
import { ADDR, CHAIN, LAUNCHES_DIR, env, parseArgs } from "./config.js";
import { BONDING_CURVE_ABI, ERC20_ABI } from "./abis.js";
import { provider, masterWallet, deriveWorkers, workerStart, truthy, numOpt, fmt, gasPrice, weiOf, resolveBatchAllocation, nowTag, sleep, atomicWriteJson, readJsonSafe, classifyTx, acquireRunLock, releaseRunLock, assertContract } from "./lib.js";
import { panicSellAll, marketPrice, estMinOut } from "./market.js";

const MIN_BUY_ETH = 0.0005;
const LOCK_FILE = `${LAUNCHES_DIR}/batch_buy.lock`;

// ولت پرداخت‌کننده: BATCH_PAYER_PRIVATE_KEY در .env، وگرنه --payer-index از نمونیک، وگرنه مستر
function payerWallet(a) {
  const pk = env("BATCH_PAYER_PRIVATE_KEY");
  if (pk) return new Wallet(pk, provider);
  if (a["payer-index"] !== undefined) {
    const idx = Number(a["payer-index"]);
    return deriveWorkers(1, idx)[0].wallet;
  }
  return masterWallet();
}

function readRecipients(a) {
  if (a.recipients) return a.recipients.split(",").map((s) => s.trim()).filter(Boolean);
  if (a["recipients-file"]) {
    return fs.readFileSync(a["recipients-file"], "utf8").split(/[\r\n,]+/).map((s) => s.trim()).filter((s) => s.startsWith("0x"));
  }
  if (a.workers) {
    const n = Number(a.workers), s = workerStart(a);
    return deriveWorkers(n, s).map((w) => w.address);
  }
  const wc = Number(env("WORKER_COUNT", "28"));
  try { return deriveWorkers(wc, workerStart(a)).map((w) => w.address); } catch { return null; }
}

// ---------------- دیده‌بان خرید خارجی (اسکن افزایشی — ضد ریت‌لیمیت RPC) ----------------
const curveIface = new Interface(BONDING_CURVE_ABI);
const CURVE_BUY_TOPIC = curveIface.getEvent("CurveBuy").topicHash;
const REORG_DEPTH = 2n; // اسکن هر بار از ۲ بلاک عقب‌تر — نقش‌شده‌های در reorg دوباره دیده می‌شوند (با dedupe)

// حالت انباشته‌ (windowBlocks=0): هر چک فقط بلاک‌های جدید؛ reorg با dedupe بر اساس (txHash,logIndex).
// حالت پنجره‌ای (windowBlocks>0): کامل اسکن — reorg به‌طور طبیعی هندل می‌شود.
class ExternalGuard {
  constructor(curveAddr, fromBlock, selfSet, { minTxWei = 0n, windowBlocks = 0, soft = false } = {}) {
    this.curveAddr = curveAddr; this.selfSet = selfSet;
    this.minTxWei = minTxWei; this.windowBlocks = windowBlocks;
    this.base = fromBlock;
    this.nextFrom = fromBlock;
    this.confirmedCum = 0n; // فقط برای بلاک‌های تثبیت‌شده (قدیمی‌تر از REORG) — هر بلاک دقیقاً یک‌بار
    this.errors = 0; this.soft = soft;
  }
  classify(lg) {
    try {
      const ev = curveIface.parseLog({ topics: lg.topics, data: lg.data });
      const rec = ev.args.recipient.toLowerCase();
      const q = BigInt(ev.args.quoteIn);
      return (!this.selfSet.has(rec) && q >= this.minTxWei) ? q : null;
    } catch { return null; }
  }
  async scan() {
    const latest = await provider.getBlockNumber();
    if (this.windowBlocks > 0) {
      const floor = Math.max(this.base, latest - this.windowBlocks);
      const logs = await provider.getLogs({ address: this.curveAddr, topics: [CURVE_BUY_TOPIC], fromBlock: floor, toBlock: "latest" });
      let ext = 0n;
      for (const lg of logs) { const q = this.classify(lg); if (q) ext += q; }
      return ext;
    }
    // انباشتهٔ reorg-safe واقعی (ممیزی ۴): دو لایه‌ی «تثبیت‌شده» و «جدید»
    //   tier-confirmed: بلاک‌های قدیمی‌تر از REORG_DEPTH — یک‌بار پردازش می‌شوند و برای همیشه در confirmedCum می‌مانند
    //   tier-recent: چند بلاک آخر — در «هر اسکن» از نو خوانده و از نو جمع می‌شوند (stateless)؛ orphan شدن‌شان هیچ اثری روی مجموع نمی‌گذارد
    const REORG_N = Number(REORG_DEPTH);
    const confirmUpto = latest - REORG_N;
    // لایه‌ی تثبیت‌شده: جلو می‌رویم تا سقف confirmUpto
    if (this.nextFrom <= confirmUpto) {
      const logsA = await provider.getLogs({ address: this.curveAddr, topics: [CURVE_BUY_TOPIC], fromBlock: this.nextFrom, toBlock: confirmUpto });
      for (const lg of logsA) { const q = this.classify(lg); if (q) this.confirmedCum += q; }
      this.nextFrom = confirmUpto + 1;
    }
    // لایه‌ی جدید: از ٔسقف+۱ تا latest — هر اسکن کامل از نو
    let recent = 0n;
    const bFrom = Math.max(this.base, this.nextFrom);
    if (bFrom <= latest) {
      const logsB = await provider.getLogs({ address: this.curveAddr, topics: [CURVE_BUY_TOPIC], fromBlock: bFrom, toBlock: latest });
      for (const lg of logsB) { const q = this.classify(lg); if (q) recent += q; }
    }
    return this.confirmedCum + recent;
  }
}

async function resolveFromBlock(a, { quiet = false } = {}) {
  if (a["launch-tx"]) {
    let rc = null;
    try {
      rc = await provider.getTransactionReceipt(a["launch-tx"]);
    } catch (e) {
      // ممیزی ۴: خطای RPC روی resolve بلاک لانچ ⇒ fail-closed — «حدس زدن latest-500» سکوت‌آمیز بود
      console.log(`⛔ خطای RPC هنگام خواندن رسید --launch-tx: ${(e.shortMessage ?? e.message).slice(0, 80)}\n   به‌جای حدس‌زدن بلاک شروع، متوقف شدم — RPC را چک کن یا --from-block صریح بده.`);
      process.exit(1);
    }
    if (rc) return rc.blockNumber;
    if (!a["from-block"]) {
      console.warn(`⚠️ --launch-tx داده شده ولی رسیدی در زنجیره نیست (هنوز ماین نشده یا هش اشتباه) و --from-block هم نداری؛\n   اسکن فقط از ۵۰۰ بلاک اخیر انجام می‌شود — سرمایه/دیتای قدیمی‌تر دیده نمی‌شود! برای اطمینان --from-block صریح بده.`);
      const latest = await provider.getBlockNumber();
      return Math.max(0, latest - 500);
    }
  }
  if (a["from-block"]) return Number(a["from-block"]);
  const latest = await provider.getBlockNumber();
  if (!quiet) console.warn(`⚠️ --launch-tx/--from-block داده نشده؛ اسکن از بلاک ${Math.max(0, latest - 500)} — داده‌های قدیمی‌تر دیده نمی‌شوند!`);
  return Math.max(0, latest - 500);
}

// ---------------- توقف در گرجوئیشن ----------------
const GRAD_VIEW_CANDIDATES = ["graduated()", "isGraduated()", "graduationReached()", "migrated()", "isMigrated()"];

async function buildGraduationChecker(curveAddr) {
  for (const sig of GRAD_VIEW_CANDIDATES) {
    const data = id(sig).slice(0, 10);
    try {
      const res = await provider.call({ to: curveAddr, data });
      if (res && res !== "0x") {
        console.log(`🎓 تشخیص گرجوئیشن از طریق تابع ${sig} (فعال)`);
        return async () => {
          try {
            const r = await provider.call({ to: curveAddr, data });
            return { graduated: r !== "0x" && BigInt(r) !== 0n, how: sig };
          } catch { return { graduated: false, how: sig }; }
        };
      }
    } catch { /* تابع وجود ندارد → کاندید بعدی */ }
  }
  console.log("🎓 تابع view برای گرجوئیشن پیدا نشد → تشخیص heuristic از روی افت رزرو‌ی کرو");
  let prev = null;
  return async () => {
    try {
      const cur = await provider.getBalance(curveAddr);
      let g = false;
      if (prev !== null && prev >= weiOf(0.01) && cur <= prev / 10n) g = true;
      const before = prev;
      prev = cur;
      return { graduated: g, how: `افت ~۹۰٪ رزرو (مهاجرت لیکوییدیتی) [${before ? fmt(BigInt(before)) : "?"}→${fmt(cur)}]` };
    } catch { return { graduated: false, how: "balance" }; }
  };
}

async function main() {
  const a = parseArgs();
  const watchOnly = truthy(a["watch-only"]);
  const dryRun = truthy(a["dry-run"]);

  // ---- ۱) --launch-file: تزریق کرو/توکن/launch-tx/workerStart (قبل از تعیین recipientها — ترتیب مهم است) ----
  let rec = null;
  if (a["launch-file"]) {
    try { rec = JSON.parse(fs.readFileSync(a["launch-file"], "utf8")); } catch (e) {
      console.log("⛔ خواندن launch-file شکست خورد:", e.message); process.exit(1);
    }
    if (!a.curve || a.curve === "true") a.curve = rec.curve;
    if (!a.token || a.token === "true") a.token = rec.token;
    if (!a["launch-tx"] && rec.txHash) a["launch-tx"] = rec.txHash;
    if (rec.chainId && Number(rec.chainId) !== CHAIN.id) {
      console.log(`⛔ رکورد لانچ برای chainId=${rec.chainId} است ولی فعلی ${CHAIN.id} — لغو!`); process.exit(1);
    }
    if (a["worker-start"] === undefined && rec.workerStart !== undefined) {
      a["worker-start"] = String(rec.workerStart);
      console.log(`📄 worker-start از رکورد لانچ خوانده شد: ${rec.workerStart}`);
    }
    console.log(`📄 از رکورد لانچ: curve=${a.curve} token=${a.token} launchTx=${a["launch-tx"] ?? "?"}`);
  }

  // ---- ۲) recipientها (بعد از تزریق launch-file تا آفستِ رکورد در مشتق‌گیری دیده شود) ----
  let recipients = readRecipients(a) ?? null;

  if (rec && (!recipients || recipients.length === 0) && Array.isArray(rec.exemptions) && rec.exemptions.length) {
    recipients = rec.exemptions.slice();
    console.log(`📄 recipientها از exemptions رکورد لانچ خوانده شد (${recipients.length} ولت)`);
  }
  if (rec && recipients && Array.isArray(rec.exemptions) && rec.exemptions.length) {
    const exSet = new Set(rec.exemptions.map((x) => x.toLowerCase()));
    const extra = recipients.filter((r) => !exSet.has(r.toLowerCase()));
    if (extra.length) {
      console.log(`⛔ این recipientها در exemptions لانچ ثبت نشده‌اند (مالیات اسنایپ می‌خورند!): ${extra.join(", ")} — لغو شد.`);
      process.exit(1);
    }
    if (recipients.length !== rec.exemptions.length)
      console.warn(`⚠️ تعداد recipientها (${recipients.length}) با exemptions (${rec.exemptions.length}) فرق دارد — عمدی است؟`);
  }

  if (recipients) {
    const seen = new Set(); const dupes = [];
    recipients = recipients.filter((r) => { const k = r.toLowerCase(); if (seen.has(k)) { dupes.push(r); return false; } seen.add(k); return true; });
    if (dupes.length) console.warn(`⚠️ ${dupes.length} recipient تکراری حذف شد: ${dupes.join(", ")}`);
  }
  if (watchOnly) recipients = recipients ?? []; // watch-only بدون recipient یکی از استفاده‌های مجاز است
  if (!watchOnly && (!recipients || recipients.length === 0)) {
    console.log("⛔ recipient پیدا نشد — یکی از --recipients/--recipients-file/--workers/--launch-file لازم است");
    process.exit(1);
  }

  if (!a.curve || !a.token || (!watchOnly && !a.total)) {
    console.log(`لازم:
  --curve 0x.. --token 0x.. ${watchOnly ? "" : "--total 3.0  و  یکی از --recipients/--recipients-file/--workers"}
  (یا --launch-file launches/launch_XXX.json ← توصیه‌شده)
اختیاری‌ها:
  --dry-run               شبیه‌سازی کامل (ژورنال جداگانه _dryrun — ژورنال واقعی را لمس نمی‌کند)
  --launch-tx 0x..        بلاک اسکن خرید خارجی از رسید لانچ (توصیه‌شده)
  --external-abort-eth 2  آستانه‌ی خرید خارجی (ETH) → توقف باندل | پیشنهاد: ۱۵–۳۰٪ total
  --no-panic              بدون این فلگ، رد آستانه ⇒ پنیک خودکار (پیش‌فرض: روشن)
  --panic-creator-only    فقط کریتور خارج شود | --panic-concurrency 6
  --guard-soft            خطاهای RPC گارد را تا ۳ بار نادیده بگیر (پیش‌فرض: اولین خطا = توقف)
  --min-ext-tx 0.02 | --window-blocks 200 | --check-every 3 | --watch-only --watch-minutes 30
  --slippage-bps 800 | --min-out / --allow-zero-minout | --min-share 0.0005
  --journal x.json (مسیر دستی) | --fresh (ژورنال تازه — فقط اگر واقعاً می‌خواهی دوباره بخری!)
  --pending-timeout-ms 120000  تعیین‌تکلیف تراکنش‌های «در تعلیق» در شروع resume
  --force [--force-live-pid] | --ignore-graduation`);
    process.exit(1);
  }

  for (const [name, addr] of [["curve", a.curve], ["token", a.token]]) {
    if (!isAddress(addr)) { console.log(`⛔ آدرس ${name} نامعتبر است: ${addr}`); process.exit(1); }
  }
  const bad = recipients.filter((r) => !isAddress(r));
  if (bad.length) { console.log("⛔ آدرس نامعتبر در recipientها:", bad.join(", ")); process.exit(1); }

  // ---- اعتبارسنجی عددها (total فقط برای بخ؛ watch-only بدون total مجاز است — باگ ممیزی) ----
  const circuit = a["external-abort-eth"] !== undefined ? numOpt(a["external-abort-eth"], 0, { min: 0.000001, name: "external-abort-eth" }) : null;
  // پنیک: پیش‌فرض روشن (انجمن با سند و نیاز کاربر) — --no-panic خاموش می‌کند
  const panic = !truthy(a["no-panic"]);
  const checkEvery = Math.max(1, Number(a["check-every"] ?? 3));
  const stopOnGrad = !truthy(a["ignore-graduation"]);
  const totalEth = watchOnly ? 0 : numOpt(a.total, 0, { min: 0.0001, max: 1000, name: "total" });
  const totalWei = weiOf(totalEth);
  const slippageBps = numOpt(a["slippage-bps"], Number(env("SLIPPAGE_BPS", "800")), { min: 0, max: 5000, name: "slippage-bps" });
  const panicConcurrency = Math.min(20, Math.max(1, Number(a["panic-concurrency"] ?? 6)));
  const minShareEth = numOpt(a["min-share"], MIN_BUY_ETH, { min: 0.000001, name: "min-share" });
  const guardSoft = truthy(a["guard-soft"]);
  const noGuard = truthy(a["no-guard"]); // --no-guard در README مستند است — این‌جا هم واقعاً اعمال می‌شود
  if (noGuard && circuit !== null) console.warn("⚠️ --no-guard: گارد خرید خارجی هم با وجود آستانه‌ی تنظیم‌شده «خاموش» اعلام شد — خرید بدون هیچ محافظتی ادامه می‌یابد");
  const pendingTimeoutMs = clampInt(a["pending-timeout-ms"], 120000, 1000, 1800000);

  function clampInt(v, def, min, max) {
    const n = Math.floor(Number(v ?? def));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  }

  // مجموعه‌ی خودی = معاف‌ها + کریتور + payer (برای گارد)
  const selfSet = new Set(recipients.map((r) => r.toLowerCase()));
  try { selfSet.add(masterWallet().address.toLowerCase()); } catch {}

  const fromBlock = await resolveFromBlock(a, { quiet: a["external-abort-eth"] === undefined });
  const guard = circuit !== null && !noGuard
    ? new ExternalGuard(a.curve, fromBlock, selfSet, {
        minTxWei: a["min-ext-tx"] ? weiOf(String(a["min-ext-tx"])) : 0n,
        windowBlocks: Math.max(0, Number(a["window-blocks"] ?? 0)),
        soft: guardSoft,
      })
    : null;
  if (guard) console.log(`🛡️ گارد خارجی فعال: آستانه ${circuit} ETH | اسکن افزایشی (reorg-safe) از بلاک ${fromBlock} | خطای RPC: ${guardSoft ? "۳ بار تحمّل" : "توقف فوری"}`);
  else if (circuit !== null && noGuard) console.warn("   (گارد با --no-guard غیرفعال — آستانه فقط در لاگ اولیه نمایش داده می‌شود)");

  // ممیزی ۴ — چک گرجوئیشن fail-open روی خطای RPC بود؛ ابزار fail-closed می‌سازیم:
  // با --stop-on-grad، خطای خواندن وضعیت گرجوئیشن = «گرجوئیشن نامعلوم» ⇒ بنابر محافظ، خرید ادامه نمی‌یابد.
  const gradCheckBase = stopOnGrad && !dryRun ? await buildGraduationChecker(a.curve) : null;
  let gradRpcFailures = 0;
  const gradCheck = gradCheckBase
    ? async () => {
        try {
          const g = await gradCheckBase();
          gradRpcFailures = 0;
          return g;
        } catch (e) {
          gradRpcFailures++;
          console.log(`⚠️ خطای RPC در چک گرجوئیشن (${gradRpcFailures}مین پیاپی): ${(e.shortMessage ?? e.message).slice(0, 60)}`);
          if (gradRpcFailures >= 3) {
            console.log("⛔ وضعیت گرجوئیشن پشت‌سرهم «نامعلوم» ماند — با --stop-on-grad ادامه‌ی خرید روی داده‌ی نامطمئن مجاز نیست (fail-closed)");
            return { graduated: true, how: "rpc-unknown-failclosed" };
          }
          return { graduated: false }; // سه خطای اول تحمل، چهارم fail-closed
        }
      }
    : null;

  // جزییات تراکنش در تعلیق رصد می‌شود
  let guardTripped = null; // null | "external-guard" | "guard-rpc-error"
  let panicOutcome = null; // {ok, fail, failList}

  let estPriceNow = null, estPriceTs = 0;
  async function refPrice() {
    const now = Date.now();
    if (!estPriceNow || now - estPriceTs > 2000) {
      try { estPriceNow = await marketPrice(a.curve, fromBlock, 5); estPriceTs = now; } catch {}
    }
  }

  // امضاکننده‌های قابل‌امضا برای پنیک: master + payer + کارگرهای مشتق‌شده که در recipients هستند
  function panicSigners() {
    const out = [];
    try { out.push(masterWallet()); } catch {}
    try { out.push(payerWallet(a)); } catch {}
    const want = truthy(a["panic-creator-only"]) ? [] : env("WORKER_COUNT", "28") === "0" ? [] : [Number(a.workers ?? env("WORKER_COUNT", "28"))];
    for (const n of want) {
      try { out.push(...deriveWorkers(n, workerStart(a)).map((w) => w.wallet)); } catch {}
    }
    const recipSet = new Set(recipients.map((r) => r.toLowerCase()));
    const nonSignable = recipients.filter((r) => !out.some((w) => w.address.toLowerCase() === r.toLowerCase()));
    if (nonSignable.length && panic) console.warn(`⚠️ ${nonSignable.length} recipient کلیدش را نداریم (${nonSignable.slice(0, 3).join(", ")}…) — در پنیک خودکار قابل‌فروش نیستند`);
    return out;
  }

  async function guardCheck(tag) {
    if (!guard) return false;
    let ext;
    try {
      ext = await guard.scan();
      guard.errors = 0;
    } catch (e) {
      guard.errors++;
      console.log(`⚠️ خطا در مانیتور خارجی (${guard.errors}مین پیاپی): ${(e.shortMessage ?? e.message).slice(0, 80)}`);
      // پشت‌ایمن پیش‌فرض: اولین خطا = توقف امن (fail-closed) | --guard-soft: ۳ بار تحمّل
      if (!guardSoft || guard.errors >= 3) { console.log(`⛔ گارد fail-closed شد (${guardSoft ? "۳ خطای پیاپی" : "اولین خطای"} RPC) — توقف امن باندل روی داده‌ی نامطمئن`); guardTripped = "guard-rpc-error"; return true; }
      return false;
    }
    const ethFloat = Number(fmt(ext));
    const scope = guard.windowBlocks > 0 ? `(${guard.windowBlocks} بلاک اخیر)` : "(انباشته از لانچ)";
    console.log(`   👁️ [${tag}] خرید خارجی ${scope}: ${ethFloat.toFixed(4)} ETH / آستانه ${circuit}`);
    if (ethFloat < circuit) return false;
    console.log(`\n⛔ آستانه رد شد (${ethFloat.toFixed(4)} ≥ ${circuit} ETH) — توقف فوری باندل!`);
    guardTripped = "external-guard";
    if (panic && !dryRun) {
      const gp = await gasPrice();
      panicOutcome = await panicSellAll(a.token, a.curve, panicSigners(), gp, panicConcurrency, { estPrice: estPriceNow?.last ?? estPriceNow?.price ?? null, slippageBps });
    }
    return true;
  }

  async function gradReached(tag) {
    if (!gradCheck) return false;
    try {
      const g = await gradCheck();
      if (g.graduated) console.log(`🎓 [${tag}] گرجوئیشن تشخیص داده شد (${g.how})`);
      return g.graduated;
    } catch (e) { console.log(`⚠️ خطا در چک گرجوئیشن (${(e.shortMessage ?? e.message).slice(0, 60)}) — ادامه…`); return false; }
  }

  // حالت فقط دیده‌بان
  if (watchOnly) {
    if (circuit === null) { console.log("--watch-only بدون --external-abort-eth معنا ندارد"); process.exit(1); }
    const minutes = Number(a["watch-minutes"] ?? 30);
    const interval = Number(a["watch-interval"] ?? 1500);
    // اعتبارسنجی فلگ‌های عددی (ممیزی ۴): حلقه‌ی بینهایت/فوری = فاجعه
    if (!Number.isFinite(minutes) || minutes <= 0) { console.log("⛔ --watch-minutes باید عدد مثبت باشد"); process.exit(1); }
    if (!Number.isFinite(interval) || interval < 200) { console.log("⛔ --watch-interval باید ≥ 200ms باشد"); process.exit(1); }
    console.log(`👁️ حالت دیده‌بان: هر ${interval}ms تا ${minutes} دقیقه…`);
    const t0 = Date.now();
    while ((Date.now() - t0) / 60000 < minutes) {
      if (await guardCheck("watch")) {
        console.log("🚨 دیده‌بان: تریگر آستانه‌ی خرید خارجی شلیک شد (خروج با کد 2)");
        process.exitCode = 2; // تریگر واقعی — با «پایان طبیعی پایش» (کد 0) اشتباه نشود
        return;
      }
      if (await gradReached("watch")) { console.log("⌛ پایان دیده‌بان — گرجوئیشن رسید"); process.exitCode = 0; return; }
      await sleep(interval);
    }
    console.log("⌛ پایان پنجره‌ی دیده‌بان بدون تریگر");
    return;
  }

  // ---------------- بچ‌بای ----------------
  // preflight: مقصدهای پول واقعاً قراردادند؟ (ممیزی ۴ — ارسال به EOA بدون کد = سوختن پول)
  await assertContract(a.curve, "باندینگ-کرو");
  await assertContract(a.token, "توکن");
  acquireRunLock(LOCK_FILE, {
    force: truthy(a.force), forceLivePid: truthy(a["force-live-pid"]),
    globalKey: `pons-batch-${CHAIN.id}-${master.address}`, // لاک سراسری: رقابت بین دو نسخه‌ی پروژه روی یک مستر/چین
  });
  const REL = () => releaseRunLock(LOCK_FILE);
  console.log("🔴 MAINNET — پول واقعی در جریان است (پیش از این، --dry-run را کامل دیده‌ای؟)");

  const payer = payerWallet(a);
  selfSet.add(payer.address.toLowerCase());
  const minOutFlag = a["min-out"] !== undefined ? BigInt(a["min-out"]) : null;
  const allowZeroMinOut = truthy(a["allow-zero-minout"]) || minOutFlag === 0n;
  const perDelay = Number(a.delay ?? 100);
  // اعتبارسنجی فلگ‌های عددی (ممیزی ۴)
  const numDie = (msg) => { console.log("⛔", msg); REL(); process.exit(1); };
  if (!Number.isFinite(perDelay) || perDelay < 0 || perDelay > 600_000) numDie("--delay باید بین ۰ و ۶۰۰٬۰۰۰ میلی‌ثانیه باشد");
  {
    const wCount = Number(a.workers ?? env("WORKER_COUNT", "28"));
    if (!recipients.length && (!Number.isInteger(wCount) || wCount < 1 || wCount > 250)) numDie("--workers باید عدد صحیح بین ۱ و ۲۵۰ باشد");
  }
  if (!Number.isFinite(Number(a["panic-concurrency"] ?? 6)) || Number(a["panic-concurrency"] ?? 6) < 1 || Number(a["panic-concurrency"] ?? 6) > 20) numDie("--panic-concurrency باید بین ۱ و ۲۰ باشد");
  if (!Number.isFinite(Number(a["pending-timeout-ms"] ?? 120000)) || Number(a["pending-timeout-ms"] ?? 120000) < 10000) numDie("--pending-timeout-ms باید ≥ ۱۰٬۰۰۰ باشد");
  const curve = new Contract(a.curve, BONDING_CURVE_ABI, payer);
  const tokenRead = new Contract(a.token, ERC20_ABI, provider);
  let tokDec = 18;
  try { tokDec = Number(await tokenRead.decimals()); } catch { /* توکن استاندارد پونز = ۱۸ */ }

  // ---------------- ژورنال اتمیک: نقشه‌ی تخصیص «منجمد» (حل باگ resume-overspend) ----------------
  const fresh = truthy(a.fresh);
  const defaultJournal = `${LAUNCHES_DIR}/batchbuy_${a.curve.slice(2, 10)}_${a.token.slice(2, 10)}.json`;
  // در dry-run هرگز ژورنال واقعی را نمی‌نویسیم: فایل *_dryrun.json جدا (مگر --journal صریح بیاید)
  const journalFile = a.journal ?? (dryRun ? defaultJournal.replace(/\.json$/, "_dryrun.json") : (fresh ? `${LAUNCHES_DIR}/${nowTag()}_batchbuy.json` : defaultJournal));
  const header = { chainId: CHAIN.id, curve: a.curve, token: a.token, payer: payer.address };
  let journal;
  const existing = readJsonSafe(journalFile);
  const mismatch = existing ? ["chainId", "curve", "token", "payer"].filter((k) => String((existing.header ?? {})[k] ?? "").toLowerCase() !== String(header[k]).toLowerCase()) : null;
  if (existing && !fresh && mismatch.length) {
    console.log(`⛔ ژورنال موجود (${journalFile}) برای مجموعه‌ی دیگری است (ناهماهنگی: ${mismatch.join(", ")}).
   برای ادامه‌ی آن با همان پارامترهای قبلی اجرا کن، یا عمداً با --fresh ژورنال تازه بساز.`);
    REL(); process.exit(1);
  }

  // ─── نقشه‌ی تخصیص: resume = همان نقشه‌ی منجمد‌شده (هرگز دوباره تصادفی نمی‌شود) — منطق در lib به‌صورت تست‌شدنی ───
  let amountsWei;
  const minShareWei = weiOf(minShareEth);
  let resolvedAlloc = null;
  try {
    // dry-run همان محدودیت min-share واقعی را می‌سنجد (dryRun:false برای allocation — parity کامل با اجرای واقعی)
    const r = resolveBatchAllocation({ journal: existing, fresh, recipients, totalWei, minShareWei, dryRun: false });
    if (!r.ok) {
      const why = r.reason === "alloc-missing-on-resume"
        ? `⛔ ژورنال قبلی تراکنش ثبت‌شده دارد ولی «نقشه‌ی تخصیص منجمد (alloc)» ندارد (از نسخه‌ی قدیمی‌تر ساخته شده).
   برای جلوگیری از خرید دوباره/سهم‌های متفاوت، وارد resume تازه نمی‌شوم.
   گزینه‌ها: (۱) اگر همه‌ی ژورنال قبلی باید ماست: با همین پوشه و بدون تغییر فلگ، --fresh را فقط وقتی بزن که واقعاً می‌خواهی خرید از صفر عایق انجام شود (سهم‌های قبلی دوباره ارسال می‌شوند!).`
        : `⛔ نقشه‌ی تخصیص ژورنال با recipientهای این اجرا یکی نیست — resume غیرامن. یا همان لیست را بده یا --fresh (خرید دوباره از صفر — فقط عمدی).`;
      console.log(why); REL(); process.exit(1);
    }
    amountsWei = r.amountsWei;
    if (r.source === "frozen") console.log(`♻️ resume با نقشه‌ی تخصیص منجمد‌شده‌ی ژورنال (مجموع ${existing.alloc.totalEth} ETH — همان اجرای اول)`);
    resolvedAlloc = r.journalAlloc ?? null;
  } catch (e) {
    console.log(`⛔ تخصیص غیرممکن: ${e.message}\n   راه‌حل: --total را بیشتر کن یا تعداد recipientها را کم کن (یا --min-share را کمتر).`);
    REL(); process.exit(1);
  }

  // (ساخت journal — قبل از نوشتن، رکوردهای قدیمی وریفای/پاک می‌شوند)
  if (existing && !fresh) {
    console.log(`♻️ RESUME از ژورنال: ${journalFile}`);
    journal = existing;
  } else {
    if (existing && fresh) console.log(`--fresh: ژورنال تازه ساخته می‌شود (${journalFile})`);
    journal = {
      header, totalEth, dryRun, stoppedBy: null, results: [], failed: [],
      startedAt: new Date().toISOString(), panic: null,
      alloc: resolvedAlloc,
    };
  }
  const J = () => atomicWriteJson(journalFile, journal);

  // ─── resume: تعیین‌تکلیف تراکنش‌های قدیمی قبل از هر ارسال تازه ───
  let blockedPending = null;
  if (existing && !fresh && !dryRun) {
    // ۱- رکوردهای موفق: وریفای — هش ریورت‌شده/حذف‌شده = برمی‌گردد به صف
    const verified = [];
    for (const r of journal.results ?? []) {
      if (!r.tx) { console.log(`   ℹ️ رکورد بدون هش — دوباره انجام می‌شود: ${r.recipient}`); continue; }
      const st = await classifyTx(r.tx, { polls: 1 });
      if (st === "ok") verified.push(r);
      else if (st === "unknown") {
        console.log(`⛔ وضعیت تراکنش قبلی ${r.tx} به‌خاطر خطای RPC روشن نیست — Resume ناامن؛ با RPC سالم دوباره بیا یا --fresh.`);
        REL(); process.exit(1);
      }
      else console.log(`   ⚠️ تراکنش قبلی ${r.tx} وضعیت «${st}» دارد ⇒ دوباره انجام می‌شود: ${r.recipient}`);
    }
    // ۲- شکست‌های دارای هش (شامل «در تعلیق»): ابتدا تعیین‌تکلیف، سپس تصمیم
    const keepFailed = [];
    for (const f of journal.failed ?? []) {
      if (!f.tx) { continue; } // شکست static (ریورت شبیه‌سازی) → دوباره تلاش می‌شود، در ژورنال نمی‌ماند
      let st = await classifyTx(f.tx, { polls: 2, intervalMs: 4000 });
      const t0 = Date.now();
      while ((st === "pending" || st === "unknown") && Date.now() - t0 < pendingTimeoutMs) {
        console.log(`   ⏳ منتظر تعیین‌تکلیف ${f.tx} (وضعیت: ${st})…`);
        await sleep(10000);
        st = await classifyTx(f.tx, { polls: 1 });
      }
      if (st === "ok") {
        verified.push({ recipient: f.recipient, ethInWei: f.ethInWei, tx: f.tx, recovered: true });
        console.log(`   ✅ تراکنش «در تعلیق» در واقع ماین شد: ${f.recipient} (${f.tx})`);
      } else if (st === "reverted" || st === "absent") {
        console.log(`   ↩︎ تراکنش ${f.tx} وضعیت «${st}» دارد ⇒ امن برای انجام دوباره: ${f.recipient}`);
      } else {
        blockedPending = { recipient: f.recipient, tx: f.tx, st };
        keepFailed.push({ ...f, tx: f.tx });
      }
    }
    journal.results = verified; journal.failed = keepFailed; J();
    if (blockedPending) {
      console.log(`⛔ ${journal.failed.length} تراکنش هنوز «${blockedPending.st}» است (مثل ${blockedPending.tx}).
   ارسال مجدد با همین nonce خطر تکرار دارد — ابتدا تعیین‌تکلیفش کن (مثلاً با Blockscout) یا --pending-timeout-ms را بیشتر بده. اجرا لغو شد.`);
      REL(); process.exit(1);
    }
  } else if (dryRun) {
    journal.header = header; journal.dryRun = true; journal.results = []; journal.failed = [];
    journal.alloc = journal.alloc ?? { totalEth, minShareEth, recipients, amountsWei: amountsWei.map((w) => w.toString()) };
  }

  const doneSet = new Set((journal.results ?? []).map((r) => r.recipient.toLowerCase()));
  if (doneSet.size) console.log(`📌 ${doneSet.size} خریدِ تأییدشده‌ی قبلی از سر گرفته نمی‌شود (idempotent).`);
  const results = journal.results;
  let stoppedBy = null;

  // موجودی payer: مجموعِ نقشه‌ی باقی‌مانده + گس (نه کل total — resume نباید دوباره برای انجام‌شده‌ها رزرو بخواهد)
  let gp = await gasPrice();
  const remainingIdx = recipients.map((r, i) => i).filter((i) => !doneSet.has(recipients[i].toLowerCase()));
  const remainingTotalWei = remainingIdx.reduce((s, i) => s + amountsWei[i], 0n);
  const gasReserve = gp * 150000n * BigInt(remainingIdx.length);
  const need = remainingTotalWei + gasReserve;
  const bal = await provider.getBalance(payer.address);
  if (bal < need) {
    console.log(`⛔ موجودی پرداخت‌کننده (${payer.address}) کافی نیست: ${fmt(bal)} < ${fmt(need)} (باقی‌مانده ${fmt(remainingTotalWei)} + رزرو گس تخمینی ${fmt(gasReserve)}) — اول payer را شارژ کن`);
    REL(); process.exit(1);
  }

  // قیمت مرجع برای minOut خریدها (ضد سندویچ): آخرین معاملات کرو
  await refPrice();
  if (!estPriceNow && !allowZeroMinOut && minOutFlag === null) {
    console.log(`⛔ قیمت مرجع برای تخمین minOut پیدا نشد (هنوز معامله‌ای روی کرو نیست یا RPC ضعیف است).
   سیاست امن: خرید بدون محافظت لغزش انجام نمی‌شود. اگر عمداً minOut=0 می‌خواهی: --allow-zero-minout (یا --min-out 0)`);
    REL(); process.exit(1);
  }
  if (!estPriceNow && minOutFlag === null && allowZeroMinOut) console.warn("⚠️ بدون قیمت مرجع و با minOut=0 — ریسک سندویچ را پذیرفتی!");

  console.log(`🧺 بچ‌بای${dryRun ? " (DRY-RUN — هیچ تراکنشی ارسال نمی‌شود)" : ""} | پرداخت‌کننده: ${payer.address}
📦 کرو: ${a.curve}
👥 ${recipients.length} ولت (${doneSet.size} قبلاً انجام‌شده) | مجموع ${totalEth} ETH | توقف-در-گرجوئیشن: ${gradCheck ? "روشن" : "خاموش"} | لغزش minOut: ${slippageBps / 100}٪ | پنیک: ${panic ? "روشن" : "خاموش"}`);

  const minOutFor = (quoteIn) => {
    if (minOutFlag !== null) return minOutFlag;
    const p = estPriceNow?.last ?? estPriceNow?.price ?? null;
    return estMinOut(quoteIn, p ? 1 / p : null, slippageBps); // توکن = ETH ÷ قیمت
  };

  async function doSend(target, quoteIn) {
    const data = curveIface.encodeFunctionData("buy", [quoteIn, minOutFor(quoteIn), target]);
    await provider.call({ to: a.curve, data, value: quoteIn, from: payer.address });
    gp = await gasPrice();
    const tx = await payer.sendTransaction({ to: a.curve, data, value: quoteIn, gasPrice: gp });
    return { tx, data };
  }

  async function waitAndRecord(target, quoteIn, tx) {
    // ← ثبت «نیت» بلافاصله بعد از broadcast: اگر الان کرش کنیم، هشِ معلقِ ما در ژورنال است و resume تعیین‌تکلیفش می‌کند
    journal.failed = (journal.failed ?? []).filter((e) => e.tx !== tx.hash);
    journal.failed.push({ recipient: target, ethInWei: quoteIn.toString(), tx: tx.hash, nonce: tx.nonce, status: "broadcast", intent: true, at: new Date().toISOString() });
    J();
    const dropIntent = () => { journal.failed = journal.failed.filter((e) => !(e.tx === tx.hash && e.intent)); };
    try {
      const rc = await tx.wait(1, 120000);
      let tokensOut = null;
      for (const log of rc.logs) {
        if (log.address.toLowerCase() === a.curve.toLowerCase() && log.topics[0] === CURVE_BUY_TOPIC) {
          const ev = curveIface.parseLog({ topics: log.topics, data: log.data });
          if (ev.args.recipient.toLowerCase() === target.toLowerCase()) tokensOut = ev.args.tokensOut;
        }
      }
      dropIntent();
      results.push({ recipient: target, ethInWei: quoteIn.toString(), tx: tx.hash, tokensOut: tokensOut?.toString() ?? null, block: rc.blockNumber });
      J();
      console.log(`✅ ${target} | ${fmt(quoteIn)} ETH | توکن: ${tokensOut ? formatUnits(tokensOut, tokDec) : "?"} | بلاک ${rc.blockNumber} | ${tx.hash}`);
      return "ok";
    } catch (e) {
      console.log(`⚠️ دریافت رسید ممکن نشد (${(e.shortMessage ?? e.message).slice(0, 80)}) — پرس‌وجوی وضعیت ${tx.hash}…`);
      const st = await classifyTx(tx.hash, { polls: 3, intervalMs: 5000 });
      if (st === "ok") {
        dropIntent();
        results.push({ recipient: target, ethInWei: quoteIn.toString(), tx: tx.hash, tokensOut: null, recovered: true });
        J();
        console.log(`✅ تراکنش در واقع ماین شد (پس از قطعی) — ثبت موفق: ${tx.hash}`);
        return "ok";
      }
      dropIntent();
      journal.failed.push({ recipient: target, ethInWei: quoteIn.toString(), tx: tx.hash, pending: st === "pending", status: st, error: `tx ${st}: ${(e.shortMessage ?? e.message).slice(0, 120)}` });
      J();
      if (st === "pending" || st === "unknown") {
        // امنیت قبل از تداوم: ارسال بعدی با nonce بالاتر می‌تواند دو تراکنش قدیمی+جدید را در شبکه نگه دارد
        console.log(`⛔ تراکنش «${st}» است (${tx.hash}) — بچ متوقف می‌شود تا تعیین‌تکلیف شود (resume بعدی آن را بازگیری می‌کند)`);
        return "stop";
      }
      console.log(`❌ تراکنش «${st}» است (${tx.hash}) — ریورت/عدم‌ثبت ⇒ اجرای بعدی دوباره انجام می‌دهد`);
      return "fail";
    }
  }

  // DRY-RUN: ژورنال جدای _dryrun — ژورنال واقعی دست‌نخورده
  if (dryRun) {
    let ok = 0, fail = 0;
    for (let i = 0; i < recipients.length; i++) {
      const quoteIn = amountsWei[i];
      const data = curveIface.encodeFunctionData("buy", [quoteIn, minOutFor(quoteIn), recipients[i]]);
      try {
        await provider.call({ to: a.curve, data, value: quoteIn, from: payer.address });
        ok++;
        console.log(`🧪 [${i + 1}/${recipients.length}] ${recipients[i]} → ${fmt(amountsWei[i])} ETH: شبیه‌سازی OK`);
      } catch (e) {
        fail++;
        journal.failed.push({ recipient: recipients[i], error: (e.shortMessage ?? e.message).slice(0, 160) });
        console.log(`🧪❌ [${i + 1}/${recipients.length}] ${recipients[i]}: ریورت شبیه‌سازی — ${(e.shortMessage ?? e.message).slice(0, 100)}`);
      }
    }
    journal.stoppedBy = "dry-run"; J();
    REL();
    console.log(`\n🧪 DRY-RUN تمام شد: ${ok} موفق، ${fail} ناموفق — ژورنال آزمایشی جدا: ${journalFile} (قدیمیِ real لمس نشد)`);
    process.exit(fail > 0 ? 2 : 0);
  }

  for (let i = 0; i < recipients.length; i++) {
    const target = recipients[i];
    if (doneSet.has(target.toLowerCase())) { console.log(`   ⏭️ [${i + 1}/${recipients.length}] ${target} قبلاً خرید شده (resume)`); continue; }
    if (await gradReached(`pre-buy ${i + 1}`)) { stoppedBy = "graduation"; break; }
    if (guard && (i === 0 || i % checkEvery === 0)) {
      const tripped = await guardCheck(`pre-buy ${i + 1}`);
      if (tripped) { stoppedBy = guardTripped; break; }
    }
    const quoteIn = amountsWei[i];
    try {
      await refPrice();
      const { tx } = await doSend(target, quoteIn);
      const r = await waitAndRecord(target, quoteIn, tx);
      if (r === "stop") { stoppedBy = "tx-pending"; break; }
      if (r === "fail" && truthy(a["stop-on-error"])) { stoppedBy = "tx-error"; break; }
    } catch (e) {
      journal.failed.push({ recipient: target, ethInWei: quoteIn.toString(), error: (e.shortMessage ?? e.message).slice(0, 160) });
      J();
      console.log(`❌ [${i + 1}/${recipients.length}] ${target}:`, (e.shortMessage ?? e.message).slice(0, 120));
      if (truthy(a["stop-on-error"])) { stoppedBy = "tx-error"; break; }
    }
    if (i < recipients.length - 1 && !doneSet.has(recipients[Math.min(i + 1, recipients.length - 1)].toLowerCase())) await sleep(perDelay);
  }

  journal.stoppedBy = stoppedBy ?? "completed";
  if (panicOutcome) journal.panic = { ...panicOutcome, at: new Date().toISOString(), estPrice: estPriceNow?.last ?? estPriceNow?.price ?? null };
  J();

  if (stoppedBy && stoppedBy !== "completed") console.log(`⏹️ خریدها متوقف شدند — دلیل: ${{ graduation: "گرجوئیشن رسید", "external-guard": "گارد خرید خارجی", "guard-rpc-error": "خطای RPC گارد (توقف امن)", "tx-pending": "تراکنش در تعلیق", "tx-error": "خطای تراکنش" }[stoppedBy] ?? stoppedBy}`);

  console.log(`💾 ژورنال (${results.length}/${recipients.length} موفق، ${journal.failed.length} ناموفق/تعلیق): ${journalFile}`);

  if (!stoppedBy) {
    console.log("\n— کنترل موجودی نهایی (از خود کانترکت توکن) —");
    for (const r of results) {
      try { console.log(`${r.recipient}: ${formatUnits(await tokenRead.balanceOf(r.recipient), tokDec)}`); } catch {}
    }
  } else {
    console.log("⚠️ اجرا ناقص بود — اجرای دوباره‌ی همین دستور خودکار RESUME می‌کند (با همان نقشه‌ی تخصیص انجمادی).");
  }

  // کدهای خروج: ناکامل=۲، پنیک‌ناقص=۳، تمیز=۰
  let exitCode = 0;
  if (stoppedBy && stoppedBy !== "completed") exitCode = 2;
  if (journal.failed.length) exitCode = Math.max(exitCode, 2);
  if (panicOutcome && panicOutcome.fail > 0) exitCode = 3;
  REL();
  process.exit(exitCode);
}

main().catch((e) => { try { releaseRunLock(LOCK_FILE); } catch {} console.error("خطا:", e.shortMessage ?? e.message); process.exit(1); });
