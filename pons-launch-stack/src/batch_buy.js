// خرید باندلی «یک‌جا بخر، پخش کن» — الگوی فارم: یک ولت پرداخت‌کننده، توکن برای همه‌ی ولت‌های معاف
// + دیده‌بان خرید خارجی: رد آستانه → توقف باندل + خروج موازی کامل (پیش‌فرض: کریتور + همه‌ی باندل‌ها)
// + توقف خودکار در گرجوئیشن (پیش‌فرض روشن)
// + سپرهای امنیتی: ولیدیشن آدرس‌ها، --launch-file (کرو/توکن/workerStart + چک recipient ⊆ exemptions)،
//   شبیه‌سازی eth_call قبل از هر ارسال، --dry-run (بدون هیچ ارسالی)، نرمال‌سازی مبالغ به ≤ total
// + minOut تخمینی از قیمت میانه (ضد سندویچ) | ژورنال افزایشی بعد از هر تراکنش (ضد کرش) | run-lock
// نکته‌ی طراحی: خریدها عمداً ترتیبی‌اند — قبل از هر ارسال شبیه‌سازی + چک گارد می‌آید؛ موازی‌سازی
//   کور این سپرها را می‌شکند (همان نکته‌ای که ممیز به‌عنوان «عدم هم‌زمانی» گزارش کرد — تصمیم آگاهانه است).
import fs from "node:fs";
import { Contract, Interface, Wallet, id, isAddress, formatUnits } from "ethers";
import { ADDR, CHAIN, LAUNCHES_DIR, env, parseArgs } from "./config.js";
import { BONDING_CURVE_ABI, ERC20_ABI } from "./abis.js";
import { provider, masterWallet, deriveWorkers, workerStart, truthy, numOpt, eth, fmt, gasPrice, splitRandom, nowTag, sleep } from "./lib.js";
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

// حالت انباشته‌ (windowBlocks=0): هر چک فقط بلاک‌های جدید اسکن و به جمع قبلی اضافه می‌شود.
// حالت پنجره‌ای (windowBlocks>0): به‌خاطر معنای «فقط N بلاک اخیر» کامل اسکن می‌شود (مستند).
class ExternalGuard {
  constructor(curveAddr, fromBlock, selfSet, { minTxWei = 0n, windowBlocks = 0 } = {}) {
    this.curveAddr = curveAddr; this.selfSet = selfSet;
    this.minTxWei = minTxWei; this.windowBlocks = windowBlocks;
    this.base = fromBlock;           // کف اولیه برای حالت پنجره‌ای
    this.nextFrom = fromBlock;       // مکان‌نمای اسکن افزایشی (حالت انباشته)
    this.extCum = 0n; this.errors = 0;
  }
  async scan() {
    const latest = await provider.getBlockNumber();
    if (this.windowBlocks > 0) {
      // پنجره‌ی متحرک: از کف پنجره‌ی جاری (نه پایین‌تر از بلاک شروع اولیه) کامل خوانده می‌شود
      const floor = Math.max(this.base, latest - this.windowBlocks);
      const logs = await provider.getLogs({ address: this.curveAddr, topics: [CURVE_BUY_TOPIC], fromBlock: floor, toBlock: "latest" });
      let ext = 0n;
      for (const lg of logs) { const q = this.quoteOf(lg); if (q) ext += q; }
      return ext;
    }
    // انباشته: فقط از آخرین نقطه‌ی دیده‌شده به بعد
    const logs = await provider.getLogs({ address: this.curveAddr, topics: [CURVE_BUY_TOPIC], fromBlock: this.nextFrom, toBlock: "latest" });
    for (const lg of logs) { const q = this.quoteOf(lg); if (q) this.extCum += q; }
    this.nextFrom = latest + 1;
    return this.extCum;
  }
  quoteOf(lg) {
    try {
      const ev = curveIface.parseLog({ topics: lg.topics, data: lg.data });
      const rec = ev.args.recipient.toLowerCase();
      const q = BigInt(ev.args.quoteIn);
      return (!this.selfSet.has(rec) && q >= this.minTxWei) ? q : null;
    } catch { return null; }
  }
}

