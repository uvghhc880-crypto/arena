// فروش پله‌ای توکن‌ها — دو مسیر مطابق مشاهده‌ی انچین:
// 1) sell روی خود کرو (تا قبل از گرجوئیشن) — امضای واقعی: sell(uint256 tokenIn, uint256 minQuoteOut, address recipient)
// 2) execute روی UniversalRouter (پس از گرجوئیشن/مارکت V3/V4) — با داده‌ی آماده
// نکته: برای خروج خودکار هدف‌دار بر اساس سود، src/exit.js را ببین.
import { Contract, ethers, formatUnits } from "ethers";
import { ADDR, env, parseArgs } from "./config.js";
import { ERC20_ABI, UNIVERSAL_ROUTER_ABI, BONDING_CURVE_ABI } from "./abis.js";
import { masterWallet, deriveWorkers, workerStart, fmt, gasPrice, rand, sleep, provider } from "./lib.js";

// توزیع پله‌ها: پیش‌فرض فارم = تدریجی محافظه‌کار
function ladder(mode) {
  if (mode === "aggressive") return [45, 45, 10];
  if (mode === "micro") return [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 10, 10];
  return [16, 16, 16, 16, 16, 20]; // gradual
}

async function main() {
  const a = parseArgs();
  const tokenAddr = a.token;
  const mode = a.mode ?? "gradual"; // gradual | aggressive | micro
  const source = a["from-workers"] ? "workers" : a["from-master"] ? "master" : "workers";
  const targetPct = Number(a["pct-of-balance"] ?? "100");
  const delayMin = Number(a["delay-min"] ?? 15000);
  const delayMax = Number(a["delay-max"] ?? 60000);
  const curve = a.curve;
  const urData = a["ur-data"];

  if (!tokenAddr) { console.log("لازم: --token 0x.."); process.exit(1); }

  let sellers;
  if (source === "master") sellers = [{ address: masterWallet().address, wallet: masterWallet() }];
  else sellers = deriveWorkers(Number(a.workers ?? env("WORKER_COUNT", "28")), workerStart(a));

  const token = new Contract(tokenAddr, ERC20_ABI, masterWallet().provider);
  const decimals = await token.decimals();
  const router = new Contract(ADDR.UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, masterWallet());
  const gp = await gasPrice();
  const steps = ladder(mode);

  console.log(`📉 فروش پله‌ای (${mode}): ${steps.join("% ، ")}% | ولت‌های فروشنده: ${sellers.length}`);

  for (const s of sellers) {
    const bal = await token.balanceOf(s.address);
    let toSell = (bal * BigInt(targetPct)) / 100n;
    if (toSell === 0n) { console.log(`— ${s.address}: بدون موجودی`); continue; }
    console.log(`\n🟠 ${s.address} | موجودی: ${formatUnits(bal, decimals)} | برنامه: ${targetPct}% از آن`);

    for (let i = 0; i < steps.length; i++) {
      const stepAmt = i === steps.length - 1 ? toSell : (toSell * BigInt(steps[i])) / 100n;
      if (stepAmt === 0n) continue;
      const tw = token.connect(s.wallet); // ethers v6: Contract.connect(signer)
      try {
        let tx;
        if (curve && !urData) {
          // مسیر ۱: sell مستقیم روی کرو (امضای واقعیش را داریم)
          await (await tw.approve(curve, stepAmt)).wait();
          const cr = new Contract(curve, BONDING_CURVE_ABI, s.wallet);
          // شبیه‌سازی قبل از ارسال — ریورت را قبل از سوخت گس پیدا می‌کند
          const data = cr.interface.encodeFunctionData("sell", [stepAmt, 0n, s.address]);
          await provider.call({ to: curve, data, from: s.wallet.address });
          tx = await cr.sell(stepAmt, 0, s.address, { gasPrice: gp });
        } else if (urData) {
          // مسیر ۲: UniversalRouter با دیتای آماده (دیتا باید minOut خودش را داشته باشد)
          await (await tw.approve(ADDR.UNIVERSAL_ROUTER, stepAmt)).wait();
          tx = await router.connect(s.wallet).execute("0x00", [ethers.getBytes(urData)], Math.floor(Date.now() / 1000) + 300, { gasPrice: gp });
        } else {
          throw new Error("نه --curve داده‌ای و نه --ur-data؛ حداقل یکی لازم است");
        }
        await tx.wait();
        console.log(`   ✅ پله ${i + 1}/${steps.length} (${steps[i]}%) فروخته شد: ${tx.hash}`);
        if (i < steps.length - 1) await sleep(rand(delayMin, delayMax));
      } catch (e) {
        console.log(`   ❌ شکست پله ${i + 1}:`, e.shortMessage ?? e.message);
        break;
      }
    }
  }
  console.log("\n✔️ فروش تمام شد.");
}

main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
