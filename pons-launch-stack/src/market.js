// کمکی‌های مشترک «بازار» کرو: خواندن معاملات رویدادی، قیمت میانه‌ی آخرین معاملات،
// و خروج اضطراری موازی (همان motor پنیک — کریتور + باندل‌ها در چانک‌های هم‌زمان)
import { Contract, Interface } from "ethers";
import { BONDING_CURVE_ABI, ERC20_ABI } from "./abis.js";
import { provider, fmt } from "./lib.js";

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
  for (const lg of logs) {
    try {
      const ev = curveIface.parseLog({ topics: lg.topics, data: lg.data });
      if (!ev) continue;
      if (ev.name === "CurveBuy") {
        out.push({ type: "buy", who: ev.args.recipient.toLowerCase(), actor: ev.args.buyer.toLowerCase(), quote: BigInt(ev.args.quoteIn), tokens: BigInt(ev.args.tokensOut), block: lg.blockNumber, tx: lg.transactionHash });
      } else if (ev.name === "CurveSell") {
        out.push({ type: "sell", who: ev.args.seller.toLowerCase(), actor: ev.args.recipient.toLowerCase(), quote: BigInt(ev.args.quoteOut), tokens: BigInt(ev.args.tokensIn), block: lg.blockNumber, tx: lg.transactionHash });
      }
    } catch {}
  }
  return out;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// قیمت میانه‌ی نمایشی آخرین k معامله (خرید یا فروش) به واحد «ETH به ازای هر واحد توکن»
export async function marketPrice(curveAddr, fromBlock, k = 5) {
  const tr = await curveTrades(curveAddr, fromBlock);
  const last = tr.filter((t) => t.tokens > 0n).slice(-k);
  if (!last.length) return null;
  const prices = last.map((t) => Number(t.quote) / Number(t.tokens));
  return { price: median(prices), tradesUsed: last.map((l) => l.type), lastBlock: last[last.length - 1].block };
}

// خروج موازی: هر ولت approve و بلافاصله sell با نانس صریح (بدون انتظار بین دو تراکنش)
// در چانک‌های هم‌زمان — ولت‌های بدون موجودی رد می‌شوند
export async function panicSellAll(tokenAddr, curveAddr, signers, gp, concurrency = 6) {
  console.log(`🚨 خروج اضطراری موازی روی ${signers.length} ولت (هم‌زمانی ${concurrency})…`);
  const jobs = signers.map(async (s) => {
    try {
      const token = new Contract(tokenAddr, ERC20_ABI, s);
      const bal = await token.balanceOf(s.address);
      if (bal === 0n) return `— ${s.address}: موجودی صفر`;
      const n = await provider.getTransactionCount(s.address, "pending");
      const curve = new Contract(curveAddr, BONDING_CURVE_ABI, s);
      const ap = await token.approve(curveAddr, bal, { gasPrice: gp, nonce: n });
      // sell با nonce+1 بلافاصله صادر می‌شود؛ اگر RPC نانس صف‌دار را رد کند: بعد از ماین approve با نانس تازه دوباره
      let tx;
      try {
        tx = await curve.sell(bal, 0n, s.address, { gasPrice: gp, nonce: n + 1 });
      } catch {
        await ap.wait();
        tx = await curve.sell(bal, 0n, s.address, { gasPrice: gp });
      }
      await Promise.all([ap.wait(), tx.wait()]);
      return `✅ ${s.address}: ${fmt(bal)} توکن فروخته شد → ${tx.hash}`;
    } catch (e) {
      return `❌ ${s.address}: ${(e.shortMessage ?? e.message).slice(0, 100)}`;
    }
  });
  for (let i = 0; i < jobs.length; i += concurrency) {
    const res = await Promise.all(jobs.slice(i, i + concurrency));
    res.forEach((r) => console.log("   " + r));
  }
}
