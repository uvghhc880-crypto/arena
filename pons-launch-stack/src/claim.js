// کلیم فی از FeeEscrow — ولت کلیمر جدا از کریتور است (الگوی موج دوم فارم)
// توجه: creatorFeeRecipient لانچ باید برابر ولت کلیمر باشد تا این اسکریپت بتواند claim کند
// کلیم اتوماتیک (پول هر دقیقه) با --watch انجام می‌شود؛ هر کلیم ~۰٫۰۰۰۳ ETH گس دارد
// ممیزی ۴:
// - پیش‌فرض --all «فقط مانیتورینگ» است (بدون کلیم مستر/کارگرها)؛ کلیم واقعی آن‌ها با --all-claim صریح انجام می‌شود
// - هر شکست در اجرای تک‌بار = کد ۱ (فلش موفقیت کاذب به اسکریپت بالادستی داده نمی‌شود)
// - حالت --watch لاک اجرایی دارد (دو watcher هم‌زمان ⇒ دوبرابر کلیم/گس)
// - preflight: FeeEscrow واقعاً قرارداد است
import { Contract, ethers } from "ethers";
import { ADDR, WALLETS_OUT, env, parseArgs } from "./config.js";
import { FEE_ESCROW_ABI } from "./abis.js";
import { claimerWallet, masterWallet, deriveWorkers, workerStart, truthy, fmt, sleep, acquireRunLock, releaseRunLock, assertContract } from "./lib.js";

async function claimOnce(signer, label = "", { doClaim = true } = {}) {
  const escrow = new Contract(ADDR.FEE_ESCROW, FEE_ESCROW_ABI, signer);
  const bal = await escrow.balanceOf(signer.address);
  console.log(`${label} → ${signer.address} | claimable: ${fmt(bal)} ETH${doClaim ? "" : " (فقط مانیتورینگ — کلیم نمی‌شود)"}`);
  if (!doClaim || bal === 0n) return BigInt(0);
  // توجه: escrow دو اورلود claim دارد (claim/claim(amount)) — باید صریح انتخاب شود
  const tx = await escrow.getFunction("claim()")();
  await tx.wait(1, 120000); // ممیزی ۵: wait بدون timeout = گیرکردن لایتناهی
  console.log(`✅ کلیم ${fmt(bal)} ETH به ${signer.address}: ${tx.hash}`);
  return bal; // مقدار کلیم‌شده (برای sweep «فقط دلتای کلیم»)
}

async function main() {
  const a = parseArgs();
  // فلگ‌ها با truthy: --watch=false و --sweep=false واقعاً خاموش‌اند (رفع «پرچم غیراستاندارد»)
  const watch = truthy(a.watch);
  const sweepTreasury = truthy(a.sweep);
  const sweepAll = truthy(a["sweep-all"]); // مُد قدیمی: «کل» موجودی، نه فقط دلتای کلیم
  const intervalMs = Number(env("CLAIM_INTERVAL_MS", "60000"));
  if (!Number.isFinite(intervalMs) || intervalMs < 5000) { console.log("⛔ CLAIM_INTERVAL_MS باید ≥ 5000 میلی‌ثانیه باشد"); process.exit(1); }
  const all = truthy(a.all);           // مانیتورینگِ مستر/کارگرها (فقط نمایش claimable)
  const allClaim = truthy(a["all-claim"]); // کلیم واقعی برای مستر/کارگرها — صریح و جدا

  // preflight: FeeEscrow قرارداد است؟ (ممیزی ۴)
  await assertContract(ADDR.FEE_ESCROW, "FeeEscrow");

  // لاک اجرا — ممیزی ۵: watcher «و» اجرای تک‌بار هر دو (دو فرایند کلیم هم‌زمان ممنوع)
  acquireRunLock(`${WALLETS_OUT}/claim.lock`, { globalKey: `pons-claim-${claimerWallet().address}` });
  const locked = true;

  const claimer = claimerWallet();
  console.log("کلیمر (ولت فی‌رسپینت):", claimer.address);

  // --all: کلیمر (کلیم واقعی) + مستر و کارگرها (پیش‌فرض: فقط مانیتورینگ | با --all-claim: کلیم)
  const targets = [];
  if (all || allClaim) targets.push(claimer, masterWallet(), ...(() => { try { return deriveWorkers(Number(env("WORKER_COUNT", "28")), workerStart(a)).map((w) => w.wallet); } catch { return []; } })());
  else targets.push(claimer);
  if (all && !allClaim) console.log(`ℹ️ --all برای مستر/کارگرها فقط «مانیتورینگ» است — برای کلیم واقعی آن‌ها: --all-claim`);

  let failures = 0;
  do {
    for (const s of targets) {
      try {
        const doClaim = s === claimer || allClaim;
        const claimed = await claimOnce(s, s === claimer ? "FEE" : "—", { doClaim });
        if (claimed > 0n && sweepTreasury && env("TREASURY_ADDRESS")) {
          if (!ethers.isAddress(env("TREASURY_ADDRESS"))) { console.log("⛔ TREASURY_ADDRESS نامعتبر است"); failures++; continue; }
          let b = await s.provider.getBalance(s.address);
          const reserve = ethers.parseEther("0.0001");
          if (b > reserve) {
            const gp = (await s.provider.getFeeData()).gasPrice ?? 0n;
            // پیش‌فرض: فقط دلتایِ همین کلیم منتقل می‌شود (رفع «کل موجودی جابه‌جا می‌شد»)
            // --sweep-all = رفتار قدیمی: هر چه از ولت بالاتر از رزرو است
            let value = sweepAll ? b - reserve - (gp * 21000n) : claimed - (gp * 21000n);
            if (value > b - reserve) value = b - reserve; // سقف: رزرو‌ی آستانه همیشه می‌ماند
            if (value > 0n) {
              const tx = await s.sendTransaction({ to: env("TREASURY_ADDRESS"), value, gasPrice: gp });
              await tx.wait(1, 120000);
              console.log(`💰 sweep ${fmt(value)} ETH → خزانه (${tx.hash})${sweepAll ? " [sweep-all]" : " [فقط دلتای کلیم]"}`);
            }
          }
        }
      } catch (e) {
        failures++;
        console.log("خطای کلیم:", e.shortMessage ?? e.message);
      }
    }
    if (!watch) break;
    await sleep(intervalMs);
  } while (true);

  if (locked) releaseRunLock(`${WALLETS_OUT}/claim.lock`);
  // ممیزی ۴: اجرای تک‌بار با هر شکستی کد ۱ می‌گیرد (watcher همچنان ادامه دارد و فقط شمارش می‌کند)
  if (!watch && failures > 0) { console.log(`⛔ کلیم با ${failures} شکست تمام شد`); process.exit(1); }
}

main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
