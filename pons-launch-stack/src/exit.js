// 🎯 خروج خودکار هدف‌دار بر اساس سود خالص «پس از ایمپکت» — همه‌چیز از آنچین (بدون هاردکد سرمایه)
//
// مدل محاسبه (در هر چرخه‌ی رصد، ~هر بلاک — سرمایه و فلوت هر بار تازه، نه اسکن یک‌باره):
//   سرمایه  = جمع quoteIn همه‌ی خریدهای خودی از رویدادها (دقیق، حتی اگر batch-buy هنوز در جریان باشد)
//   فلوت    = توکن‌های خالص خارج از کرو = Σ tokensOut(buys) − Σ tokensIn(sells)
//   قیمت    = میانه‌ی نمایشی آخرین K معامله (خرید و فروش، بدون اینکه تیک تکی منحرف کند)
//   ایمپکت  = مدل خطی: فروش Q توکن روی فلوت F، میانگین پرشدنی ≈ مارک × (۱ − Q/(2F))
//   خالص    = مارک × ایمپکت × (۱ − فی)
// تریگر (پیش‌فرض: سود خالص ≥ ۱۰۰٪ یعنی دریافتی ≥ ۲× سرمایه «بعد» از ایمپکت/فی):
//   node src/exit.js --curve 0xC --token 0xT --launch-tx 0x<هش لانچ>
//   node src/exit.js --curve 0xC --token 0xT --launch-tx 0x... --min-profit-pct 125 --fee-bps 300
import { Contract, Wallet } from "ethers";
import { env, parseArgs } from "./config.js";
import { ERC20_ABI } from "./abis.js";
import { provider, masterWallet, deriveWorkers, workerStart, truthy, numOpt, fmt, gasPrice, sleep, uniqueSigners, legacyHd } from "./lib.js";
import { curveTrades, panicSellAll, median, marketPrice } from "./market.js";

// ─── فرمول سود (اصلاح‌شده‌ی ممیزی ۲): بازده کل = (عایدی فروش‌های قبلی + ارزش خالص فعلی) نسبت به کل خرید ───
// قبلاً عایدی از مبنا کم می‌شد و سود فقط روی مبنای باقی‌مانده — تریگر زودهنگام (مثال: خرید ۱۰۰، فروش ۶۰،
// ارزش باقی‌مانده ۸۰ ⇒ سود واقعی ۴۰٪ ولی فرمول قدیمی ۱۰۰٪ گزارش می‌داد).
export function profitTotalPct(spentEth, proceedsEth, realizedNetEth) {
  if (!(spentEth > 0)) return realizedNetEth + proceedsEth > 0 ? Infinity : 0;
  return ((proceedsEth + realizedNetEth) - spentEth) / spentEth * 100;
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
  console.warn(`⚠️ --launch-tx/--from-block داده نشده؛ اسکن از بلاک ${Math.max(0, latest - 500)} — سرمایه‌ی قدیمی‌تر شمرده نمی‌شود!`);
  return Math.max(0, latest - 500);
}

