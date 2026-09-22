// عملیات خزانه/ولت‌ها: تولید ولت‌ها از نمونیک، شارژ گس اولیه، مانده‌خوانی، پس‌گیری (sweep)
// ژورنال شارژ با ساختار meta + entries (chainId/master/مبلغ)، نوشتن اتمیک، و وریفای آنچین در resume:
//   رکورد «ok» بدون رسید قابل تأیید یا رسید failed ⇒ چک موجودی آنچین؛ اگر نه، دوباره ارسال می‌شود.
import fs from "node:fs";
import { Wallet, isAddress } from "ethers";
import { WALLETS_OUT, CHAIN, env, parseArgs } from "./config.js";
import { provider, masterWallet, deriveWorkers, workerStart, truthy, legacyHd, eth, fmt, gasPrice, weiOf, resolveBatchAllocation, sleep, nowTag, atomicWriteJson, readJsonSafe, classifyTx, acquireRunLock, releaseRunLock, acquireSignerLocks, releaseSignerLocks } from "./lib.js";

const FUND_JOURNAL = `${WALLETS_OUT}/fund_journal.json`;
const FUND_LOCK = `${WALLETS_OUT}/fund.lock`;

// ژورنال جدید: { meta: {chainId, master, program}, entries: { addr: {valueWei, tx, at, state} } }
// مهاجرت خودکار از فرمت قدیمی (map ساده addr → entry)
function loadJournal() {
  let j;
  try { j = readJsonSafe(FUND_JOURNAL); } catch (e) { console.log("⛔", e.message); process.exit(1); }
  if (!j) return { meta: null, entries: {} };
  if (j.meta) return { meta: j.meta, entries: j.entries ?? {} };
  // مهاجرت فرمت قدیمی: مقدارهای valueEth را می‌نگه‌داریم و tx را برای وریفای داریم
  const entries = {};
  for (const [addr, v] of Object.entries(j)) {
    if (v && typeof v === "object") entries[addr] = { valueWei: v.valueWei ?? null, legacyValueEth: v.valueEth ?? null, tx: v.tx ?? null, at: v.at ?? null, state: "legacy" };
  }
  console.log("🔄 ژورنال قدیمی به فرمت جدید مهاجرت کرد (meta + entries)");
  return { meta: { chainId: CHAIN.id, master: null /* ناشناخته در فرمت قدیمی */ }, entries, migrated: true };
}
const saveJournal = (j) => atomicWriteJson(FUND_JOURNAL, j);

