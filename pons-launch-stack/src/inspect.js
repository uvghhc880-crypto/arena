// خواندن تنظیمات آنچین فکتوری + چک سریع قبل از لانچ
import { Contract } from "ethers";
import { ADDR } from "./config.js";
import { provider, fmt } from "./lib.js";

const FACTORY_ABI = [
  "function launchFee() view returns (uint256)",
  "function canLaunch(address) view returns (bool)",
  "function getLaunchConfig(uint256) view returns ((uint256 supply, uint256 curveId, uint256 feeBps, bytes32 economics, bool enabled) config)",
];

async function main() {
  const f = new Contract(ADDR.LAUNCH_FACTORY_V2, FACTORY_ABI, provider);
  console.log("🏭 فکتوری V2:", ADDR.LAUNCH_FACTORY_V2);
  try {
    const fee = await f.launchFee();
    console.log("فی لانچ (انچین):", fmt(fee), "ETH");
  } catch {
    console.log("launchFee() روی این کانترکت وجود ندارد (fallback=0.0005 ETH)");
  }
  for (const id of [0, 1, 2, 3]) {
    try {
      const cfg = await f.getLaunchConfig(id);
      console.log(`config ${id}:`, cfg);
    } catch {
      console.log(`config ${id}: — (بدون ردی)`);
    }
  }
  console.log("\nنکته: برای تشخیص دقیق بایت expectedEconomics، tx یک لانچ موفق اخیر را در Blockscout باز کن و از calldata آن بخوان.");
}

main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