async function main() {
  const a = parseArgs();
  if (!a.curve || !a.token) {
    console.log(`لازم: --curve 0x.. --token 0x..
خروج خودکار وقتی «سود خالصِ پس از ایمپکت» به آستانه برسد (پیش‌فرض ۱۰۰٪ = دریافتی ۲ برابر سرمایه).
اختیاری‌ها:
  --launch-tx 0x..         بلاک شروع اسکن سرمایه/قیمت (توصیه‌شده)
  --min-profit-pct 100     آستانه‌ی سود خالص پس از ایمپکت/فی (پیش‌فرض ۱۰۰٪)
  --target-mult 2          (معادل قدیمی؛ mult ت هدف = (t−1)×۱۰۰٪ سود)
  --impact-model linear    linear (مدل فلوت) | fixed (تخفیف ثابت --impact-discount، پیش‌فرض ۰٫۳۵)
  --fee-bps 300            فرض مجموع فی+مالیات فروش (۳٪)
  --price-trades 5         تعداد آخرین معاملات برای قیمت میانه
  --interval-ms 1200       فاصله‌ی چک (پیش‌فرض ~بلاک)
  --worker-start 0         offset مشتق‌گیری کارگرها (با batch-buy هماهنگ نگه دار)
  --self-extra 0x..,0x..    آدرس‌های خودیِ اضافی (فقط رصد؛ امضا ندارند)
  --concurrency 6          هم‌زمانی خروج موازی
  --panic-max-attempts 8   پس از این تعداد پنیکِ ناقص، با کد ۲ و لیست ولت‌های دارای موجودی خارج می‌شود
  --legacy-hd              مسیر قدیمی اشتباه HD (فقط بازیابی لانچ‌های قبل از اصلاح BIP44)
  --max-minutes 0          سقف زمان اجرا (۰ = بی‌نهایت)`);
    process.exit(1);
  }

  // آستانه‌ی سود: --target-mult هم پشتیبانی می‌شود (به سود٪ تبدیل)
  let minProfitPct = Number(a["min-profit-pct"] ?? 100);
  if (a["target-mult"]) minProfitPct = (Number(a["target-mult"]) - 1) * 100;
  const impactModel = a["impact-model"] ?? "linear";
  const impactFixed = Number(a["impact-discount"] ?? 0.35);
  const feeBps = Number(a["fee-bps"] ?? 300);
  const k = Number(a["price-trades"] ?? 5);
  const interval = Number(a["interval-ms"] ?? 1200);
  const concurrency = Math.max(1, Number(a["concurrency"] ?? 6));
  const maxMin = Number(a["max-minutes"] ?? 0);
  const maxPanicAttempts = Math.max(1, Number(a["panic-max-attempts"] ?? 8));
  let panicAttempts = 0;

  // امضاکننده‌ها (کریتور + کارگرها + payer) — مبنای سرمایه/دارایی/خروج — یونیک می‌شوند (تصادم nonce!)
  const signerSet = new Set();
  const legacy = legacyHd(a);
  const all = [masterWallet()];
  const wc = Number(env("WORKER_COUNT", "28"));
  const wStart = workerStart(a);
  try { all.push(...deriveWorkers(wc, wStart, { legacy }).map((w) => w.wallet)); } catch {
    console.warn("⚠️ MNEMONIC تنظیم نشده — فقط کریتور رصد/خروج می‌شود");
  }
  const payerPk = env("BATCH_PAYER_PRIVATE_KEY");
  if (payerPk) { try { all.push(new Wallet(payerPk, provider)); } catch {} }
  const signers = uniqueSigners(all);
  signers.forEach((s) => signerSet.add(s.address.toLowerCase()));
  if (legacy) console.log("🕰️ حالت --legacy-hd: مسیر قدیمی اشتباه (m/44'/60'/0'/0/0/i) برای بازیابی ولت‌های لانچ‌های پیشین");
  // خودیِ رصد-فقط (بدون کلید): نه در مبنای سرمایه نه در دارایی — فقط نمایش لاگ
  const monitorSet = new Set();
  (a["self-extra"] ?? "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("0x"))
    .forEach((s) => { if (!signerSet.has(s.toLowerCase())) monitorSet.add(s.toLowerCase()); });
  const slippageBps = numOpt(a["slippage-bps"], Number(env("SLIPPAGE_BPS", "800")), { min: 0, max: 5000, name: "slippage-bps" });

  const fromBlock = await resolveFromBlock(a);
  const token = new Contract(a.token, ERC20_ABI, provider);
  const feeFactor = 1 - feeBps / 10000;
  const neededMult = 1 + minProfitPct / 100;
  let exitAnomalyWarned = false;
  console.log(`🎯 هدف: سود خالص ≥ ${minProfitPct}٪ «پس از» ایمپکت+فی | مدل ${impactModel} | فی ${feeBps / 100}٪ | امضاکننده‌ها ${signerSet.size}${monitorSet.size ? ` + رصد-فقط ${monitorSet.size}` : ""} (worker-start=${wStart})`);
  console.log("   (مبنای سرمایه = جمع خریدهای خودی منهای فروش‌های خودی — هر چرخه از رویدادهای تازه)");

  const t0 = Date.now();
  let exiting = false; // ماشین‌حالت: وقتی خروج شروع شود، تا تعیین‌تکلیف همه‌ی ولت‌ها ادامه دارد — مستقل از شرط سود
  while (true) {
    if (maxMin > 0 && (Date.now() - t0) / 60000 > maxMin) { console.log("⌛ پایان پنجره‌ی زمانی بدون تریگر"); return; }
    try {
      // ── فاز تخلیه (پس از شروع خروج): شرط سود دیگر معنا ندارد؛ فقط ولت‌های دارای توکن می‌مانند ──
      if (exiting) {
        let totalLeft = 0n;
        const holders = [];
        for (const s of signers) {
          try { const b = await token.balanceOf(s.address); if (b > 0n) { totalLeft += b; holders.push(s); } } catch {}
        }
        if (holders.length === 0) {
          console.log("\n✅ تخلیه‌ی کامل تأیید شد (موجودی توکن همه‌ی امضاکنندگان صفر است).");
          return;
        }
        panicAttempts++;
        console.log(`🔁 تخلیه ادامه دارد (تلاش ${panicAttempts}/${maxPanicAttempts}): ${holders.length} ولت هنوز توکن دارند…`);
        if (panicAttempts > maxPanicAttempts) {
          console.log(`⛔ خروج پس از ${maxPanicAttempts} تلاش کامل نشد. ولت‌های دارای موجودی:\n${holders.map((h) => h.address).join("\n")}\nاقدام دستی: sell.js یا (پس از گرجوئیشن) --ur-data مستقیم برای این ولت‌ها`);
          process.exitCode = 2;
          return;
        }
        // minOut تخلیه: اگر قیمت پیدا شود محافظت می‌کنیم، وگرنه صریح warning می‌گذرد (در panic اجباری نیست)
        let anchorPrice2 = null;
        try { const mp = await marketPrice(a.curve, fromBlock, k); anchorPrice2 = mp?.last ?? mp?.price ?? null; } catch {}
        const gp = await gasPrice();
        await panicSellAll(a.token, a.curve, holders, gp, concurrency, { estPrice: anchorPrice2, slippageBps });
        await sleep(Math.max(2000, interval));
        continue;
      }

      // ۱) معاملات تازه — برای سرمایه، فلوت و قیمت (همه از یک اسکن)
      const trades = await curveTrades(a.curve, fromBlock);

      // ۲) سرمایه و عایدی: کل خریدهای خودی (spent) ثابت است؛ عایدی فروش‌های خودی (proceeds) جمع می‌شود.
      //    سود = بازده کل: (عایدی قبلی + ارزش خالص فروش موجودی فعلی) − کل خرید  ⟵ فرمول اصلاح‌شده
      let spent = 0n, selfProceeds = 0n, monitorBuys = 0n;
      const selfBuyWallets = new Set();
      for (const t of trades) {
        if (t.type === "buy") {
          if (signerSet.has(t.who)) { spent += t.quote; selfBuyWallets.add(t.who); }
          else if (monitorSet.has(t.who)) monitorBuys += t.quote;
        } else if (t.type === "sell" && signerSet.has(t.who)) {
          selfProceeds += t.quote;
        }
      }
      const spentEth = Number(fmt(spent));
      const proceedsEth = Number(fmt(selfProceeds));
      if (!(spentEth > 0)) { console.log("— هنوز خرید خودی‌ای دیده نمی‌شود — صبر…"); await sleep(interval); continue; }

      // ۳) موجودی زنده‌ی توکن خودی‌ها
      let totTokensWei = 0n;
      for (const s of signers) {
        try { totTokensWei += await token.balanceOf(s.address); } catch {}
      }
      if (totTokensWei === 0n) { console.log("— موجودی توکن خودی صفر است (خارج شده؟) — صبر…"); await sleep(interval); continue; }

      // ۳+۴) محاسبه با «واحد خام» توکن — مستقل از decimals توکن (برای ۱۸رقمی دقیقاً همان نتیجه‌ی قبل)
      const selfRaw = Number(totTokensWei);
      // ۴) فلوت و قیمت میانه‌ی آخرین k معامله
      let floatWei = 0n;
      for (const t of trades) floatWei += (t.type === "buy" ? t.tokens : -t.tokens);
      if (floatWei < 0n && !exitAnomalyWarned) { exitAnomalyWarned = true; console.warn("⚠️ فلوت منفی محاسبه شد (ناهنجاری داده — مثلاً اسکن از بلاک دیرتر از لانچ). مقدار به خودی clamp می‌شود."); }
      const floatRaw = Math.max(Number(floatWei), selfRaw); // فلوت نمی‌تواند از خودی‌ها کمتر باشد
      const last = trades.filter((t) => t.tokens > 0n).slice(-k);
      if (!last.length) { console.log("— هنوز معامله‌ای برای قیمت نیست — صبر…"); await sleep(interval); continue; }
      const price = median(last.map((t) => Number(t.quote) / Number(t.tokens))); // wei به ازای هر واحد خام

      // ۵) مارک و ایمپکت — مارک = (توکن‌خام × wei/توکن‌خام) ÷ ۱۰^۱۸ = ETH (مستقل از decimals)
      const mark = (selfRaw * price) / 1e18;
      let fillFactor;
      if (impactModel === "linear") {
        // خروج Q=خودی روی فلوت F: میانگین پرشدنی نزولی خطی ≈ مارک × (۱ − Q/(2F))
        fillFactor = Math.max(0.1, Math.min(1, 1 - selfRaw / (2 * floatRaw)));
      } else {
        fillFactor = 1 - impactFixed;
      }
      const realized = mark * fillFactor * feeFactor; // ارزش خالص فروش موجودی فعلی (پس از ایمپکت/فی)
      // فرمول اصلاح‌شده: سود = بازده کل = (proceeds قبلی + realized فعلی) نسبت به کل خرید (spent)
      const profitPct = profitTotalPct(spentEth, proceedsEth, realized);
      // ضریب مارک لازم: به ازای مختلفِ آن: requiredMark = (spent×ضریب‌هدف − proceeds)/ایمپکت×فی
      const requiredMark = (spentEth * neededMult - proceedsEth) / (fillFactor * feeFactor);
      const reqMarkMult = mark > 0 ? requiredMark / mark : Infinity;

      const selfShow = Number(fmt(totTokensWei)).toLocaleString("fa-IR", { maximumFractionDigits: 0 });
      const floatShow = Number(fmt(floatWei)).toLocaleString("fa-IR", { maximumFractionDigits: 0 });
      const monitorTag = monitorSet.size && monitorBuys > 0n ? ` | 👁️ رصد-فقط خرید: ${Number(fmt(monitorBuys)).toFixed(3)}` : "";
      console.log(`💰 خرج ${spentEth.toFixed(4)} ETH | عایدی قبلی ${proceedsEth.toFixed(4)} (${selfBuyWallets.size} ولت)${monitorTag} | 📈 خودی ${selfShow} / فلوت ${floatShow} | ضریب مارک ${(spentEth > 0 ? mark / spentEth : 0).toFixed(2)}× (لازم: ${reqMarkMult === Infinity ? "∞" : reqMarkMult.toFixed(2)}×) | پرشدنی ×${fillFactor.toFixed(3)} | ارزش خالص فعلی ~${realized.toFixed(4)} | بازده کل ~${(proceedsEth + realized).toFixed(4)} | سود ${profitPct === Infinity ? "∞" : profitPct.toFixed(0)}٪ / آستانه ${minProfitPct}٪`);

      if (profitPct >= minProfitPct) {
        console.log(`\n🎯 هدف رسید: سود خالص پس از ایمپکت = ${profitPct === Infinity ? "∞" : profitPct.toFixed(0) + "٪"} ≥ ${minProfitPct}٪ — خروج موازی کامل الان!\n`);
        let before = 0n;
        for (const s of signers) { try { before += await provider.getBalance(s.address); } catch {} }
        const gp = await gasPrice();
        // anchor: قیمت آخرین معامله واقعی — نزدیک‌تر به پرشدنی تا minOut واقع‌بینانه باشد
        let anchorPrice = price;
        try { const mp = await marketPrice(a.curve, fromBlock, k); anchorPrice = mp?.last ?? mp?.price ?? price; } catch {}
        const pres = await panicSellAll(a.token, a.curve, signers, gp, concurrency, { estPrice: anchorPrice, slippageBps });
        await sleep(2500);
        let after = 0n;
        for (const s of signers) { try { after += await provider.getBalance(s.address); } catch {} }
        const received = Number(fmt(after - before));
        if (pres.fail > 0) {
          // شروع حالت تخلیه: از این نقطه شرط سود دیگر تنظیم‌کننده نیست و ولت‌های دارای توکن تا پایان جنگیده می‌شوند
          exiting = true;
          console.log(`⚠️ خروج «ناقص» بود: ${pres.fail} ولت ناموفق — حالت تخلیه فعال شد؛ رصد/تخلیه بدون شرط سود ادامه دارد…`);
          continue;
        }
        console.log(`💵 بازده کل واقعی پس از خروج (عایدی قبلی + دلتای این خروج): ${(proceedsEth + received).toFixed(4)} ETH${spentEth > 0 ? ` = ${((proceedsEth + received) / spentEth).toFixed(2)}× سرمایه (سود واقعی ${(((proceedsEth + received) / spentEth - 1) * 100).toFixed(0)}٪)` : ""}`);
        if (spentEth > 0 && (proceedsEth + received) / spentEth < neededMult) console.log(`⚠️ پرشدنی واقعی زیر مدل آمد (${((proceedsEth + received) / spentEth).toFixed(2)} < ${neededMult.toFixed(2)}) — تخفیف/فی را محافظه‌کارتر کن`);
        return;
      }
    } catch (e) {
      console.log("⚠️ خطا در چرخه‌ی رصد:", (e.shortMessage ?? e.message).slice(0, 120));
    }
    await sleep(interval);
  }
}

// اجرا فقط به‌صورت مستقیم CLI — هنگام import (مثلاً تست‌ها) تابع‌های خالص بدون اجرای main صادر می‌شوند
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("خطا:", e.shortMessage ?? e.message); process.exit(1); });
