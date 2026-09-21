// کشف خودکار امضای درستِ توابع روی کانترکت‌هایی که ABI ندارند (fallback)
// با شبیه‌سازی هر کاندیدا (eth_call) اولین موردی که revert نمی‌شود برگردانده می‌شود.
// نکته: برای کروهای پونز ABI واقعی در abis.js هست (BONDING_CURVE_ABI) — این ابزار بیمه است.
// نکته‌ی دقت: بدون --from بعضی کانترکت‌ها (فرضی روی msg.sender) false negative می‌دهند.
import { Interface } from "ethers";
import { provider, eth } from "./lib.js";
import { parseArgs } from "./config.js";

/**
 * کاندیدها: آرایه‌ای از { sig, args, value (ETH string?) }
 * خروجی: { sig, data } اولین کاندید موفق
 */
export async function discoverCall({ to, candidates, valueEth = "0", from = undefined }) {
  const report = [];
  for (const c of candidates) {
    try {
      const iface = new Interface([`function ${c.sig}`]);
      const data = iface.encodeFunctionData(c.sig.split("(")[0], c.args ?? []);
      const tx = { to, data };
      if (valueEth !== "0") tx.value = eth(valueEth);
      if (from) tx.from = from;
      await provider.call(tx); // اگر revert شود پرتاب خطا می‌کند
      return { sig: c.sig, data, iface, args: c.args ?? [] };
    } catch (e) {
      report.push(`${c.sig} -> revert (${String(e.shortMessage ?? e.message).slice(0, 80)})`);
    }
  }
  const err = new Error("هیچ امضای کاندیدی کار نکرد:\n" + report.join("\n"));
  err.report = report;
  throw err;
}

export const BUY_CANDIDATES = (recipient, minOutWei = 0n, quoteInWei = 0n) => [
  { sig: "buy(uint256,uint256,address)", args: [quoteInWei, minOutWei, recipient] }, // امضای واقعی پونز
  { sig: "buy(uint256)", args: [minOutWei] },
  { sig: "buy()", args: [] },
];

export const SELL_CANDIDATES = (recipient, amountWei, minOutWei = 0n) => [
  { sig: "sell(uint256,uint256,address)", args: [amountWei, minOutWei, recipient] }, // امضای واقعی پونز
  { sig: "sell(uint256,uint256)", args: [amountWei, minOutWei] },
  { sig: "sell(uint256)", args: [amountWei] },
];

// حالت CLI: node src/probe.js --to 0x.. --sig "buy(uint256,uint256,address)" --args 0,0,0xRECIPIENT --value 0.001 [--from 0xPAYER]
async function main() {
  const a = parseArgs();
  if (!a.to || !a.sig) {
    console.log('مثال: node src/probe.js --to 0xCURVE --sig "buy(uint256,uint256,address)" --args 0,0,0x.. --value 0.001 [--from 0x..]');
    process.exit(1);
  }
  const args = (a.args ?? "").split(",").filter((s) => s.length).map((s) => (/^\d+$/.test(s) ? BigInt(s) : s));
  try {
    const r = await discoverCall({ to: a.to, candidates: [{ sig: a.sig, args }], valueEth: a.value ?? "0", from: a.from });
    console.log("✅ امضا کار می‌کند:", r.sig);
    process.exit(0);
  } catch (e) {
    console.log("❌", e.message);
    process.exit(1); // شکست probe باید در اسکریپت‌های خودکار سیگنال خطا بدهد
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
