// خرید باندلی «یک‌جا بخر، پخش کن» — الگوی فارم: یک ولت پرداخت‌کننده، توکن برای همه‌ی ولت‌های معاف
// + دیده‌بان خرید خارجی: رد آستانه → توقف باندل + خروج موازی کامل (پیش‌فرض: کریتور + همه‌ی باندل‌ها)
// + توقف خودکار در گرجوئیشن (پیش‌فرض روشن)
// + سپرهای امنیتی: ولیدیشن آدرس‌ها، --launch-file (کرو/توکن + چک recipient ⊆ exemptions)،
//   شبیه‌سازی eth_call قبل از هر ارسال، --dry-run (بدون هیچ ارسالی)، نرمال‌سازی مبالغ به ≤ total
//
// امضای وریفای‌شده‌ی کرو: buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable
// توکن مستقیم در کیف هر ولت معاف می‌نشیند. recipientها باید موقع لانچ در snipeTaxExemptions ثبت شده باشند
// تا مالیات اسنایپ نخورند. ولت payer باید پیش از اجرا total + ~۰٫۰۰۲ ETH موجودی داشته باشد.
import fs from "node:fs";
import { Contract, Interface, Wallet, id, isAddress, formatUnits } from "ethers";
import { ADDR, LAUNCHES_DIR, env, parseArgs } from "./config.js";
import { BONDING_CURVE_ABI, ERC20_ABI } from "./abis.js";
import { provider, masterWallet, deriveWorkers, workerStart, eth, fmt, gasPrice, splitRandom, nowTag, sleep } from "./lib.js";
import { panicSellAll } from "./market.js";

const panicSell = (tokenAddr, curveAddr, signers, gp, conc) => panicSellAll(tokenAddr, curveAddr, signers, gp, conc);
const MIN_BUY_ETH = 0.0005;

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

// ---------------- دیده‌بان خرید خارجی ----------------
const curveIface = new Interface(BONDING_CURVE_ABI);
const CURVE_BUY_TOPIC = curveIface.getEvent("CurveBuy").topicHash;

// اسکن CurveBuy از fromBlock؛ هر خریدی که recipientش «خودی» نباشد خارجی است.
// windowBlocks>0 ⇒ فقط N بلاک اخیر | minTxWei ⇒ حذف گردوخاک ریز
async function externalSpendWei(curveAddr, fromBlock, selfSet, { minTxWei = 0n, windowBlocks = 0 } = {}) {
  const latest = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: curveAddr,
    topics: [CURVE_BUY_TOPIC],
    fromBlock,
    toBlock: "latest",
  });
  const blockFloor = windowBlocks > 0 ? Math.max(fromBlock, latest - windowBlocks) : fromBlock;
  let ext = 0n;
  for (const lg of logs) {
    if (lg.blockNumber < blockFloor) continue;
    try {
      const ev = curveIface.parseLog({ topics: lg.topics, data: lg.data });
      const rec = ev.args.recipient.toLowerCase();
      const q = BigInt(ev.args.quoteIn);
      if (!selfSet.has(rec) && q >= minTxWei) ext += q;
    } catch {}
  }
  return ext;
}

