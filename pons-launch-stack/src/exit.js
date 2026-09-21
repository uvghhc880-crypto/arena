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
import { provider, masterWallet, deriveWorkers, workerStart, fmt, gasPrice, sleep } from "./lib.js";
import { curveTrades, panicSellAll, median } from "./market.js";

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

  // مجموعه‌ی خودی + امضاکننده‌ها (کریتور + کارگرها + payer) — offset با batch_buy یکی
  const selfSet = new Set();
  const signers = [masterWallet()];
  const wc = Number(env("WORKER_COUNT", "28"));
  const wStart = workerStart(a);
  try { signers.push(...deriveWorkers(wc, wStart).map((w) => w.wallet)); } catch {
    console.warn("⚠️ MNEMONIC تنظیم نشده — فقط کریتور رصد/خروج می‌شود");
  }
  const payerPk = env("BATCH_PAYER_PRIVATE_KEY");
  if (payerPk) { try { const w = new Wallet(payerPk, provider); signers.push(w); } catch {} }
  signers.forEach((s) => selfSet.add(s.address.toLowerCase()));
  (a["self-extra"] ?? "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("0x"))
    .forEach((s) => selfSet.add(s.toLowerCase()));

  const fromBlock = await resolveFromBlock(a);
  const token = new Contract(a.token, ERC20_ABI, provider);
  const feeFactor = 1 - feeBps / 10000;
  const neededMult = 1 + minProfitPct / 100;
  console.log(`🎯 هدف: سود خالص ≥ ${minProfitPct}٪ «پس از» ایمپکت+فی | مدل ${impactModel} | فی ${feeBps / 100}٪ | خودی‌ها ${selfSet.size} (worker-start=${wStart})`);
  console.log("   (سرمایه هر چرخه از رویدادهای تازه بازمحاسبه می‌شود — هاردکد نیست)");

  const t0 = Date.now();
  while (true) {
    if (maxMin > 0 && (Date.now() - t0) / 60000 > maxMin) { console.log("⌛ پایان پنجره‌ی زمانی بدون تریگر"); return; }
    try {
      // ۱) معاملات تازه — برای سرمایه، فلوت و قیمت (همه از یک اسکن)
      const trades = await curveTrades(a.curve, fromBlock);

      // ۲) سرمایه‌ی واقعی پرداخت‌شده از رویدادهای خرید خودی (هر چرخه تازه)
      let spent = 0n;
      const selfBuyWallets = new Set();
      for (const t of trades) {
        if (t.type === "buy" && selfSet.has(t.who)) { spent += t.quote; selfBuyWallets.add(t.who); }
      }
      const spentEth = Number(fmt(spent));
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
      const realized = mark * fillFactor * feeFactor;
      const profitPct = (realized - spentEth) / spentEth * 100;
      // ضریب مارک لازم برای رسیدن دقیق به آستانه
      const reqMarkMult = neededMult / (fillFactor * feeFactor);

      const selfShow = Number(fmt(totTokensWei)).toLocaleString("fa-IR", { maximumFractionDigits: 0 });
      const floatShow = Number(fmt(floatWei)).toLocaleString("fa-IR", { maximumFractionDigits: 0 });
      console.log(`💰 سرمایه ${spentEth.toFixed(4)} ETH (${selfBuyWallets.size} ولت) | 📈 خودی ${selfShow} / فلوت ${floatShow} | ضریب مارک ${(mark / spentEth).toFixed(2)}× (لازم: ${reqMarkMult.toFixed(2)}×) | پرشدنی ×${fillFactor.toFixed(3)} | دریافتی خالص ~${realized.toFixed(4)} ETH | سود ${profitPct.toFixed(0)}٪ / آستانه ${minProfitPct}٪`);

      if (profitPct >= minProfitPct) {
        console.log(`\n🎯 هدف رسید: سود خالص پس از ایمپکت = ${profitPct.toFixed(0)}٪ ≥ ${minProfitPct}٪ — خروج موازی کامل الان!\n`);
        let before = 0n;
        for (const s of signers) { try { before += await provider.getBalance(s.address); } catch {} }
        const gp = await gasPrice();
        await panicSellAll(a.token, a.curve, signers, gp, concurrency);
        await sleep(2500);
        let after = 0n;
        for (const s of signers) { try { after += await provider.getBalance(s.address); } catch {} }
        const received = Number(fmt(after - before));
        const realizedFinal = received / spentEth;
        console.log(`💵 دریافتی واقعی پس از خروج (دلتای ETH منهای گس): ${received.toFixed(4)} ETH = ${realizedFinal.toFixed(2)}× سرمایه (سود واقعی ${((realizedFinal - 1) * 100).toFixed(0)}٪)`);
        if (realizedFinal < neededMult) console.log(`⚠️ پرشدنی واقعی زیر مدل آمد (${realizedFinal.toFixed(2)} < ${neededMult.toFixed(2)}) — تخفیف/فی را محافظه‌کارتر کن (مثلاً --min-profit-pct بالاتر یا fee-bps بیشتر)`);
        return;
      }
    } catch (e) {
      console.log("⚠️ خطا در چرخه‌ی رصد:", (e.shortMessage ?? e.message).slice(0, 120));
    }
    await sleep(interval);
  }
}

main().catch((e) => { console.error("خطا:", e.shortMessage ?? e.message); process.exit(1); });
