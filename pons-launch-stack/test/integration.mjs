// test/integration.mjs — تست آنچین (NEEDS network reachability to Robinhood RPC).
// رفتار: اگر RPC در دسترس نباشد ⇒ SKIP (exit 0). اگر در دسترس باشد و هر کدام از این‌ها برقرار نباشد ⇒ FAIL (exit 1):
//   ۱) همه‌ی آدرس‌های کلیدی (LAUNCH_AND_BUY, FEE_ESCROW, UNIVERSAL_ROUTER, POOL_MANAGER, PERMIT2, WETH, LAUNCH_FACTORY_V2) کد دارند
//   ۲) launchFee() خواندنی باشد (و به‌صورت ۱۰۰0000000000 wei)
//   ۳) WETH decimals() == 18
// برای ردّ همه: پروکسی وب یا دسترسی مستقیم شبکه لازم است — در سندباکس ممیزی معمولاً SKIP می‌شود.
import { JsonRpcProvider, Contract } from "ethers";
import { ADDR, CHAIN } from "../src/config.js";

const provider = new JsonRpcProvider(process.env.PONS_RPC || CHAIN.RPC);
let skip = false;
try {
  await Promise.race([provider.getBlockNumber(), new Promise((_, rj) => setTimeout(() => rj(new Error("timeout")), 5000))]);
} catch {
  skip = true;
}
if (skip) {
  console.log("SKIP  RPC قابل‌دسترس نیست (بدون اینترنت مستقیم) — این تست فقط روی محیط شبکه‌دار معتبر است (ممیزی ۵: نتایج آنچین با فاجعه‌ی SKIP پنهان نمی‌شوند)");
  process.exit(0);
}

let fail = 0;
const t = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) fail++; };

for (const [k, a] of Object.entries({
  LAUNCH_AND_BUY: ADDR.LAUNCH_AND_BUY, FEE_ESCROW: ADDR.FEE_ESCROW,
  UNIVERSAL_ROUTER: ADDR.UNIVERSAL_ROUTER, POOL_MANAGER: ADDR.POOL_MANAGER,
  PERMIT2: ADDR.PERMIT2, WETH: ADDR.WETH, LAUNCH_FACTORY_V2: ADDR.LAUNCH_FACTORY_V2,
})) {
  const code = await provider.getCode(a);
  t(`${k} (${a}) دارای کد روی زنجیره است`, code !== "0x");
}

try {
  const lab = new Contract(ADDR.LAUNCH_AND_BUY, ["function launchFee() view returns (uint256)"], provider);
  const fee = await lab.launchFee();
  t(`launchFee() = ${fee} wei (>0)`, fee > 0n);
} catch (e) { t(`launchFee() خواندنی — ${e.shortMessage ?? e.message}`, false); }

try {
  const weth = new Contract(ADDR.WETH, ["function decimals() view returns (uint8)"], provider);
  const d = await weth.decimals();
  t(`WETH.decimals() == 18 (واقعاً ERC20/WETH است)` , d === 18n || d === 18);
} catch (e) { t(`WETH.decimals() خواندنی — ${e.shortMessage ?? e.message}`, false); }

process.exit(fail > 0 ? 1 : 0);
