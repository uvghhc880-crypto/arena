// فروش پله‌ای توکن‌ها — دو مسیر مطابق مشاهده‌ی انچین:
// ۱) sell روی خود کرو (تا قبل از گرجوئیشن) — امضای واقعی: sell(uint256 tokenIn, uint256 minQuoteOut, address recipient)
// ۲) execute روی UniversalRouter (پس از گرجوئیشن/مارکت V3/V4) — با داده‌ی آماده‌ی کاربر
//
// به‌روزرسانی‌های ممیزی ۲:
// - ترتیب round-robin (--order rr یا پیش‌فرض حالت farm) و حالت «farm»: ۱۰ پله‌ی ۱۰٪ با فاصله‌ی ~۱ ثانیه
// - قیمت هر پله تازه می‌شود (نه یک‌بار برای همه)؛ anchor = قیمت آخرین معامله‌ی واقعی
// - بدون قیمت مرجع ⇒ لغو (جز با --min-out 0 صریح یا --allow-zero-minout)
// - --ur-data-steps برای پله‌های متفاوت (هر بلوب amountIn خودش را دارد) | --ur-command (۰x00=V3، ۰x10=V4 استاندارد)
// - آماده‌سازی Permit2 با --permit2 | کمیت --pct-of-balance فقط عدد صحیح (بدون کرش BigInt)
// - خروج کد ۱ اگر هر پله‌ای شکست بخورد (فلش موفق‌بودن را اسکریپت بالادستی نمی‌سازد)
import { Contract, ethers, formatUnits } from "ethers";
import { ADDR, env, parseArgs } from "./config.js";
import { ERC20_ABI, UNIVERSAL_ROUTER_ABI, PERMIT2_ABI, BONDING_CURVE_ABI } from "./abis.js";
import { masterWallet, deriveWorkers, workerStart, truthy, numOpt, legacyHd, fmt, gasPrice, rand, sleep, provider, weiOf } from "./lib.js";
import { marketPrice, estMinOut } from "./market.js";

// توزیع پله‌ها: پیش‌فرض فارم = تدریجی محافظه‌کار (جمع همیشه ۱۰۰)
function ladder(mode) {
  if (mode === "aggressive") return [45, 45, 10];
  if (mode === "micro") return [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 10, 10];
  if (mode === "farm") return Array(10).fill(10); // ۱۰ پله‌ی ۱۰٪ — الگوی سرعت (round-robin + ۱ ثانیه)
  return [16, 16, 16, 16, 16, 20]; // gradual
}

// نقشه‌ی فرمان‌های استاندارد Universal Router — فقط برای «هشدار»؛ دیتای واقعی متعلق به deployment توست
export const UR_COMMAND_NAMES = {
  0x00: "V3_SWAP_EXACT_IN", 0x01: "V3_SWAP_EXACT_OUT",
  0x02: "PERMIT2_TRANSFER_FROM", 0x03: "PERMIT2_PERMIT",
  0x10: "V4_SWAP (پلنر V4 — زیرفرمان‌ها داخل input)",
};

// ladder به‌صورت صادر — تست‌ها همان پیاده‌سازی واقعی را صدا می‌زنند (نه کپی منطق)
export { ladder };

