// کمکی‌های مشترک «بازار» کرو: خواندن معاملات رویدادی، قیمت میانه‌ی آخرین معاملات،
// و خروج اضطراری موازی (همان motor پنیک — کریتور + باندل‌ها در چانک‌های هم‌زمان)
import { Contract, Interface, formatUnits } from "ethers";
import { BONDING_CURVE_ABI, ERC20_ABI } from "./abis.js";
import { provider, fmt, uniqueSigners } from "./lib.js";

export const curveIface = new Interface(BONDING_CURVE_ABI);
export const CURVE_BUY_TOPIC = curveIface.getEvent("CurveBuy").topicHash;
export const CURVE_SELL_TOPIC = curveIface.getEvent("CurveSell").topicHash;

// همه‌ی معاملات خرید+فروش کرو از یک بلاک به بعد (هر کدام چه طرفش باشد)
// خروجی: [{type:'buy'|'sell', who (گیرنده/فروشنده), actor, quote (wei), tokens (wei), block, tx}]
export async function curveTrades(curveAddr, fromBlock) {
  const logs = await provider.getLogs({
    address: curveAddr,
    topics: [[CURVE_BUY_TOPIC, CURVE_SELL_TOPIC]], // OR بین دو تاپیک
    fromBlock,
    toBlock: "latest",
  });
  const out = [];
  let skipped = 0;
  for (const lg of logs) {
    try {
      const ev = curveIface.parseLog({ topics: lg.topics, data: lg.data });
      if (!ev) { skipped++; continue; }
      if (ev.name === "CurveBuy") {
        out.push({ type: "buy", who: ev.args.recipient.toLowerCase(), actor: ev.args.buyer.toLowerCase(), quote: BigInt(ev.args.quoteIn), tokens: BigInt(ev.args.tokensOut), block: lg.blockNumber, tx: lg.transactionHash });
      } else if (ev.name === "CurveSell") {
        out.push({ type: "sell", who: ev.args.seller.toLowerCase(), actor: ev.args.recipient.toLowerCase(), quote: BigInt(ev.args.quoteOut), tokens: BigInt(ev.args.tokensIn), block: lg.blockNumber, tx: lg.transactionHash });
      } else skipped++;
    } catch { skipped++; }
  }
  if (skipped > 0) console.warn(`⚠️ ${skipped} لاگِ نخوانا در اسکن کرو رد شد (احتمال تغییر ABI/رویداد)`);
  return out;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// قیمت میانه‌ی نمایشی آخرین k معامله (خرید یا فروش) به واحد «wei به ازای هر واحد خام توکن»
// خروجی: { price: میانه (مدل)، last: «قیمت آخرین معامله» (نزدیک‌ترین چیزی به quote اجرایی)، lastBuy/lastSell }
export async function marketPrice(curveAddr, fromBlock, k = 5) {
  const tr = await curveTrades(curveAddr, fromBlock);
  const last = tr.filter((t) => t.tokens > 0n).slice(-k);
  if (!last.length) return null;
  const prices = last.map((t) => Number(t.quote) / Number(t.tokens));
  const veryLast = last[last.length - 1];
  const lastTrade = Number(veryLast.quote) / Number(veryLast.tokens);
  const lb = [...last].reverse().find((t) => t.type === "buy");
  const ls = [...last].reverse().find((t) => t.type === "sell");
  return {
    price: median(prices),
    last: lastTrade,
    lastBuy: lb ? Number(lb.quote) / Number(lb.tokens) : null,
    lastSell: ls ? Number(ls.quote) / Number(ls.tokens) : null,
    tradesUsed: last.map((l) => l.type),
    lastBlock: veryLast.block,
  };
}

// حداقل خروجی تخمینی: minOut = مقدار × قیمت × (۱ − bps/۱۰۰۰۰) — محاسبه‌ی صحیح BigInt با ضریب Q64 (بدون ازدست‌دقت float)
// anchor: اگر داده شود همان استفاده می‌شود (مثلاً قیمت آخرین معامله به‌جای میانه)؛ اگر price نباشد صفر برمی‌گردد و caller باید تصمیم بگیرد
export function estMinOut(amountIn, weiPricePerRawUnit, bps = 800, { anchor = null } = {}) {
  const p = anchor ?? weiPricePerRawUnit;
  if (!p || !(p > 0)) return 0n;
  const Q64 = 1n << 64n;
  const priceQ64 = BigInt(Math.floor(p * 2 ** 64));
  if (priceQ64 === 0n) return 0n;
  const out = (BigInt(amountIn) * priceQ64 * (10000n - BigInt(Math.round(bps)))) / (10000n * Q64);
  return out > 0n ? out : 0n;
}

// خروج موازی: approve و sell با نانس صریح؛ چانک‌ها «تنبل» ساخته می‌شوند (هم‌زمانی واقعاً محدود است)
// گزینه: estPrice (wei به ازای واحد خام) + slippageBps ⇒ sell با minOut محافظت‌شده؛ بدون آن minOut=0
// خروجی: { ok, fail, failList } — caller (exit/batch_buy) بر اساسش موفقیت/نقص گزارش می‌دهد
export async function panicSellAll(tokenAddr, curveAddr, signersIn, gp, concurrency = 6, { estPrice = null, slippageBps = 800 } = {}) {
  const signers = uniqueSigners(signersIn); // دو بار فروش برای یک آدرس = تصادم nonce
  console.log(`🚨 خروج اضطراری موازی روی ${signers.length} ولت (هم‌زمانی ${concurrency})${estPrice ? ` | minOut تخمینی با لغزش ${slippageBps / 100}٪` : " | minOut=0 (بدون قیمت مرجع!)"}…`);
  // نمایش درستِ تعداد توکن با رقم اعشار واقعی (fallback استاندارد ۱۸پونز)
  let tokDec = 18;
  try { tokDec = Number(await new Contract(tokenAddr, ERC20_ABI, provider).decimals()); } catch {}

  const job = (s) => async () => {
    try {
      const token = new Contract(tokenAddr, ERC20_ABI, s);
      const bal = await token.balanceOf(s.address);
      if (bal === 0n) return { ok: true, line: `— ${s.address}: موجودی صفر` };
      const minOut = estMinOut(bal, estPrice, slippageBps);
      const n = await provider.getTransactionCount(s.address, "pending");
      const curve = new Contract(curveAddr, BONDING_CURVE_ABI, s);
      const ap = await token.approve(curveAddr, bal, { gasPrice: gp, nonce: n });
      // sell با nonce+1 بلافاصله صادر می‌شود؛ اگر RPC نانس صف‌دار را رد کند: بعد از ماین approve با نانس تازه دوباره
      let tx;
      try {
        tx = await curve.sell(bal, minOut, s.address, { gasPrice: gp, nonce: n + 1 });
      } catch {
        await ap.wait(1, 120000);
        // محافظ فروش دوباره: اگر تلاش اول در واقع موفق شده باشد، دوباره نفروش
        if ((await token.balanceOf(s.address)) === 0n) {
          return { ok: true, line: `✅ ${s.address}: قبلاً فروخته شده (موجودی صفر)` };
        }
        tx = await curve.sell(bal, minOut, s.address, { gasPrice: gp });
      }
      await Promise.all([ap.wait(1, 120000), tx.wait(1, 120000)]);
      return { ok: true, line: `✅ ${s.address}: ${formatUnits(bal, tokDec)} توکن فروخته شد → ${tx.hash}` };
    } catch (e) {
      return { ok: false, line: `❌ ${s.address}: ${(e.shortMessage ?? e.message).slice(0, 100)}` };
    }
  };

  const results = [];
  for (let i = 0; i < signers.length; i += concurrency) {
    const res = await Promise.all(signers.slice(i, i + concurrency).map((s) => job(s)()));
    results.push(...res);
    res.forEach((r) => console.log("   " + r.line));
  }
  const fails = results.filter((r) => !r.ok);
  if (fails.length) console.log(`⚠️ خروج ناقص: ${fails.length} ولت ناموفق — اگر نقدینگی به V4 مهاجرت کرده است، با sell.js --ur-data یا دستی ادامه بده`);
  return { ok: results.length - fails.length, fail: fails.length, failList: fails.map((f) => f.line) };
}