async function resolveFromBlock(a) {
  if (a["launch-tx"]) {
    try {
      const rc = await provider.getTransactionReceipt(a["launch-tx"]);
      if (rc) return rc.blockNumber;
    } catch {}
  }
  if (a["from-block"]) return Number(a["from-block"]);
  const latest = await provider.getBlockNumber();
  console.warn(`⚠️ --launch-tx/--from-block داده نشده؛ اسکن از بلاک ${Math.max(0, latest - 500)} — خریدهای خارجی قدیمی‌تر دیده نمی‌شوند!`);
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

async function main() {
  const a = parseArgs();
  const watchOnly = !!a["watch-only"];
  const dryRun = !!a["dry-run"];
  let recipients = readRecipients(a);

  // ---- --launch-file: تزریق کرو/توکن از رکورد لانچ + چک سخت‌گیرانه recipient ⊆ exemptions ----
  if (a["launch-file"]) {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(a["launch-file"], "utf8")); } catch (e) {
      console.log("⛔ خواندن launch-file شکست خورد:", e.message); process.exit(1);
    }
    if (!a.curve || a.curve === "true") a.curve = rec.curve;
    if (!a.token || a.token === "true") a.token = rec.token;
    if (!a["launch-tx"] && rec.txHash) a["launch-tx"] = rec.txHash;
    // آفست مشتق‌گیری هم از رکورد می‌آید تا recipients/panic دقیقاً همان مجموعه‌ی exemptions باشند
    if (a["worker-start"] === undefined && rec.workerStart !== undefined) {
      a["worker-start"] = String(rec.workerStart);
      console.log(`📄 worker-start از رکورد لانچ خوانده شد: ${rec.workerStart}`);
    }
    // اگر recipient داده نشده ولی رکورد لانچ exemptions دارد → همان‌ها recipient می‌شوند (دقیق‌ترین منبع)
    if ((!recipients || recipients.length === 0) && Array.isArray(rec.exemptions) && rec.exemptions.length) {
      recipients = rec.exemptions;
      console.log(`📄 recipientها از exemptions رکورد لانچ خوانده شد (${recipients.length} ولت)`);
    }
    if (recipients && Array.isArray(rec.exemptions) && rec.exemptions.length) {
      const exSet = new Set(rec.exemptions.map((x) => x.toLowerCase()));
      const extra = recipients.filter((r) => !exSet.has(r.toLowerCase()));
      if (extra.length) {
        console.log(`⛔ این recipientها در exemptions لانچ ثبت نشده‌اند (مالیات اسنایپ می‌خورند!): ${extra.join(", ")} — لغو شد.`);
        process.exit(1);
      }
      if (recipients.length !== rec.exemptions.length)
        console.warn(`⚠️ تعداد recipientها (${recipients.length}) با exemptions (${rec.exemptions.length}) فرق دارد — عمدی است؟`);
    }
    console.log(`📄 از رکورد لانچ: curve=${a.curve} token=${a.token} launchTx=${a["launch-tx"] ?? "?"}`);
  }

  if (!a.curve || !a.token || (!watchOnly && (!a.total || !recipients || recipients.length === 0))) {
    console.log(`لازم:
  --curve 0x.. --token 0x.. --total 3.0  و  یکی از --recipients/--recipients-file/--workers
  (یا --launch-file launches/launch_XXX.json — کرو/توکن/launch-tx را از رکورد می‌گیرد + recipientها را با exemptions چک می‌کند)
اختیاری‌ها:
  --dry-run               شبیه‌سازی کامل همه‌ی خریدها بدون هیچ ارسالی (اولین اجرا حتماً!)
  --launch-tx 0x..        بلاک اسکن خرید خارجی از رسید لانچ (توصیه‌شده)
  --external-abort-eth 2  آستانه‌ی خرید خارجی (ETH) → توقف باندل | پیشنهاد: ۱۵–۳۰٪ total
  --min-ext-tx 0.02       حذف گردوخاک ریز از شمارش خارجی
  --window-blocks 200     فقط N بلاک اخیر شمرده شود (نگهبانی)
  --panic-sell            خروج موازی کامل کریتور + همه‌ی باندل‌ها هنگام تریگر (پیش‌فرض)
  --panic-creator-only    فقط کریتور خارج شود | --panic-concurrency 6
  --watch-only            فقط دیده‌بان  |  --watch-minutes 30
  --check-every 3         هر چند خرید یک‌بار گارد چک شود
  --worker-start 0        آفست مشتق‌گیری کارگرها (با launch/fund/exit یکی باشد؛ با launch-file خودکار از رکورد می‌آید)
  --ignore-graduation     توقف‌در‌گرجوئیشن را خاموش می‌کند (پیش‌فرض روشن)`);
    process.exit(1);
  }

  // ---- ولیدیشن آدرس‌ها (قبل از هر پرداخت) ----
  for (const [name, addr] of [["curve", a.curve], ["token", a.token]]) {
    if (!isAddress(addr)) { console.log(`⛔ آدرس ${name} نامعتبر است: ${addr}`); process.exit(1); }
  }
  if (recipients) {
    const bad = recipients.filter((r) => !isAddress(r));
    if (bad.length) { console.log("⛔ آدرس نامعتبر در recipientها:", bad.join(", ")); process.exit(1); }
  }

  const circuit = a["external-abort-eth"] !== undefined ? Number(a["external-abort-eth"]) : null;
  const panic = !!a["panic-sell"];
  const checkEvery = Math.max(1, Number(a["check-every"] ?? 3));
  const stopOnGrad = !a["ignore-graduation"];

  // مجموعه‌ی خودی = معاف‌ها + کریتور + payer
  const selfSet = new Set((recipients ?? []).map((r) => r.toLowerCase()));
  selfSet.add(masterWallet().address.toLowerCase());

  let fromBlock = null;
  if (circuit !== null) {
    fromBlock = await resolveFromBlock(a);
    console.log(`🛡️ گارد خارجی فعال: آستانه ${circuit} ETH | اسکن از بلاک ${fromBlock} | خودی‌ها: ${selfSet.size}`);
  }

  const gradCheck = stopOnGrad && !dryRun ? await buildGraduationChecker(a.curve) : null;

  const minExtTx = a["min-ext-tx"] ? eth(Number(a["min-ext-tx"]).toFixed(6)) : 0n;
  const windowBlocks = Math.max(0, Number(a["window-blocks"] ?? 0));
  const panicConcurrency = Math.max(1, Number(a["panic-concurrency"] ?? 6));

  async function guardCheck(tag) {
    if (circuit === null) return false;
    let ext;
    try { ext = await externalSpendWei(a.curve, fromBlock, selfSet, { minTxWei: minExtTx, windowBlocks }); }
    catch (e) { console.log(`⚠️ خطا در مانیتور خارجی (${(e.shortMessage ?? e.message).slice(0, 80)}) — ادامه…`); return false; }
    const ethFloat = Number(fmt(ext));
    const scope = windowBlocks > 0 ? `(${windowBlocks} بلاک اخیر)` : "(انباشته از لانچ)";
    console.log(`   👁️ [${tag}] خرید خارجی ${scope}: ${ethFloat.toFixed(4)} ETH / آستانه ${circuit}`);
    if (ethFloat < circuit) return false;
    console.log(`\n⛔ آستانه رد شد (${ethFloat.toFixed(4)} ≥ ${circuit} ETH) — توقف فوری باندل!`);
    if (panic && !dryRun) {
      const gp = await gasPrice();
      // پیش‌فرض خروج = کریتور + همه‌ی باندل‌ها؛ محدود کردن با --panic-creator-only
      // دقت: offset مشتق‌گیری ولت‌ها با --worker-start باید با بچ‌بای هماهنگ باشد
      const signers = [masterWallet()];
      if (!a["panic-creator-only"]) {
        const n = Number(env("WORKER_COUNT", "28"));
        const wStart = workerStart(a);
        try { signers.push(...deriveWorkers(n, wStart).map((w) => w.wallet)); } catch {}
      }
      await panicSell(a.token, a.curve, signers, gp, panicConcurrency);
    }
    return true;
  }

  async function gradReached(tag) {
    if (!gradCheck) return false;
    const g = await gradCheck();
    if (g.graduated) console.log(`🎓 [${tag}] گرجوئیشن تشخیص داده شد (${g.how})`);
    return g.graduated;
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
  const payer = payerWallet(a);
  selfSet.add(payer.address.toLowerCase());
  const totalEth = Number(a.total);
  const minOut = a["min-out"] ? BigInt(a["min-out"]) : 0n;
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

  const bal = await provider.getBalance(payer.address);
  const need = eth((totalEth + 0.002).toFixed(6));
  if (bal < need) {
    console.log(`⛔ موجودی پرداخت‌کننده (${payer.address}) کافی نیست: ${fmt(bal)} < ${fmt(need)} — اول payer را شارژ کن`);
    process.exit(1);
  }
  console.log(`🧺 بچ‌بای${dryRun ? " (DRY-RUN — هیچ تراکنشی ارسال نمی‌شود)" : ""} | پرداخت‌کننده: ${payer.address}
📦 کرو: ${a.curve}
👥 ${recipients.length} ولت | مجموع ${totalEth} ETH | توقف-در-گرجوئیشن: ${gradCheck ? "روشن" : "خاموش"}`);

  const gp = await gasPrice();
  const results = [];
  let stoppedBy = null;

  // DRY-RUN: فقط شبیه‌سازی همه‌ی خریدها
  if (dryRun) {
    let ok = 0, fail = 0;
    for (let i = 0; i < recipients.length; i++) {
      const quoteIn = eth(amounts[i].toFixed(6));
      const data = curveIface.encodeFunctionData("buy", [quoteIn, minOut, recipients[i]]);
      try {
        await provider.call({ to: a.curve, data, value: quoteIn, from: payer.address });
        ok++;
        console.log(`🧪 [${i + 1}/${recipients.length}] ${recipients[i]} → ${amounts[i].toFixed(4)} ETH: شبیه‌سازی OK`);
      } catch (e) {
        fail++;
        console.log(`🧪❌ [${i + 1}/${recipients.length}] ${recipients[i]}: ریورت شبیه‌سازی — ${(e.shortMessage ?? e.message).slice(0, 100)}`);
      }
    }
    console.log(`\n🧪 DRY-RUN تمام شد: ${ok} موفق، ${fail} ناموفق — هیچ تراکنشی ارسال نشد.`);
    process.exit(fail > 0 ? 2 : 0);
  }

  for (let i = 0; i < recipients.length; i++) {
    // ۱) گرجوئیشن رسید؟ (پیش‌فرض فعال)
    if (await gradReached(`pre-buy ${i + 1}`)) { stoppedBy = "graduation"; break; }
    // ۲) گارد خرید خارجی (هر checkEvery خرید یک‌بار + همیشه خرید اول)
    if (circuit !== null && (i === 0 || i % checkEvery === 0)) {
      if (await guardCheck(`pre-buy ${i + 1}`)) { stoppedBy = "external-guard"; break; }
    }
    const target = recipients[i];
    const quoteIn = eth(amounts[i].toFixed(6));
    const data = curveIface.encodeFunctionData("buy", [quoteIn, minOut, target]);
    try {
      // ۳) شبیه‌سازی قبل از ارسال — محافظ اصلی: اگر ریورت کند ETH از دست نمی‌رود
      await provider.call({ to: a.curve, data, value: quoteIn, from: payer.address });
      const tx = await payer.sendTransaction({ to: a.curve, data, value: quoteIn, gasPrice: gp });
      const rc = await tx.wait();
      let tokensOut = null;
      for (const log of rc.logs) {
        if (log.address.toLowerCase() === a.curve.toLowerCase() && log.topics[0] === CURVE_BUY_TOPIC) {
          const ev = curveIface.parseLog({ topics: log.topics, data: log.data });
          if (ev.args.recipient.toLowerCase() === target.toLowerCase()) tokensOut = ev.args.tokensOut;
        }
      }
      results.push({ recipient: target, ethIn: amounts[i], tx: tx.hash, tokensOut: tokensOut?.toString() ?? null, block: rc.blockNumber });
      console.log(`✅ [${i + 1}/${recipients.length}] ${target} | ${amounts[i].toFixed(4)} ETH | توکن: ${tokensOut ? formatUnits(tokensOut, tokDec) : "?"} | بلاک ${rc.blockNumber} | ${tx.hash}`);
    } catch (e) {
      console.log(`❌ [${i + 1}/${recipients.length}] ${target}:`, (e.shortMessage ?? e.message).slice(0, 120));
      if (a["stop-on-error"]) { stoppedBy = "tx-error"; break; }
    }
    if (i < recipients.length - 1) await sleep(perDelay);
  }

  if (stoppedBy) console.log(`⏹️ خریدها متوقف شدند — دلیل: ${stoppedBy === "graduation" ? "گرجوئیشن رسید" : stoppedBy === "external-guard" ? "گارد خرید خارجی" : "خطای تراکنش"}`);

  // رکورد همیشه ذخیره می‌شود — حتی ناقص (ولت‌های خریداری‌شده برای بازیابی مهم‌اند)
  const file = `${LAUNCHES_DIR}/${nowTag()}_batchbuy.json`;
  fs.writeFileSync(file, JSON.stringify({ payer: payer.address, curve: a.curve, token: a.token, totalEth, dryRun: false, stoppedBy, completed: results.length, of: recipients.length, results }, null, 2));
  console.log(`💾 ذخیره شد (${results.length}/${recipients.length} خرید موفق): ${file}`);

  if (!stoppedBy) {
    console.log("\n— کنترل موجودی نهایی (از خود کانترکت توکن) —");
    for (const r of results) {
      const b = await tokenRead.balanceOf(r.recipient);
      console.log(`${r.recipient}: ${formatUnits(b, tokDec)}`);
    }
  } else {
    console.log("⚠️ اجرا ناقص بود — ولت‌های بدون توکن در فایل بالا مشخص‌اند؛ می‌توانی با همان لیست ادامه بدهی یا با panic خارج شوی.");
  }
}

main().catch((e) => { console.error("خطا:", e.shortMessage ?? e.message); process.exit(1); });
