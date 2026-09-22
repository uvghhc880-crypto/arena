// کلیم فی از FeeEscrow — ولت کلیمر جدا از کریتور است (الگوی موج دوم فارم)
// توجه: creatorFeeRecipient لانچ باید برابر ولت کلیمر باشد تا این اسکریپت بتواند claim کند
// کلیم اتوماتیک (پول هر دقیقه) با --watch انجام می‌شود؛ هر کلیم ~۰٫۰۰۰۳ ETH گس دارد
import { Contract, ethers } from "ethers";
import { ADDR, env, parseArgs } from "./config.js";
import { FEE_ESCROW_ABI } from "./abis.js";
import { claimerWallet, masterWallet, deriveWorkers, workerStart, truthy, fmt, sleep } from "./lib.js";

async function claimOnce(signer, label = "") {
  const escrow = new Contract(ADDR.FEE_ESCROW, FEE_ESCROW_ABI, signer);
  const bal = await escrow.balanceOf(signer.address);
  console.log(`${label} → ${signer.address} | claimable: ${fmt(bal)} ETH`);
  if (bal === 0n) return BigInt(0);
  // توجه: escrow دو اورلود claim دارد (claim/claim(amount)) — باید صریح انتخاب شود
  const tx = await escrow.getFunction("claim()")();
  await tx.wait();
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
  const all = truthy(a.all); // علاوه بر کلیمر، مستر و کارگرها هم چک شوند (مانیتورینگ)

  const claimer = claimerWallet();
  console.log("کلیمر (ولت فی‌رسپینت):", claimer.address);

  // --all: کلیمر «هم» در لیست است (کلیمر اصلیِ کلیم) + مستر و کارگرها برای مانیتورینگ
  const targets = [];
  if (all) targets.push(claimer, masterWallet(), ...(() => { try { return deriveWorkers(Number(env("WORKER_COUNT", "28")), workerStart(a)).map((w) => w.wallet); } catch { return []; } })());
  else targets.push(claimer);

  do {
    for (const s of targets) {
      try {
        const claimed = await claimOnce(s, s === claimer ? "FEE" : "—");
        if (claimed > 0n && sweepTreasury && env("TREASURY_ADDRESS")) {
          if (!ethers.isAddress(env("TREASURY_ADDRESS"))) { console.log("⛔ TREASURY_ADDRESS نامعتبر است"); continue; }
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
        console.log("خطای کلیم:", e.shortMessage ?? e.message);
      }
    }
    if (!watch) break;
    await sleep(intervalMs);
  } while (true);
}

main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
