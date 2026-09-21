// عملیات خزانه/ولت‌ها: تولید ولت‌ها از نمونیک، شارژ گس اولیه، مانده‌خوانی، پس‌گیری (sweep)
import fs from "node:fs";
import { Wallet } from "ethers";
import { WALLETS_OUT, env, parseArgs } from "./config.js";
import { provider, masterWallet, deriveWorkers, workerStart, eth, fmt, gasPrice, splitRandom, sleep, nowTag } from "./lib.js";

async function main() {
  const a = parseArgs();
  const cmd = !process.argv[2]?.startsWith("--") ? process.argv[2] : a.cmd;

  if (cmd === "genmnemonic") {
    const w = Wallet.createRandom();
    console.log("نمونیک جدید (فقط در .env بگذار):", w.mnemonic.phrase);
    return;
  }

  if (cmd === "wallets") {
    const n = Number(a.n ?? env("WORKER_COUNT", "28"));
    const workers = deriveWorkers(n, workerStart(a));
    console.log(`# ${n} ولت کارگر مشتق از MNEMONIC`);
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
    const total = Number(a.total ?? "0.06");
    const workers = deriveWorkers(Number(a.workers ?? env("WORKER_COUNT", "28")), workerStart(a));
    const shares = splitRandom(total, workers.length);
    const master = masterWallet();
    const gp = await gasPrice();
    console.log(`💸 شارژ گس ${workers.length} ولت با مجموع ${total} ETH از مستر`);
    const bal = await provider.getBalance(master.address);
    if (bal < eth(total + 0.005)) {
      console.log(`⛔ موجودی مستر کافی نیست: ${fmt(bal)} ETH < ${total + 0.005} ETH`);
      process.exit(1);
    }
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      const value = eth(shares[i].toFixed(6));
      const tx = await master.sendTransaction({ to: w.address, value, gasPrice: gp });
      await tx.wait();
      console.log(`   ✅ ${w.address}: ${fmt(value)} ETH (${tx.hash})`);
      await sleep(200);
    }
    return;
  }

  if (cmd === "balance") {
    const workers = deriveWorkers(Number(a.workers ?? env("WORKER_COUNT", "28")), workerStart(a));
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
    if (!treasury) { console.log("TREASURY_ADDRESS را در .env بگذار"); process.exit(1); }
    const workers = deriveWorkers(Number(a.workers ?? env("WORKER_COUNT", "28")), workerStart(a));
    const keepReserve = BigInt(a.reserve ?? "50000000000000"); // 0.00005 ETH
    for (const w of workers) {
      const bal = await provider.getBalance(w.address);
      if (bal <= keepReserve) continue;
      const gp = await gasPrice();
      const gasCost = gp * 21000n;
      const value = bal - keepReserve - gasCost;
      if (value <= 0n) continue;
      const tx = await w.wallet.sendTransaction({ to: treasury, value, gasPrice: gp });
      await tx.wait();
      console.log(`   💰 ${w.address} → خزانه: ${fmt(value)} ETH (${tx.hash})`);
      await sleep(200);
    }
    return;
  }

  console.log(`دستورات:
  node src/fund.js genmnemonic
  node src/fund.js wallets --n 28 [--save]
  node src/fund.js fund --total 0.06 --workers 28   # شارژ گس (خرید باندل با batch_buy است)
  node src/fund.js balance
  node src/fund.js sweep`);
}

main().catch((e) => { console.error("❌", e.shortMessage ?? e.message); process.exit(1); });
