// فروش پله‌ای توکن‌ها — دو مسیر مطابق مشاهده‌ی انچین:
// ۱) sell روی خود کرو (تا قبل از گرجوئیشن) — امضای واقعی: sell(uint256 tokenIn, uint256 minQuoteOut, address recipient)
// ۲) execute روی UniversalRouter (پس از گرجوئیشن/مارکت V3/V4) — با داده‌ی آماده‌ی کاربر
//
// به‌روزرسانی‌های ممیزی ۲:
// - ترتیب round-robin (--order rr یا پیش‌فرض حالت farm) و حالت «farm»: ۱۰ پله‌ی ۱۰٪ با تأخیر ~۱ ثانیه بین هر دو تراکنش
// - قیمت هر پله تازه می‌شود (نه یک‌بار برای همه)؛ anchor = قیمت آخرین معامله‌ی واقعی
// - بدون قیمت مرجع ⇒ لغو (جز با --min-out 0 صریح یا --allow-zero-minout)
// - --ur-data-steps برای پله‌های متفاوت (هر بلوب amountIn خودش را دارد) | --ur-command (۰x00=V3، ۰x10=V4 استاندارد)
// - کمیت --pct-of-balance فقط عدد صحیح (بدون کرش BigInt)
// - خروج کد ۱ اگر هر پله‌ای شکست بخورد (فلش موفق‌بودن را اسکریپت بالادستی نمی‌سازد)
// به‌روزرسانی‌های ممیزی ۴:
// - approve «فاز صفر» یک‌بار به‌ازای هر ولت (به‌جای approve برای هر پله) — curve ≈ ۳۰۸ تراکنش به‌جای ~۵۶۰
// - ژورنال فروش اتمیک (wallets-out/sell_*.json) + تفکیک reverted/uncertain با classifyTx (کد ۲ برای نامعلوم)
// - --curve + --ur-data هم‌زمان = خطای صریح (قبلاً UR بی‌صدا غلبه می‌کرد)
// - مبلغ هر پله ثابتِ همان پله است؛ شکستِ پله به پله‌ی بعدی نمی‌چسبد (پله‌ی آخر باقی‌مانده را جذب نمی‌کند)
// - decode-check بلوب‌های UR قبل از ارسال (recipient داخل دیتا باید فروشنده/سنتینل باشد)
// - preflight contract-code (توکن/کرو/UR/Permit2)
import { Contract, ethers, formatUnits } from "ethers";
import { ADDR, WALLETS_OUT, env, parseArgs } from "./config.js";
import { ERC20_ABI, UNIVERSAL_ROUTER_ABI, PERMIT2_ABI, BONDING_CURVE_ABI } from "./abis.js";
import { masterWallet, deriveWorkers, workerStart, truthy, numOpt, legacyHd, fmt, gasPrice, rand, sleep, provider, weiOf, nowTag, classifyTx, atomicWriteJson, assertContract } from "./lib.js";
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