async function resolveFromBlock(a, { quiet = false } = {}) {
  if (a["launch-tx"]) {
    try {
      const rc = await provider.getTransactionReceipt(a["launch-tx"]);
      if (rc) return rc.blockNumber;
    } catch {}
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
      if (prev !== null && prev >= eth("0.01") && cur <= prev / 10n) g = true;
      prev = cur;
      return { graduated: g, how: "افت ~۹۰٪ رزرو (مهاجرت لیکوییدیتی)" };
    } catch { return { graduated: false, how: "balance" }; }
  };
}

// ---------------- run-lock ----------------
function acquireLock(force) {
  if (fs.existsSync(LOCK_FILE)) {
    const prev = fs.readFileSync(LOCK_FILE, "utf8");
    if (!force) {
      console.log(`⛔ run-lock فعال است (${LOCK_FILE}): ${prev}\nاگر اجرای قبلی واقعاً مرده، با --force دوباره بیا.`);
      process.exit(1);
    }
    console.warn("⚠️ run-lock قبلی با --force نادیده گرفته شد");
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
}
function releaseLock() { try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {} }
process.on("exit", releaseLock);

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
    // آفست مشتق‌گیری هم از رکورد می‌آید تا recipients/panic دقیقاً همان مجموعه‌ی exemptions باشند
    if (a["worker-start"] === undefined && rec.workerStart !== undefined) {
      a["worker-start"] = String(rec.workerStart);
      console.log(`📄 worker-start از رکورد لانچ خوانده شد: ${rec.workerStart}`);
    }
    console.log(`📄 از رکورد لانچ: curve=${a.curve} token=${a.token} launchTx=${a["launch-tx"] ?? "?"}`);
  }

  // ---- ۲) recipientها (بعد از تزریق launch-file تا آفستِ رکورد در مشتق‌گیری دیده شود) ----
  let recipients = readRecipients(a) ?? null;

  // اگر recipient داده نشده ولی رکورد لانچ exemptions دارد → همان‌ها recipient می‌شوند (دقیق‌ترین منبع)
  if (rec && (!recipients || recipients.length === 0) && Array.isArray(rec.exemptions) && rec.exemptions.length) {
    recipients = rec.exemptions.slice();
    console.log(`📄 recipientها از exemptions رکورد لانچ خوانده شد (${recipients.length} ولت)`);
  }
  // چک سخت‌گیرانه recipient ⊆ exemptions
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

  // ---- ۳) حذف تکراری‌ها (خرید دو بار برای یک ولت = اتلاف پول) ----
  if (recipients) {
    const seen = new Set(); const dupes = [];
    recipients = recipients.filter((r) => { const k = r.toLowerCase(); if (seen.has(k)) { dupes.push(r); return false; } seen.add(k); return true; });
    if (dupes.length) console.warn(`⚠️ ${dupes.length} recipient تکراری حذف شد: ${dupes.join(", ")}`);
  }

  if (!a.curve || !a.token || (!watchOnly && (!a.total || !recipients || recipients.length === 0))) {
    console.log(`لازم:
  --curve 0x.. --token 0x.. --total 3.0  و  یکی از --recipients/--recipients-file/--workers
  (یا --launch-file launches/launch_XXX.json — کرو/توکن/launch-tx/workerStart را از رکورد می‌گیرد + recipientها را با exemptions چک می‌کند)
اختیاری‌ها:
  --dry-run               شبیه‌سازی کامل همه‌ی خریدها بدون هیچ ارسالی (اولین اجرا حتماً!)
  --launch-tx 0x..        بلاک اسکن خرید خارجی از رسید لانچ (توصیه‌شده)
  --external-abort-eth 2  آستانه‌ی خرید خارجی (ETH) → توقف باندل | پیشنهاد: ۱۵–۳۰٪ total
  --min-ext-tx 0.02       حذف گردوخاک ریز از شمارش خارجی
  --window-blocks 200     فقط N بلاک اخیر شمرده شود (نگهبانی)
  --panic-sell            خروج موازی کامل کریتور + همه‌ی باندل‌ها هنگام تریگر (پیش‌فرض)
  --panic-creator-only    فقط کریتور خارج شود | --panic-concurrency 6
  --slippage-bps 800      لغزش مجاز برای minOut تخمینی از قیمت میانه (پیش‌فرض SLIPPAGE_BPS)
  --watch-only            فقط دیده‌بان  |  --watch-minutes 30
  --check-every 3         هر چند خرید یک‌بار گارد چک شود
  --worker-start 0        آفست مشتق‌گیری کارگرها (با launch-file خودکار از رکورد می‌آید)
  --force                 نادیده‌گرفتن run-lock اجرای قبلی
  --ignore-graduation     توقف‌در‌گرجوئیشن را خاموش می‌کند (پیش‌فرض روشن)`);
    process.exit(1);
  }

  // ---- ولیدیشن آدرس‌ها (قبل از هر پرداخت) ----
  for (const [name, addr] of [["curve", a.curve], ["token", a.token]]) {
    if (!isAddress(addr)) { console.log(`⛔ آدرس ${name} نامعتبر است: ${addr}`); process.exit(1); }
  }
  const bad = recipients.filter((r) => !isAddress(r));
  if (bad.length) { console.log("⛔ آدرس نامعتبر در recipientها:", bad.join(", ")); process.exit(1); }

  // ---- اعتبارسنجی عددها ----
  const circuit = a["external-abort-eth"] !== undefined ? numOpt(a["external-abort-eth"], 0, { min: 0.000001, name: "external-abort-eth" }) : null;
  const panic = truthy(a["panic-sell"]);
  const checkEvery = Math.max(1, Number(a["check-every"] ?? 3));
  const stopOnGrad = !truthy(a["ignore-graduation"]);
  const totalEth = numOpt(a.total, 0, { min: 0.0001, max: 1000, name: "total" });
  const slippageBps = numOpt(a["slippage-bps"], Number(env("SLIPPAGE_BPS", "800")), { min: 0, max: 5000, name: "slippage-bps" });
  const panicConcurrency = Math.max(1, Number(a["panic-concurrency"] ?? 6));

  if (!dryRun && recipients.length * MIN_BUY_ETH > totalEth)
    console.warn(`⚠️ total (${totalEth}) کمتر از ${recipients.length} × حداقل خرید (${MIN_BUY_ETH}) است — بعد از نرمال‌سازی، بعضی سهم‌ها از حداقل پایین‌تر می‌آیند`);

  // مجموعه‌ی خودی = معاف‌ها + کریتور + payer
  const selfSet = new Set(recipients.map((r) => r.toLowerCase()));
  selfSet.add(masterWallet().address.toLowerCase());

  const fromBlock = await resolveFromBlock(a, { quiet: a["external-abort-eth"] === undefined });
  const guard = circuit !== null
    ? new ExternalGuard(a.curve, fromBlock, selfSet, {
        minTxWei: a["min-ext-tx"] ? eth(Number(a["min-ext-tx"]).toFixed(6)) : 0n,
        windowBlocks: Math.max(0, Number(a["window-blocks"] ?? 0)),
      })
    : null;
  if (guard) console.log(`🛡️ گارد خارجی فعال: آستانه ${circuit} ETH | اسکن افزایشی از بلاک ${fromBlock} | خودی‌ها: ${selfSet.size}`);

  const gradCheck = stopOnGrad && !dryRun ? await buildGraduationChecker(a.curve) : null;

  // قیمت مرجع لحظه‌ای (برای minOut پنیک/خریدها) — قبل از تعریف guardCheck اعلان می‌شود تا در TDZ نیفتد
  let estPriceNow = null;

  async function guardCheck(tag) {
    if (!guard) return false;
    let ext;
    try {
      ext = await guard.scan();
      guard.errors = 0;
    } catch (e) {
      guard.errors++;
      console.log(`⚠️ خطا در مانیتور خارجی (${guard.errors}مین پیاپی): ${(e.shortMessage ?? e.message).slice(0, 80)}`);
      if (guard.errors >= 3) { console.log("⛔ گارد fail-closed شد: ۳ خطای پیاپی RPC — توقف امن باندل"); return true; }
      return false;
    }
    const ethFloat = Number(fmt(ext));
    const scope = guard.windowBlocks > 0 ? `(${guard.windowBlocks} بلاک اخیر)` : "(انباشته از لانچ)";
    console.log(`   👁️ [${tag}] خرید خارجی ${scope}: ${ethFloat.toFixed(4)} ETH / آستانه ${circuit}`);
    if (ethFloat < circuit) return false;
    console.log(`\n⛔ آستانه رد شد (${ethFloat.toFixed(4)} ≥ ${circuit} ETH) — توقف فوری باندل!`);
    if (panic && !dryRun) {
      const gp = await gasPrice();
      // پیش‌فرض خروج = کریتور + همه‌ی باندل‌ها؛ محدود کردن با --panic-creator-only
      const signers = [masterWallet()];
      if (!truthy(a["panic-creator-only"])) {
        const n = Number(env("WORKER_COUNT", "28"));
        try { signers.push(...deriveWorkers(n, workerStart(a)).map((w) => w.wallet)); } catch {}
      }
      await panicSellAll(a.token, a.curve, signers, gp, panicConcurrency, { estPrice: estPriceNow, slippageBps });
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
    console.log(`👁️ حالت دیده‌بان: هر ${interval}ms تا ${minutes} دقیقه…`);
    const t0 = Date.now();
    while ((Date.now() - t0) / 60000 < minutes) {
      if (await guardCheck("watch")) process.exit(0);
      if (await gradReached("watch")) { console.log("⌛ پایان دیده‌بان — گرجوئیشن رسید"); process.exit(0); }
      await sleep(interval);
    }
    console.log("⌛ پایان پنجره‌ی دیده‌بان بدون تریگر");
    return;
  }

  // ---------------- بچ‌بای ----------------
  acquireLock(truthy(a.force));
  console.log("🔴 MAINNET — پول واقعی در جریان است (پیش از این، --dry-run را کامل دیده‌ای؟)");

  const payer = payerWallet(a);
  selfSet.add(payer.address.toLowerCase());
  const minOutFlag = a["min-out"] ? BigInt(a["min-out"]) : null;
  const perDelay = Number(a.delay ?? 100);
  const curve = new Contract(a.curve, BONDING_CURVE_ABI, payer);
  // رقم اعشار واقعی توکن برای نمایش درست مقادیر (fallback = استاندارد ۱۸ پونز)
  const tokenRead = new Contract(a.token, ERC20_ABI, provider);
  let tokDec = 18;
  try { tokDec = Number(await tokenRead.decimals()); } catch { /* توکن استاندارد پونز = ۱۸ */ }

  // نرمال‌سازی: بامپ به حداقل خرید، سپس مقیاس‌کاری تا جمع دقیقاً ≤ total (هیچ ETH اضافی خرج نمی‌شود)
  let amounts = splitRandom(totalEth, recipients.length).map((x) => Math.max(x, MIN_BUY_ETH));
  const amountsSum = amounts.reduce((x, y) => x + y, 0);
  if (amountsSum > totalEth) amounts = amounts.map((x) => (x * totalEth) / amountsSum);

  // موجودی payer: total + برآورد گس واقعی (به‌جای عدد ثابت)
  let gp = await gasPrice();
  const gasReserve = gp * 150000n * BigInt(recipients.length);
  const need = eth(totalEth.toFixed(6)) + gasReserve;
  const bal = await provider.getBalance(payer.address);
  if (bal < need) {
    console.log(`⛔ موجودی پرداخت‌کننده (${payer.address}) کافی نیست: ${fmt(bal)} < ${fmt(need)} (total + رزرو گس تخمینی ${fmt(gasReserve)}) — اول payer را شارژ کن`);
    releaseLock();
    process.exit(1);
  }

  // قیمت مرجع برای minOut خریدها (ضد سندویچ): میانه‌ی آخرین معاملات کرو
  try { estPriceNow = (await marketPrice(a.curve, fromBlock, 5))?.price ?? null; } catch {}
  if (!estPriceNow && !minOutFlag) console.warn("⚠️ قیمت مرجع پیدا نشد — minOut=0 (فعلاً حفاظت لغزش نداریم؛ با --min-out صریح می‌توانی بدهی)");

  console.log(`🧺 بچ‌بای${dryRun ? " (DRY-RUN — هیچ تراکنشی ارسال نمی‌شود)" : ""} | پرداخت‌کننده: ${payer.address}
📦 کرو: ${a.curve}
👥 ${recipients.length} ولت | مجموع ${totalEth} ETH | توقف-در-گرجوئیشن: ${gradCheck ? "روشن" : "خاموش"} | لغزش minOut: ${slippageBps / 100}٪`);

  // ژورنال افزایشی: بعد از هر تراکنش روی دیسک به‌روز می‌شود → کرش = نقشه‌ی کامل وضعیت
  const journalFile = `${LAUNCHES_DIR}/${nowTag()}_batchbuy.json`;
  const journal = { payer: payer.address, curve: a.curve, token: a.token, totalEth, chainId: CHAIN.id, dryRun, stoppedBy: null, results: [], failed: [], startedAt: new Date().toISOString() };
  const J = () => fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  J();

  const results = journal.results;
  let stoppedBy = null;

  // داده‌ی خرید با minOut: اگر --min-out صریح داده‌ای همان، وگرنه تخمین از قیمت میانه
  const minOutFor = (quoteIn) => {
    if (minOutFlag !== null) return minOutFlag;
    return estMinOut(quoteIn, estPriceNow ? 1 / estPriceNow : null, slippageBps); // توکن = ETH ÷ قیمت
  };

  // DRY-RUN: فقط شبیه‌سازی همه‌ی خریدها (روی state فعلی — اثر تجمعی خریدهای قبلی شبیه‌سازی نمی‌شود؛ مستند)
  if (dryRun) {
    let ok = 0, fail = 0;
    for (let i = 0; i < recipients.length; i++) {
      const quoteIn = eth(amounts[i].toFixed(6));
      const data = curveIface.encodeFunctionData("buy", [quoteIn, minOutFor(quoteIn), recipients[i]]);
      try {
        await provider.call({ to: a.curve, data, value: quoteIn, from: payer.address });
        ok++;
        console.log(`🧪 [${i + 1}/${recipients.length}] ${recipients[i]} → ${amounts[i].toFixed(4)} ETH: شبیه‌سازی OK`);
      } catch (e) {
        fail++;
        journal.failed.push({ recipient: recipients[i], ethIn: amounts[i], error: (e.shortMessage ?? e.message).slice(0, 160) });
        console.log(`🧪❌ [${i + 1}/${recipients.length}] ${recipients[i]}: ریورت شبیه‌سازی — ${(e.shortMessage ?? e.message).slice(0, 100)}`);
      }
    }
    journal.stoppedBy = "dry-run"; J();
    releaseLock();
    console.log(`\n🧪 DRY-RUN تمام شد: ${ok} موفق، ${fail} ناموفق — هیچ تراکنشی ارسال نشد. (توجه: هر شبیه‌سازی روی state فعلی بود، نه تجمعی)`);
    process.exit(fail > 0 ? 2 : 0);
  }

  for (let i = 0; i < recipients.length; i++) {
    // ۱) گرجوئیشن رسید؟ (پیش‌فرض فعال)
    if (await gradReached(`pre-buy ${i + 1}`)) { stoppedBy = "graduation"; break; }
    // ۲) گارد خرید خارجی (هر checkEvery خرید یک‌بار + همیشه خرید اول) — خطای پیاپی RPC هم fail-closed توقف است
    if (guard && (i === 0 || i % checkEvery === 0)) {
      const tripped = await guardCheck(`pre-buy ${i + 1}`);
      if (tripped) { stoppedBy = guard.errors >= 3 ? "guard-rpc-error" : "external-guard"; break; }
    }
    const target = recipients[i];
    const quoteIn = eth(amounts[i].toFixed(6));
    const data = curveIface.encodeFunctionData("buy", [quoteIn, minOutFor(quoteIn), target]);
    try {
      // ۳) شبیه‌سازی قبل از ارسال — محافظ اصلی: اگر ریورت کند ETH از دست نمی‌رود
      await provider.call({ to: a.curve, data, value: quoteIn, from: payer.address });
      gp = await gasPrice(); // گس‌پرایس تازه برای هر تراکنش
      const tx = await payer.sendTransaction({ to: a.curve, data, value: quoteIn, gasPrice: gp });
      const rc = await tx.wait(1, 120000);
      let tokensOut = null;
      for (const log of rc.logs) {
        if (log.address.toLowerCase() === a.curve.toLowerCase() && log.topics[0] === CURVE_BUY_TOPIC) {
          const ev = curveIface.parseLog({ topics: log.topics, data: log.data });
          if (ev.args.recipient.toLowerCase() === target.toLowerCase()) tokensOut = ev.args.tokensOut;
        }
      }
      results.push({ recipient: target, ethIn: amounts[i], tx: tx.hash, tokensOut: tokensOut?.toString() ?? null, block: rc.blockNumber });
      J(); // ژورنال بعد از هر موفقیت
      console.log(`✅ [${i + 1}/${recipients.length}] ${target} | ${amounts[i].toFixed(4)} ETH | توکن: ${tokensOut ? formatUnits(tokensOut, tokDec) : "?"} | بلاک ${rc.blockNumber} | ${tx.hash}`);
    } catch (e) {
      journal.failed.push({ recipient: target, ethIn: amounts[i], error: (e.shortMessage ?? e.message).slice(0, 160) });
      J(); // حتی شکست‌ها هم ژورنال می‌شوند
      console.log(`❌ [${i + 1}/${recipients.length}] ${target}:`, (e.shortMessage ?? e.message).slice(0, 120));
      if (truthy(a["stop-on-error"])) { stoppedBy = "tx-error"; break; }
    }
    if (i < recipients.length - 1) await sleep(perDelay);
  }

  journal.stoppedBy = stoppedBy; J();

  if (stoppedBy) console.log(`⏹️ خریدها متوقف شدند — دلیل: ${{ graduation: "گرجوئیشن رسید", "external-guard": "گارد خرید خارجی", "guard-rpc-error": "خطای پیاپی RPC گارد", "tx-error": "خطای تراکنش" }[stoppedBy] ?? stoppedBy}`);

  console.log(`💾 ژورنال (${results.length}/${recipients.length} موفق، ${journal.failed.length} ناموفق): ${journalFile}`);

  if (!stoppedBy) {
    console.log("\n— کنترل موجودی نهایی (از خود کانترکت توکن) —");
    for (const r of results) {
      const b = await tokenRead.balanceOf(r.recipient);
      console.log(`${r.recipient}: ${formatUnits(b, tokDec)}`);
    }
  } else {
    console.log("⚠️ اجرا ناقص بود — ولت‌های بدون توکن در ژورنال مشخص‌اند؛ می‌توانی با همان لیست ادامه بدهی یا با panic خارج شوی.");
  }
  releaseLock();
}

main().catch((e) => { releaseLock(); console.error("خطا:", e.shortMessage ?? e.message); process.exit(1); });
