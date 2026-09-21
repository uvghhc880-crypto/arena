// خواندن تنظیمات آنچین فکتوری + چک سریع قبل از لانچ
import { Contract } from "ethers";
import { ADDR, env } from "./config.js";
import { provider, masterWallet, fmt } from "./lib.js";

const FACTORY_ABI = [
  "function launchFee() view returns (uint256)",
  "function canLaunch(address) view returns (bool)",
  "function getLaunchConfig(uint256) view returns ((uint256 supply, uint256 curveId, uint256 feeBps, bytes32 economics, bool enabled) config)",
];

// تفکیک «کانفیگ وجود ندارد» از «خطای RPC» — catch کور ممنوع
function isRpcError(e) {
  const code = e.code ?? "";
  return /NETWORK|TIMEOUT|SERVER_ERROR|ECONN|429|5\d\d/.test(String(code) + (e.message ?? ""));
}

async function main() {
  const f = new Contract(ADDR.LAUNCH_FACTORY_V2, FACTORY_ABI, provider);
  console.log("🏭 فکتوری V2:", ADDR.LAUNCH_FACTORY_V2);
  try {
    const fee = await f.launchFee();
    console.log("فی لانچ (انچین):", fmt(fee), "ETH");
  } catch (e) {
    console.log(isRpcError(e) ? `⚠️ خطای RPC هنگام خواندن launchFee: ${(e.shortMessage ?? e.message).slice(0, 80)}` : "launchFee() روی این کانترکت وجود ندارد (fallback=0.0005 ETH)");
  }

  // canLaunch فقط وقتی معنا دارد که کلید مستر داشته باشیم
  try {
    const master = masterWallet();
    const ok = await f.canLaunch(master.address);
    console.log(`canLaunch(${master.address}):`, ok ? "✅ مجاز" : "⛔ مجاز نیست");
  } catch (e) {
    if (String(e.message ?? "").includes("PRIVATE_KEY")) console.log("canLaunch: بدون PRIVATE_KEY قابل چک نیست");
    else console.log(isRpcError(e) ? "⚠️ خطای RPC در canLaunch" : "canLaunch روی این فکتوری وجود ندارد");
  }

  // اسکن کانفیگ‌ها: تا دو شکست پیاپی (یعنی انتهای لیست)
  let misses = 0;
  for (let id = 0; id < 8; id++) {
    try {
      const cfg = await f.getLaunchConfig(id);
      misses = 0;
      console.log(`config ${id}:`, cfg);
    } catch (e) {
      if (isRpcError(e)) { console.log(`⚠️ config ${id}: خطای RPC — اسکن متوقف شد؛ با RPC سالم دوباره بزن`); break; }
      console.log(`config ${id}: — (بدون ردی)`);
      if (++misses >= 2) { console.log("… دو کانفیگ پیاپی خالی → پایان لیست"); break; }
    }
  }
  console.log("\nنکته: برای تشخیص دقیق بایت expectedEconomics، tx یک لانچ موفق اخیر را در Blockscout باز کن و از calldata آن بخوان (یا مقدار پین‌شده‌ی .env.example را چک کن).");
}

main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