async function main() {
  const a = parseArgs();
  const cmd = !process.argv[2]?.startsWith("--") ? process.argv[2] : a.cmd;
  const legacy = legacyHd(a);

  if (cmd === "genmnemonic") {
    const w = Wallet.createRandom();
    console.log("نمونیک جدید (فقط در .env بگذار):", w.mnemonic.phrase);
    return;
  }

  if (cmd === "wallets") {
    const n = Number(a.n ?? env("WORKER_COUNT", "28"));
    const workers = deriveWorkers(n, workerStart(a), { legacy });
    console.log(`# ${n} ولت کارگر مشتق از MNEMONIC${legacy ? " (مسیر LEGACY قدیمی — فقط برای بازیابی لانچ‌های پیشین)" : ""}`);
    const out = workers.map((w) => w.address);
    console.log(out.join("\n"));
    if (a.save) {
      const f = `${WALLETS_OUT}/workers_${nowTag()}.txt`;
      fs.writeFileSync(f, out.join("\n"));
      console.log("💾", f);
    }
    return;
  }

  if (cmd === "fund") {
    // شارژ گس کارگرها — خرید باندل کار batch_buy/payer است، این‌جا فقط گس (~0.06 مجموعاً) کافی است
    // ممیزی ۵: --total به‌صورت رشته و string-first عبور می‌کند (بدون ضرر دقت Number)
    const totalStr = String(a.total ?? "0.06").trim();
    if (!/^\d+(\.\d{1,18})?$/.test(totalStr)) { console.log(`⛔ --total نامعتبر (عدد اعشاری مثبت، حداکثر ۱۸ رقم اعشار): "${a.total}"`); process.exit(1); }
    const totalWei = weiOf(totalStr);
    if (totalWei <= 0n) { console.log("⛔ --total باید بزرگ‌تر از صفر باشد"); process.exit(1); }
    // ⚠️ باگ ممیزی ۳ بود: --legacy-hd اینجا از chakra به deriveWorkers نمی‌رسید و پول به ولت‌های BIP44 جدید می‌رفت
    const workers = deriveWorkers(Number(a.workers ?? env("WORKER_COUNT", "28")), workerStart(a), { legacy });
    if (legacy) console.log("🕰️ --legacy-hd فعال: ولت‌های مقصد = مسیر قدیمی اشتباه (فقط بازیابی لانچ‌های پیشین)");
    const minShareWei = a["min-share"] ? weiOf(String(a["min-share"])) : 0n;
    const master = masterWallet();
    const force = truthy(a.force);   // ← فقط برای لاک (بازیابی PID مرده) — به‌صلاحیت ارسال تکراری نیست (ممیزی ۵)
    const resend = truthy(a.resend); // ← ارسال دوباره برای ولت‌های دارای رکورد تأییدشده — صریح و جدا
    if (force && !truthy(a["force-live-pid"])) console.log("ℹ️ --force فقط لاک مرده را کنار می‌زند — برای ارسالِ دوباره از --resend استفاده کن");

    // ممیزی ۵: لاک «قبل» از خواندن/تغییر ژورنال — دو اجرای هم‌زمان دیگر ژورنال را بازنویسی نمی‌کنند
    acquireRunLock(FUND_LOCK, { force, forceLivePid: truthy(a["force-live-pid"]), globalKey: `pons-fund-${CHAIN.id}-${master.address}` });
    await acquireSignerLocks([master], { label: "fund master" }); // لاک nonce سطح امضاکننده

    const journal = loadJournal();
    if (journal.meta && !journal.meta.chainId) journal.meta.chainId = CHAIN.id;
    // ناهماهنگی حیاتی: ژورنال برای چین/مستر دیگری است ولی --force نداری به کارش ادامه بدهی؟
    if (journal.meta?.chainId && Number(journal.meta.chainId) !== CHAIN.id) {
      console.log(`⛔ ژورنال شارژ برای chainId=${journal.meta.chainId} است ولی فعلی ${CHAIN.id} — اگر مطمئنی --fresh بزن`); process.exit(1);
    }
    if (journal.meta?.master && journal.meta.master.toLowerCase() !== master.address.toLowerCase()) {
      console.log(`⛔ ژورنال شارژ متعلق به مستر ${journal.meta.master} است ولی مستر فعلی ${master.address} — نادیده‌گرفتن این موجب شارژ/اسکیپ اشتباه می‌شود. (--fresh برای ژورنال جدید)`); process.exit(1);
    }
    if (truthy(a.fresh)) { journal.meta = { chainId: CHAIN.id, master: master.address, program: "fund" }; journal.entries = {}; journal.alloc = null; console.log("--fresh: ژورنال تازه"); }
    if (!journal.meta?.master) { journal.meta = { chainId: CHAIN.id, master: master.address, program: "fund" }; }

    // ─── نقشه‌ی تخصیص منجمد (ممیزی ۴): resume هرگز سهم‌ها را دوباره تصادفی نمی‌کند ───
    const recipients = workers.map((w) => w.address);
    let amountsWei;
    {
      const r = resolveBatchAllocation({ journal, fresh: truthy(a.fresh), recipients, totalWei, minShareWei });
      if (!r.ok) {
        if (r.reason === "alloc-missing-on-resume") {
          // ژورنال قدیمی بدون نقشه‌ی منجمد: فقط اگر همه‌ی ولت‌ها «تأییدشده»‌اند می‌شود ادامه داد (سهم‌ها از خودِ ژورنال بازتولید می‌شوند)
          const done = (e) => e && e.valueWei && (e.state === "ok" || e.state === "ok-balance-verified" || e.state === "legacy");
          if (!recipients.every((addr) => done(journal.entries[addr]))) {
            console.log(`⛔ ژورنال شارژ قبلی رکورد دارد ولی «نقشه‌ی تخصیص منجمد (alloc)» ندارد و هنوز ولت‌های شارژنشده/نامعلوم هست — resume غیرامن.
   گزینه‌ی امن: برای ولت‌های نامعلوم دستی وضعیت را روشن کن؛ اگر واقعاً می‌خواهی از صفر شارژ کنی (سهم‌های قبلی دوباره ارسال می‌شوند!) عمداً --fresh بزن.`);
            process.exit(1);
          }
          amountsWei = recipients.map((addr) => BigInt(journal.entries[addr].valueWei));
          console.log("♻️ resume «کاملاً شارژشده» — سهم‌ها از رکوردهای قبلی ژورنال بازتولید شدند (ارسالِ تازه فقط در صورت ناکامی وریفای)");
        } else {
          console.log(`⛔ نقشه‌ی تخصیص ژورنال با لیست ولت‌های این اجرا یکی نیست (${r.reason}) — resume غیرامن. یا همان لیست/فلگ‌ها (--workers/--worker-start/--legacy-hd) را بده یا عمداً --fresh (شارژ دوباره از صفر!).`);
          process.exit(1);
        }
      } else {
        amountsWei = r.amountsWei;
        if (r.source === "frozen") console.log(`♻️ resume با نقشه‌ی تخصیص منجمد‌شده‌ی ژورنال (همان ${journal.alloc.totalEth} ETH اجرای اول)`);
        if (r.journalAlloc) { journal.alloc = r.journalAlloc; saveJournal(journal); }
      }
    }

    if (resend) console.warn("⚠️ --resend: ولت‌های دارای رکورد تأییدشده هم دوباره ارسال می‌شوند (ارسال تکراری واقعی)");
    console.log(`💸 شارژ گس ${workers.length} ولت با مجموع ${totalStr} ETH از مستر`);
    const bal = await provider.getBalance(master.address);
    if (bal < totalWei + eth(0.005)) {
      console.log(`⛔ موجودی مستر کافی نیست: ${fmt(bal)} ETH < ${Number(totalStr) + 0.005} ETH`);
      process.exit(1);
    }

    let okCount = 0, skipCount = 0, failCount = 0;
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      const entry = journal.entries[w.address];
      if (entry && !resend) {
        // تعیین‌تکلیف «نیتِ بدون هش» (کرش دقیقاً بین ارسال و پاسخ RPC): با nonce داوری می‌شود، هرگز resend کور نه
        if (entry.state === "sending-intent" && Number.isInteger(entry.nonce)) {
          const countLatest = await provider.getTransactionCount(master.address);
          const countPending = await provider.getTransactionCount(master.address, "pending");
          if (countLatest > entry.nonce || (countPending > countLatest && countPending > entry.nonce)) {
            console.log(`   ⛔ ${w.address}: نیتِ بدون هش با nonce=${entry.nonce} «مصرف/در حال تعلیق» است — تعیین‌تکلیف دستی لازم؛ resend ممنوع (fail-closed)`);
            failCount++;
            continue;
          }
          console.log(`   ↩︎ ${w.address}: نیتِ بدون هش (nonce=${entry.nonce}) هرگز مصرف نشده ⇒ امن برای انجام دوباره`);
          journal.entries[w.address] = { ...entry, state: "intent-unconsumed" };
          saveJournal(journal);
        }
        // وریفای آنچین: وضعیت واقعی مرجع است نه متن ژورنال
        let st = entry.tx ? await classifyTx(entry.tx, { polls: 1 }) : "absent";
        if (st === "pending" || st === "unknown") {
          // تعلیق ⇒ هرگز resend: ابتدا تعیین‌تکلیف (تا ۹۰ ثانیه)، سپس دوباره داوری
          const t0 = Date.now();
          while ((st === "pending" || st === "unknown") && Date.now() - t0 < 90000) {
            console.log(`   ⏳ ${w.address}: تراکنش «${st}» — منتظر تعیین‌تکلیف…`);
            await sleep(10000);
            st = await classifyTx(entry.tx, { polls: 1 });
          }
          if (st === "pending" || st === "unknown") {
            console.log(`   ⛔ ${w.address}: تراکنش همچنان «${st}» است — resend در این اجرا انجام نمی‌شود (ابتدا دستی تعیین‌تکلیف کن)`);
            failCount++;
            continue;
          }
        }
        if (st === "ok") { console.log(`   ⏭️ ${w.address}: تأییدشده در زنجیره (${entry.tx.slice(0, 12)}…) — رد شد`); skipCount++; continue; }
        // تراکنش ریورت‌شده/ثبت‌نشده → چک موجودی فعلی: شاید مسیر دیگری شارژ شده
        try {
          const b = await provider.getBalance(w.address);
          const need = entry.valueWei ? BigInt(entry.valueWei) : amountsWei[i];
          if (b >= need) {
            journal.entries[w.address] = { ...entry, state: "ok-balance-verified", at: entry.at ?? new Date().toISOString() };
            saveJournal(journal);
            console.log(`   ⏭️ ${w.address}: موجودی آنچین تأیید کرد (${fmt(b)} ETH) — رد شد`); skipCount++; continue;
          }
        } catch {}
        console.log(`   ⚠️ رکورد قبلی ${w.address} تأیید نشد (tx: ${entry.tx ? st : "بدون هش"}) ⇒ دوباره ارسال می‌شود`);
      }
      const value = amountsWei[i];
      const gp = await gasPrice();
      try {
        // ممیزی ۵ — نیتِ ارسال «قبل» از broadcast با nonce صریح: کرش بین broadcast و پاسخ RPC ⇒ رکورد بدون هش ولی با nonce می‌ماند
        const nonce = await master.getNonce("pending");
        journal.entries[w.address] = { valueWei: value.toString(), nonce, at: new Date().toISOString(), state: "sending-intent" };
        saveJournal(journal);
        let tx;
        try {
          tx = await master.sendTransaction({ to: w.address, value, gasPrice: gp, nonce });
        } catch (sendErr) {
          journal.entries[w.address] = { valueWei: value.toString(), nonce, at: new Date().toISOString(), state: "failed-send", error: (sendErr.shortMessage ?? sendErr.message).slice(0, 100) };
          saveJournal(journal);
          throw sendErr;
        }
        // ← ثبت هش بلافاصله بعد از broadcast
        journal.entries[w.address] = { valueWei: value.toString(), tx: tx.hash, nonce, at: new Date().toISOString(), state: "broadcast" };
        saveJournal(journal);
        try {
          await tx.wait(1, 120000);
        } catch (e) {
          // TIMEOUT/قطع RPC ⇒ وضعیت واقعی را بپرس تا ارسال تکراری رخ ندهد
          const st = await classifyTx(tx.hash, { polls: 3, intervalMs: 5000 });
          if (st !== "ok") {
            journal.entries[w.address] = { valueWei: value.toString(), tx: tx.hash, at: new Date().toISOString(), state: `uncertain:${st}` };
            saveJournal(journal);
            failCount++;
            console.log(`   ❌ ${w.address}: وضعیت نامعلوم «${st}» (${tx.hash}) — اجرای بعدی وریفای می‌کند`);
            continue;
          }
        }
        journal.entries[w.address] = { valueWei: value.toString(), tx: tx.hash, at: new Date().toISOString(), state: "ok" };
        saveJournal(journal); // ژورنال اتمیک بعد از هر ارسال — ضد کرش
        okCount++;
        console.log(`   ✅ ${w.address}: ${fmt(value)} ETH (${tx.hash})`);
      } catch (e) {
        failCount++;
        console.log(`   ❌ ${w.address}:`, (e.shortMessage ?? e.message).slice(0, 100));
      }
      await sleep(200);
    }
    console.log(`\n✔️ پایان شارژ: ${okCount} ارسال، ${skipCount} رد (قبلاً شارژ)، ${failCount} ناموفق/نامعلوم — ژورنال: ${FUND_JOURNAL}`);
    releaseRunLock(FUND_LOCK);
    releaseSignerLocks();
    process.exitCode = failCount > 0 ? 1 : 0;
    return;
  }

  if (cmd === "balance") {
    const workers = deriveWorkers(Number(a.workers ?? env("WORKER_COUNT", "28")), workerStart(a), { legacy });
    let sum = 0n;
    for (const w of workers) {
      const b = await provider.getBalance(w.address);
      sum += b;
      console.log(`${w.address}: ${fmt(b)} ETH`);
    }
    console.log(`— جمع: ${fmt(sum)} ETH`);
    return;
  }

  if (cmd === "sweep") {
    const treasury = env("TREASURY_ADDRESS");
    if (!treasury || !isAddress(treasury)) { console.log("⛔ TREASURY_ADDRESS نامعتبر است — یک آدرس معتبر (EOA) در .env بگذار"); process.exit(1); }
    const workers = deriveWorkers(Number(a.workers ?? env("WORKER_COUNT", "28")), workerStart(a), { legacy });
    const keepReserve = BigInt(a.reserve ?? "50000000000000"); // 0.00005 ETH
    // توجه: هزینه گس ۲۱۰۰۰ برای خزانه‌ی EOA کافی است؛ اگر خزانه قرارداد است --reserve بزرگ‌تر بده
    for (const w of workers) {
      const bal = await provider.getBalance(w.address);
      if (bal <= keepReserve) continue;
      const gp = await gasPrice();
      const gasCost = gp * 21000n;
      const value = bal - keepReserve - gasCost;
      if (value <= 0n) continue;
      const tx = await w.wallet.sendTransaction({ to: treasury, value, gasPrice: gp });
      await tx.wait(1, 120000);
      console.log(`   💰 ${w.address} → خزانه: ${fmt(value)} ETH (${tx.hash})`);
      await sleep(200);
    }
    return;
  }

  console.log(`دستورات:
  node src/fund.js genmnemonic
  node src/fund.js wallets --n 28 [--save] [--legacy-hd]
  node src/fund.js fund --total 0.06 --workers 28 [--min-share 0.002] [--force|--fresh]
  node src/fund.js balance [--legacy-hd]
  node src/fund.js sweep`);
}

main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