async function main() {
  const a = parseArgs();
  const tokenAddr = a.token;
  const mode = a.mode ?? "gradual"; // gradual | aggressive | micro | farm
  const source = truthy(a["from-workers"]) || !truthy(a["from-master"]) ? "workers" : "master";
  const targetPct = numOpt(a["pct-of-balance"], 100, { min: 1, max: 100, name: "pct-of-balance", int: true });
  const steps = ladder(mode);
  // الگوی «farm»: راوٓند-رابین + تأخیر پیش‌فرض ۱ ثانیه؛ سایر مُدها: همان رفتار قبلی (ولت‌به‌ولت، ۱۵–۶۰ ثانیه)
  const order = (a.order ?? (mode === "farm" ? "rr" : "wallets")) === "rr" ? "rr" : "wallets";
  const defDelayMin = mode === "farm" ? 1000 : 15000;
  const defDelayMax = mode === "farm" ? 1000 : 60000;
  const delayMin = Number(a["delay-min"] ?? defDelayMin);
  const delayMax = Number(a["delay-max"] ?? defDelayMax);
  const curve = a.curve;
  const slippageBps = numOpt(a["slippage-bps"], Number(env("SLIPPAGE_BPS", "800")), { min: 0, max: 5000, name: "slippage-bps" });

  // ------- UR data steps: برای هر «واحد پله» بلوب جدا (بلوب داخلش amountIn انکودشده دارد) -------
  const urDataSteps = (a["ur-data-steps"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const urDataSingle = a["ur-data"];
  const urUse = urDataSteps.length > 0 || !!urDataSingle;
  const urCommandHex = a["ur-command"] ?? "0x00";
  let urCommand;
  try { urCommand = ethers.getBytes(urCommandHex); if (urCommand.length !== 1) throw new Error("len"); }
  catch { console.log(`⛔ --ur-command نامعتبر (یک بایت هگز، مثل 0x00 یا 0x10): ${urCommandHex}`); process.exit(1); }
  const urCmdName = UR_COMMAND_NAMES[urCommand[0]] ?? "ناشناخته";
  if (urUse) console.log(`   ℹ️ دستور UR = 0x${urCommand[0].toString(16).padStart(2, "0")} ⇒ ${urCmdName} (در استاندارد UR؛ deployment پونز را از Blockscout تأیید کن)`);

  if (!tokenAddr) { console.log("لازم: --token 0x.."); process.exit(1); }

  const legacy = legacyHd(a);
  let sellers;
  if (source === "master") sellers = [{ address: masterWallet().address, wallet: masterWallet() }];
  else sellers = deriveWorkers(Number(a.workers ?? env("WORKER_COUNT", "28")), workerStart(a), { legacy });

  const token = new Contract(tokenAddr, ERC20_ABI, masterWallet().provider);
  const decimals = await token.decimals();
  const router = new Contract(ADDR.UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, masterWallet());
  const gp0 = await gasPrice();

  // قیمت مرجع «به‌روزرسانی‌شونده» — نه یک‌بار قبل از همه‌ی فروش‌ها
  let estPrice = null, estAt = 0;
  async function refreshPrice() {
    const now = Date.now();
    if (estPrice !== null && now - estAt < 2000) return;
    if (curve && !urUse) {
      try {
        const latest = await provider.getBlockNumber();
        const mp = await marketPrice(curve, Math.max(0, latest - 2000), 5);
        estPrice = mp ? (mp.last ?? mp.price) : null; estAt = now;
      } catch {}
    }
  }
  await refreshPrice();

  const minOutFlag = a["min-out"] !== undefined ? BigInt(a["min-out"]) : null;
  const allowZeroMinOut = truthy(a["allow-zero-minout"]) || minOutFlag === 0n;
  if (!urUse && estPrice === null && minOutFlag === null && !allowZeroMinOut) {
    console.log(`⛔ قیمت مرجع برای minOut پیدا نشد — فروش بدون محافظت انجام نمی‌شود.
   اگر عمداً ریسک را می‌پذیری: --min-out 0 یا --allow-zero-minout`);
    process.exit(1);
  }

  // آماده‌سازی منابع هر فروشنده: موجودی اولیه + برنامه‌ی پله
  const plans = [];
  for (const s of sellers) {
    const bal = await token.balanceOf(s.address);
    const toSell = (bal * BigInt(targetPct)) / 100n;
    if (toSell === 0n) { console.log(`— ${s.address}: بدون موجودی`); continue; }
    plans.push({ s, bal, toSell, remaining: toSell });
  }
  if (!plans.length) { console.log("هیچ فروشنده‌ای با موجودی نیست."); process.exit(1); }

  // UR: تعداد بلوب‌ها باید با تعداد واحدهای پله‌ی UR بخورد
  // معنا: بلوب i ام مسیر UR را با amountIn خودش برای wallet/plan خاص کنترل می‌کند.
  const urPlannedUnits = urUse ? (urDataSteps.length || steps.length * plans.length) : 0;
  if (urUse) {
    if (urDataSingle && plans.length * steps.length > 1 && !truthy(a["reuse-ur-data"])) {
      console.log(`⛔ یک --ur-data تنها برای ${plans.length} ولت × ${steps.length} پله قابل‌استفاده نیست:
   داخل بلوب amountIn (و معمولاً گیرنده/مسیر) انکودشده است. راه‌حل‌ها:
   • --ur-data-steps "0xA,0xB,..." به تعداد واحدهای پله (${plans.length * steps.length}) بده، یا
   • اگر عمداً یک بلوبِ قابل‌تکرار (مبلغ ثابت/درصدی در دیتای خودت) می‌خواهی: --reuse-ur-data`);
      process.exit(1);
    }
    if (urDataSteps.length && urDataSteps.length !== plans.length * steps.length) {
      console.log(`⛔ تعداد --ur-data-steps (${urDataSteps.length}) با واحدهای پله (${plans.length} ولت × ${steps.length} پله = ${plans.length * steps.length}) برابر نیست`);
      process.exit(1);
    }
  }

  console.log(`📉 فروش پله‌ای (${mode}${order === "rr" ? "، round-robin" : ""}): ${steps.join("% ، ")}% | فروشنده‌های دارای موجودی: ${plans.length} | لغزش: ${slippageBps / 100}٪ | تأخیر: ${delayMin}–${delayMax}ms`);

  let failedSteps = 0;

  // یک واحد پله برای یک پلن مشخص
  async function doStep(plan, i) {
    const { s } = plan;
    const stepAmt = i === steps.length - 1 ? plan.remaining : (plan.toSell * BigInt(steps[i])) / 100n;
    if (stepAmt === 0n) return "skip";
    const tw = token.connect(s.wallet);
    const gp = await gasPrice();
    try {
      let tx;
      if (curve && !urUse) {
        await refreshPrice();
        const minOut = minOutFlag !== null ? minOutFlag : estMinOut(stepAmt, estPrice, slippageBps);
        await (await tw.approve(curve, stepAmt, { gasPrice: gp })).wait(1, 120000);
        const cr = new Contract(curve, BONDING_CURVE_ABI, s.wallet);
        const data = cr.interface.encodeFunctionData("sell", [stepAmt, minOut, s.address]);
        await provider.call({ to: curve, data, from: s.wallet.address }); // شبیه‌سازی قبل از ارسال
        tx = await cr.sell(stepAmt, minOut, s.address, { gasPrice: gp });
      } else if (urUse) {
        // آماده‌سازی Permit2 — پیش‌فرض روشن (مسیر استاندارد UR: توکن→Permit2→روتر)؛ --no-permit2 = approve مستقیم روتر
        if (!truthy(a["no-permit2"])) {
          await (await tw.approve(ADDR.PERMIT2, ethers.MaxUint256, { gasPrice: gp })).wait(1, 120000);
          const p2 = new Contract(ADDR.PERMIT2, PERMIT2_ABI, s.wallet);
          const exp = Math.floor(Date.now() / 1000) + 1800;
          await (await p2.approve(tokenAddr, ADDR.UNIVERSAL_ROUTER, stepAmt, exp, { gasPrice: gp })).wait(1, 120000);
        } else {
          await (await tw.approve(ADDR.UNIVERSAL_ROUTER, stepAmt, { gasPrice: gp })).wait(1, 120000);
        }
        const unit = planIndex(plan) * steps.length + i;
        const blobHex = urDataSteps.length ? urDataSteps[unit] : urDataSingle;
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const data = router.interface.encodeFunctionData("execute(bytes,bytes[],uint256)", [urCommand, [ethers.getBytes(blobHex)], deadline]);
        await provider.call({ to: ADDR.UNIVERSAL_ROUTER, data, from: s.wallet.address }); // شبیه‌سازی
        tx = await router.connect(s.wallet).execute(urCommand, [ethers.getBytes(blobHex)], deadline, { gasPrice: gp });
      } else {
        throw new Error("نه --curve داده‌ای و نه --ur-data؛ حداقل یکی لازم است");
      }
      await tx.wait(1, 120000);
      plan.remaining -= stepAmt;
      console.log(`   ✅ ${s.address.slice(0, 10)}… پله ${i + 1}/${steps.length} (${steps[i]}%): ${tx.hash}`);
      return "ok";
    } catch (e) {
      console.log(`   ❌ شکست پله ${i + 1} برای ${s.address.slice(0, 10)}…:`, (e.shortMessage ?? e.message).slice(0, 120));
      return "fail";
    }
  }

  const planIndex = (p) => plans.indexOf(p);

  if (order === "rr") {
    // round-robin: اول همه‌ی فروشنده‌ها پله ۱، بعد همه پله ۲ و… (الگوی فارم — توزیع زمانی نرمال)
    for (let i = 0; i < steps.length; i++) {
      for (const plan of plans) {
        const r = await doStep(plan, i);
        if (r === "fail") { failedSteps++; plan.dead = true; }
        if (i < steps.length - 1 || plan !== plans[plans.length - 1]) await sleep(Math.max(0, rand(delayMin, delayMax)));
      }
    }
  } else {
    for (const plan of plans) {
      console.log(`\n🟠 ${plan.s.address} | موجودی: ${formatUnits(plan.bal, decimals)} | برنامه: ${targetPct}%`);
      for (let i = 0; i < steps.length; i++) {
        const r = await doStep(plan, i);
        if (r === "fail") { failedSteps++; break; }
        if (i < steps.length - 1) await sleep(Math.max(0, rand(delayMin, delayMax)));
      }
    }
  }

  const leftovers = plans.filter((p) => p.remaining > 0n);
  if (leftovers.length) {
    console.log(`\n↩︎ باقی‌مانده‌ی فروخته‌نشده در ${leftovers.length} ولت:`);
    for (const p of leftovers) console.log(`   ${p.s.address}: ${formatUnits(p.remaining, decimals)} توکن`);
  }
  if (failedSteps > 0) {
    console.log(`\n⛔ فروش با ${failedSteps} پله‌ی ناموفق تمام شد — موجودی‌های باقی‌مانده بالا اعلام شدند.`);
    process.exit(1);
  }
  console.log("\n✔️ فروش تمام شد.");
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