// ممیزی ۴ — «decode-check» برای بلوب UR قبل از ارسال: دیتای خامِ ارسالی باید معنادار و متناسب با فرمان باشد
// خروجی: آبجکتِ دیکود برای نمایش/اعتبارسنجی (recipient/amountIn) یا null برای فرمان‌های ناشناخته
export function decodeUrBlob(commandByte, blobHex) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  if (commandByte === 0x00) {
    const [path, recipient, amountIn, amountOutMin] = coder.decode(["bytes", "address", "uint256", "uint256"], blobHex);
    return { name: "V3_SWAP_EXACT_IN", recipient, amountIn: amountIn.toString(), amountOutMin: amountOutMin.toString(), pathBytes: (path.length - 2) / 2 };
  }
  if (commandByte === 0x01) {
    const [path, recipient, amountOut, amountInMax] = coder.decode(["bytes", "address", "uint256", "uint256"], blobHex);
    return { name: "V3_SWAP_EXACT_OUT", recipient, amountOut: amountOut.toString(), amountInMax: amountInMax.toString(), pathBytes: (path.length - 2) / 2 };
  }
  if (commandByte === 0x10) {
    const [actions, params] = coder.decode(["bytes", "bytes[]"], blobHex);
    return { name: "V4_SWAP", actionsBytes: (actions.length - 2) / 2, paramCount: params.length };
  }
  return null; // فرمان ناشناخته — فقط خام ارسال می‌شود
}

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

  // ممیزی ۴: --curve + --ur-data با هم = تداخل؛ قبل از این UR «بی‌صدا» برنده بود
  if (curve && urUse) {
    console.log("⛔ هم --curve داده‌ای هم --ur-data/--ur-data-steps — مسیر فروش باید دقیقاً «یکی» باشد.\n   کرو (پیش از گرجوئیشن): فقط --curve. روی UniversalRouter (پس از گرجوئیشن): فقط --ur-data/--ur-data-steps.");
    process.exit(1);
  }
  if (!curve && !urUse) {
    console.log("⛔ نه --curve داده‌ای و نه --ur-data/--ur-data-steps — مسیر فروش نامشخص است.");
    process.exit(1);
  }

  // preflight: مقصدها واقعاً قراردادند
  await assertContract(tokenAddr, "توکن");
  if (curve) await assertContract(curve, "باندینگ-کرو");
  if (urUse) {
    await assertContract(ADDR.UNIVERSAL_ROUTER, "UniversalRouter");
    if (!truthy(a["no-permit2"])) await assertContract(ADDR.PERMIT2, "Permit2");
  }

  // ممیزی ۴ — decode-check بلوب UR: همه‌ی بلوب‌ها باید با فرمان انتخابی قابل‌دیکود و «گیرنده‌اش» درست باشد
  const urBlobRecipients = [];
  if (urUse) {
    const blobs = urDataSteps.length ? urDataSteps : [urDataSingle];
    for (let bi = 0; bi < blobs.length; bi++) {
      let dec;
      try { dec = decodeUrBlob(urCommand[0], blobs[bi]); }
      catch (e) {
        console.log(`⛔ بلوب UR شماره ${bi + 1} با فرمان «${urCmdName}» قابل‌دیکود نیست (${(e.shortMessage ?? e.message).slice(0, 60)}) — ارسال نمی‌شود تا گس هدر نرود و مسیر اشتباه سواپ نکند.`);
        process.exit(1);
      }
      if (dec === null) {
        console.warn(`   ⚠️ بلوب ${bi + 1}: فرمان ${urCmdName} برای decode-check شناخته‌شده نیست — فقط طول: ${(blobs[bi].length - 2) / 2} بایت (مسئولیت decode با deployment UR توست)`);
        continue;
      }
      const parts = Object.entries(dec).map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`   🔎 بلوب ${bi + 1}: ${parts}`);
      if (dec.recipient) urBlobRecipients.push(dec.recipient.toLowerCase());
    }
  }

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

  // decode-check فاز ۲: هر «recipient غیرسنتینل» داخل بلوب‌ها باید یکی از فروشنده‌ها باشد
  if (urBlobRecipients.length) {
    const UR_SENTINELS = new Set(["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", ethers.ZeroAddress.toLowerCase()]);
    const sellerSet = new Set(sellers.map((s) => s.address.toLowerCase()));
    for (const r of urBlobRecipients) {
      if (UR_SENTINELS.has(r)) continue;
      if (!sellerSet.has(r)) {
        console.log(`⛔ decode-check شکست خورد: recipient داخل بلوب UR (${r}) نه سنتینل گیرنده‌ی UR است نه یکی از ولت‌های فروشنده —\n   این یعنی خروجی سواپ به ولت ناشناخته می‌رود. بلوب را چک کن؛ اگر عمدی است recipient صریح را به یکی از ولت‌ها یا سنتینل (0x…01/02) تغییر بده.`);
        process.exit(1);
      }
    }
    console.log("   ✅ decode-check: همه‌ی recipientهای بلوب‌ها = فروشنده/سنتینل UR");
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

  // ممیزی ۴ — approve «یک‌بار برای همیشه‌ی این مسیر» (به‌جای approve جدا برای هر پله):
  // کرو: ERC20.approve(curve, toSell) ×۱ | UR: ERC20.approve(Permit2, MAX) ×۱ + Permit2.approve(router, toSell) ×۱
  // نتیجه: ۲۸ ولت ×(۱ پله≈تراکنش approve سابق) → تراکنش‌های کل کاهش می‌یابد (curve: ~۳۰۸ به‌جای ~۵۶۰)
  console.log("🔐 approve فاز صفر (یک‌بار برای هر ولت)…");
  for (const plan of plans) {
    const gp = await gasPrice();
    const tw = token.connect(plan.s.wallet);
    try {
      if (curve && !urUse) {
        await (await tw.approve(curve, plan.toSell, { gasPrice: gp })).wait(1, 120000);
      } else if (urUse && !truthy(a["no-permit2"])) {
        await (await tw.approve(ADDR.PERMIT2, ethers.MaxUint256, { gasPrice: gp })).wait(1, 120000);
        const p2 = new Contract(ADDR.PERMIT2, PERMIT2_ABI, plan.s.wallet);
        const exp = Math.floor(Date.now() / 1000) + 3600;
        await (await p2.approve(tokenAddr, ADDR.UNIVERSAL_ROUTER, plan.toSell, exp, { gasPrice: gp })).wait(1, 120000);
      } else if (urUse) {
        await (await tw.approve(ADDR.UNIVERSAL_ROUTER, plan.toSell, { gasPrice: gp })).wait(1, 120000);
      }
    } catch (e) {
      console.log(`   ⛔ approve فاز صفر برای ${plan.s.address} شکست خورد: ${(e.shortMessage ?? e.message).slice(0, 100)} — این ولت از لیست فروش حذف می‌شود`);
      plan.dead = true;
    }
  }
  const livePlans = plans.filter((p) => !p.dead);
  if (!livePlans.length) { console.log("⛔ همه‌ی approveها شکست خوردند — دیسک/‌RPC را چک کن."); process.exit(1); }

  // UR: تعداد بلوب‌ها باید با تعداد واحدهای پله‌ی UR بخورد
  // معنا: بلوب i ام مسیر UR را با amountIn خودش برای wallet/plan خاص کنترل می‌کند.
  const urUnits = steps.length * livePlans.length;
  if (urUse) {
    if (urDataSingle && urUnits > 1 && !truthy(a["reuse-ur-data"])) {
      console.log(`⛔ یک --ur-data تنها برای ${livePlans.length} ولت × ${steps.length} پله قابل‌استفاده نیست:
   داخل بلوب amountIn (و معمولاً گیرنده/مسیر) انکودشده است. راه‌حل‌ها:
   • --ur-data-steps "0xA,0xB,..." به تعداد واحدهای پله (${urUnits}) بده، یا
   • اگر عمداً یک بلوبِ قابل‌تکرار (مبلغ ثابت/درصدی در دیتای خودت) می‌خواهی: --reuse-ur-data`);
      process.exit(1);
    }
    if (urDataSteps.length && urDataSteps.length !== urUnits) {
      console.log(`⛔ تعداد --ur-data-steps (${urDataSteps.length}) با واحدهای پله (${livePlans.length} ولت × ${steps.length} پله = ${urUnits}) برابر نیست`);
      process.exit(1);
    }
  }
  const estTx = curve ? livePlans.length + urUnits : livePlans.length * 2 + urUnits;
  console.log(`📉 فروش پله‌ای (${mode}${order === "rr" ? "، round-robin" : ""}): ${steps.join("% ، ")}% | فروشنده‌های دارای موجودی: ${livePlans.length} | لغزش: ${slippageBps / 100}٪ | تأخیر بین تراکنش‌ها: ${delayMin}–${delayMax}ms`);
  console.log(`   ⛓️ ترتیب: sequential تک‌پردازه (approve فاز صفر + ${steps.length} پله). تراکنش تقریبی کل ≈ ${estTx} — «فاصله‌ی ~۱ ثانیه» یعنی فاصله‌ی بین دو ارسالِ پشت‌سرهم است، نه فاصله‌ی فرض‌شده‌ی هر ولت از ولت بعدی؛ پکیج چندپردازه/پارالل با nonce مجزا عمداً پیاده نشده (ریسک nonce/ردیابی).`);

  // ─── ژورنال فروش (ممیزی ۴): هر پله = رکورد اتمیک (هش + وضعیت) — موفقیت/شکست/نامعلوم قابل‌ممیزی است ───
  const SELL_JOURNAL = `${WALLETS_OUT}/sell_${nowTag()}_${tokenAddr.slice(0, 10).toLowerCase()}.json`;
  const sellLog = { startedAt: new Date().toISOString(), token: tokenAddr, route: curve ? "curve" : "ur", mode, steps: [] };
  const writeSellJournal = () => atomicWriteJson(SELL_JOURNAL, sellLog);
  writeSellJournal();
  console.log(`📄 ژورنال فروش: ${SELL_JOURNAL}`);

  let failedSteps = 0, uncertainSteps = 0;

  // یک واحد پله برای یک پلن مشخص — مبلغ هر پله «ثابتِ همان پله» است (ممیزی ۴: شکستِ پله‌ی قبلی به پله‌ی آخر نمی‌چسبد)
  async function doStep(plan, i, unitIdx) {
    const { s } = plan;
    const stepAmt = (plan.toSell * BigInt(steps[i])) / 100n;
    if (stepAmt === 0n) return "skip";
    const gp = await gasPrice();
    const rec = { wallet: s.address, step: i + 1, of: steps.length, pct: steps[i], amountWei: stepAmt.toString(), tx: null, state: "sending", at: new Date().toISOString() };
    sellLog.steps.push(rec);
    writeSellJournal();
    try {
      let tx;
      if (curve && !urUse) {
        await refreshPrice();
        const minOut = minOutFlag !== null ? minOutFlag : estMinOut(stepAmt, estPrice, slippageBps);
        const cr = new Contract(curve, BONDING_CURVE_ABI, s.wallet);
        const data = cr.interface.encodeFunctionData("sell", [stepAmt, minOut, s.address]);
        await provider.call({ to: curve, data, from: s.wallet.address }); // شبیه‌سازی قبل از ارسال
        tx = await cr.sell(stepAmt, minOut, s.address, { gasPrice: gp });
      } else {
        const blobHex = urDataSteps.length ? urDataSteps[unitIdx] : urDataSingle;
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const data = router.interface.encodeFunctionData("execute(bytes,bytes[],uint256)", [urCommand, [ethers.getBytes(blobHex)], deadline]);
        await provider.call({ to: ADDR.UNIVERSAL_ROUTER, data, from: s.wallet.address }); // شبیه‌سازی
        tx = await router.connect(s.wallet).execute(urCommand, [ethers.getBytes(blobHex)], deadline, { gasPrice: gp });
      }
      rec.tx = tx.hash;
      rec.state = "broadcast";
      writeSellJournal(); // هش بعد از send بلافاصله پایدار می‌شود
      try {
        await tx.wait(1, 120000);
      } catch (waitErr) {
        // ممیزی ۴: «timeout در انتظار رسید» با «ریورت‌شدن» یکی نیست — وضعیت واقعی را بپرس
        const st = await classifyTx(tx.hash, { polls: 3, intervalMs: 5000 });
        if (st !== "ok") {
          rec.state = st === "reverted" ? "reverted" : `uncertain:${st}`;
          writeSellJournal();
          plan.remaining -= stepAmt; // سهم این پله از «باقی‌مانده‌ی قابل‌فروش» خارج می‌شود (جذبِ پله‌ی آخر ممنوع)
          console.log(`   ${st === "reverted" ? "❌" : "⚠️"} پله ${i + 1} برای ${s.address.slice(0, 10)}…: ${st === "reverted" ? "ریورت شد" : `وضعیت نامعلوم «${st}»`} — ${tx.hash}`);
          return st === "reverted" ? "fail" : "uncertain";
        }
      }
      rec.state = "ok";
      writeSellJournal();
      plan.remaining -= stepAmt;
      console.log(`   ✅ ${s.address.slice(0, 10)}… پله ${i + 1}/${steps.length} (${steps[i]}%): ${tx.hash}`);
      return "ok";
    } catch (e) {
      rec.state = "failed-send";
      rec.error = (e.shortMessage ?? e.message).slice(0, 120);
      writeSellJournal();
      plan.remaining -= stepAmt;
      console.log(`   ❌ شکست ارسال پله ${i + 1} برای ${s.address.slice(0, 10)}…:`, rec.error);
      return "fail";
    }
  }

  if (order === "rr") {
    // round-robin: اول همه‌ی فروشنده‌ها پله ۱، بعد همه پله ۲ و… (الگوی فارم — توزیع زمانی نرمال)
    for (let i = 0; i < steps.length; i++) {
      for (let pi = 0; pi < livePlans.length; pi++) {
        const plan = livePlans[pi];
        if (plan.dead) continue;
        const r = await doStep(plan, i, pi * steps.length + i);
        if (r === "fail") { failedSteps++; plan.dead = true; }
        if (r === "uncertain") uncertainSteps++;
        if (i < steps.length - 1 || pi < livePlans.length - 1) await sleep(Math.max(0, rand(delayMin, delayMax)));
      }
    }
  } else {
    for (let pi = 0; pi < livePlans.length; pi++) {
      const plan = livePlans[pi];
      console.log(`\n🟠 ${plan.s.address} | موجودی: ${formatUnits(plan.bal, decimals)} | برنامه: ${targetPct}%`);
      for (let i = 0; i < steps.length; i++) {
        const r = await doStep(plan, i, pi * steps.length + i);
        if (r === "fail") { failedSteps++; break; }
        if (r === "uncertain") uncertainSteps++;
        if (i < steps.length - 1) await sleep(Math.max(0, rand(delayMin, delayMax)));
      }
    }
  }

  const leftovers = livePlans.filter((p) => p.remaining > 0n);
  if (leftovers.length) {
    console.log(`\n↩︎ باقی‌مانده‌ی فروخته‌نشده در ${leftovers.length} ولت:`);
    for (const p of leftovers) console.log(`   ${p.s.address}: ${formatUnits(p.remaining, decimals)} توکن`);
  }
  if (uncertainSteps > 0) {
    console.log(`\n⚠️ ${uncertainSteps} پله وضعیت «نامعلوم» دارد (timeout در انتظار رسید ولی تراکنش رد/قبول مشخص نشد) — با کد ۲ خارج می‌شوم.\n   ژورنال را چک کن؛ اجرای بعدی/Blockscout وضعیت واقعی را نشان می‌دهد: ${SELL_JOURNAL}`);
    process.exit(2);
  }
  if (failedSteps > 0) {
    console.log(`\n⛔ فروش با ${failedSteps} پله‌ی ناموفق تمام شد — موجودی‌های باقی‌مانده بالا اعلام شدند. ژورنال: ${SELL_JOURNAL}`);
    process.exit(1);
  }
  console.log("\n✔️ فروش تمام شد.");
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
