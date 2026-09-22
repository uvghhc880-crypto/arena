// لانچ توکن با الگوی V2: یک تراکنش = لانچ + خرید اول + exemptions
// کالیبره‌شده روی شش لانچ موج دوم (ساندی: creatorTaxBps=0، buyback=false، pairToken=0 یعنی رپد-نیتیو)
// مهم: creatorFeeRecipient به‌صورت پیش‌فرض برابر ولت کلیمر جداست (الگوی موج دوم)
import fs from "node:fs";
import path from "node:path";
import { Contract, ethers } from "ethers";
import { ADDR, CHAIN, LAUNCHES_DIR, env, parseArgs } from "./config.js";
import { LAUNCH_AND_BUY_ABI } from "./abis.js";
import { masterWallet, claimerWallet, deriveWorkers, workerStart, truthy, eth, fmt, nowTag, provider, normalizeBytes32, atomicWriteJson } from "./lib.js";

const FACTORY_V2_ABI = [
  "function launchToken((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, address pairToken, address factoryRef) payable",
];

// مقدار ۳۲بایتی «پوچ» مشاهده‌شده در تمام لانچ‌های ساندیگ شده
const ZERO32 = "0x" + "0".repeat(64);

// پاک‌سازی رشته برای نام فایل (جلوگیری از path traversal مثل ../../)
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "TOKEN";

function pairTokenFromArgs(a) {
  if (a["pair-token"]) return a["pair-token"];
  const pe = env("PAIR_TOKEN");
  return pe ?? ethers.ZeroAddress;
}

async function main() {
  const a = parseArgs();
  if (a.dry === "factory") {
    // --dry factory : حالت تست‌سر — نام فلگ تاریخی است؛ این مسیر تراکنش «واقعی» می‌فرستد!
    // گیت ایمنی: نداشتن --i-know-this-sends ⇒ ابطال تا ارسال واقعی کاملاً آگاهانه باشد
    if (!truthy(a["i-know-this-sends"])) {
      console.log(`🧨 «--dry factory» با وجود نامش، تراکنش واقعی روی مین‌نت ارسال می‌کند و فی می‌سوزاند.
اگر فقط شبیه‌سازی می‌خواهی، این فلگ را بده:  --i-know-this-sends`);
      process.exit(1);
    }
    console.warn("🧨 ارسال واقعی --dry factory با گیت تأیید (--i-know-this-sends)");
    return dryFactoryLaunch(a);
  }

  const name = a.name ?? `TEST ${Date.now() % 100000}`;
  const symbol = a.symbol ?? `T${Date.now() % 100000}`;
  const quoteEth = a.quote ?? "0.003";
  const exemptN = Number(a.exemptions ?? env("WORKER_COUNT", "28"));
  const exemptStart = workerStart(a); // آفست باید با fund/batch_buy/exit یکی باشد

  const master = masterWallet();
  const claimer = claimerWallet();

  const lab = new Contract(ADDR.LAUNCH_AND_BUY, LAUNCH_AND_BUY_ABI, master);

  const feeRecipientExplicit = a["fee-recipient"];
  const feeRecipient = feeRecipientExplicit ?? claimer.address;
  if (feeRecipient.toLowerCase() !== claimer.address.toLowerCase()) {
    console.warn("⚠️ هشدار: creatorFeeRecipient با ولت کلیمر فرق دارد! کلیم توسط کلیمر شکست خواهد خورد.");
  }
  if (feeRecipient.toLowerCase() === master.address.toLowerCase()) {
    console.warn("⚠️ هشدار: فی‌رسپینت = کریتور است — الگوی موج دوم جدا بودن ولت کلیمر است.");
  }

  // exemptions: ولت‌های کارگر (باندل) — اگر MNEMONIC نداری ونیازی به معاف نداری با --exemptions 0 ردش کن
  let snipeTaxExemptions = [];
  if (exemptN > 0) {
    const workers = deriveWorkers(exemptN, exemptStart);
    snipeTaxExemptions = workers.map((w) => w.address);
  }

  const minOut = a["min-out"] !== undefined ? BigInt(a["min-out"]) : 0n;
  if (minOut === 0n)
    console.warn("⚠️ خرید اولیه‌ی لانچ با minOut=0 انجام می‌شود — چون لیکوییدیتی قبلی وجود ندارد این پیش‌فرضِ الگوی فارم است؛ اگر می‌خواهی از slippage‌ای غیرمنتظره محافظت شوی --min-out <wei> بده.");

  // salt: هگز (هر طولی) → zeroPad به ۳۲ بایت؛ عدد → تبدیل به ۳۲ بایت
  let salt = ethers.ZeroHash;
  if (a.salt) {
    salt = a.salt.startsWith("0x")
      ? normalizeBytes32(a.salt)                                   // هگز — طول فرد هم امن
      : normalizeBytes32("0x" + BigInt(a.salt).toString(16));      // عدد صحیح
  }

  const params = {
    name,
    symbol,
    logo: a.logo ?? "",
    description: a.description ?? "token created via pons-launch-stack",
    socials: {
      twitter: a.twitter ?? "",
      telegram: a.telegram ?? "",
      discord: a.discord ?? "",
      website: a.website ?? "",
      farcaster: a.farcaster ?? "",
    },
    creatorFeeRecipient: feeRecipient,
    creatorTaxBps: Number(a["creator-tax-bps"] ?? 0),
    buybackEnabled: false,
    expectedEconomics: env("EXPECTED_ECONOMICS", ZERO32),
    salt,
  };

  const pairToken = pairTokenFromArgs(a);
  const launchConfigId = Number(a["launch-config-id"] ?? env("LAUNCH_CONFIG_ID", "0"));
  if (!env("LAUNCH_CONFIG_ID") && !a["launch-config-id"]) {
    console.warn("⚠️ launchConfigId صفر فرض شد — اگر LaunchEconomicsMismatch دیدی مقدار درست را در .env بگذار.");
  }

  // ولیو تراکنش = فی لانچ + مبلغ خرید اول — فی از «فکتوری» خوانده می‌شود؛ env فقط با --force-fee-env
  let launchFee = null;
  let onchainFee = null;
  try {
    const factoryRead = new Contract(ADDR.LAUNCH_FACTORY_V2, ["function launchFee() view returns (uint256)"], master);
    onchainFee = await factoryRead.launchFee();
    launchFee = onchainFee;
    console.log(`ℹ️ فی لانچ آنچین (فکتوری): ${fmt(launchFee)} ETH`);
  } catch {
    launchFee = eth(env("LAUNCH_FEE_ETH", "0.0005"));
    console.log(`ℹ️ فی لانچ fallback: ${fmt(launchFee)} ETH`);
  }
  if (env("LAUNCH_FEE_ETH")) {
    const envFee = eth(env("LAUNCH_FEE_ETH"));
    if (onchainFee !== null && envFee !== onchainFee) {
      if (truthy(a["force-fee-env"])) {
        launchFee = envFee;
        console.warn(`⚠️ override اجباری فی: env=${fmt(envFee)} به‌جای آنچین=${fmt(onchainFee)}`);
      } else {
        console.warn(`⚠️ LAUNCH_FEE_ETH در env (${fmt(envFee)}) با فی آنچین (${fmt(onchainFee)}) فرق دارد — آنچین استفاده شد. برای اجبار: --force-fee-env`);
      }
    } else if (onchainFee === null) {
      launchFee = envFee;
    }
  }

  const value = launchFee + eth(quoteEth);

  console.log(`🚀 لانچ ${name} (${symbol}) | خرید اولیه: ${quoteEth} ETH | exemptions: ${snipeTaxExemptions.length}`);
  console.log(`   creator: ${master.address}`);
  console.log(`   feeRecipient (claimer): ${feeRecipient}`);
  if (exemptN > 0) console.log(`   ولت‌های معاف (${exemptN} ولت، از ایندکس ${exemptStart}): ${snipeTaxExemptions.join(", ")}`);

  // شبیه‌سازی کامل قبل از ارسال — اگر ریورت کند، ETH از دست نمی‌رود
  const callData = lab.interface.encodeFunctionData("launchAndBuy", [params, launchConfigId, pairToken, eth(quoteEth), minOut, master.address, snipeTaxExemptions]);
  try {
    await provider.call({ to: ADDR.LAUNCH_AND_BUY, data: callData, value, from: master.address });
    console.log("🧪 شبیه‌سازی لانچ: OK");
  } catch (e) {
    console.log("⛔ شبیه‌سازی لانچ ریورت شد — هیچ تراکنشی ارسال نشد:", (e.shortMessage ?? e.message).slice(0, 160));
    process.exit(1);
  }

  const tx = await lab.launchAndBuy(
    params,
    launchConfigId,
    pairToken,
    eth(quoteEth),
    minOut,
    master.address, // recipient خرید اول = کریتور
    snipeTaxExemptions,
    { value }
  );
  console.log("tx:", tx.hash);

  // ← رکورد FIRST، بلافاصله بعد از broadcast و قبل از wait: اگر الان RPC بترکه یا فرایند کرش کند،
  // «تراکنش داریم ولی آدرس توکن نه» — رسید بعداً با `src/probe.js --sig ...` یا Blockscout تکمیل می‌شود.
  const file = path.join(LAUNCHES_DIR, `launch_${nowTag()}_${safeName(symbol)}.json`);
  const record = {
    name, symbol, txHash: tx.hash,
    token: null, curve: null, state: "broadcast",
    creator: master.address, feeRecipient,
    quoteIn: quoteEth, exemptions: snipeTaxExemptions, workerStart: exemptStart,
    chainId: CHAIN.id, launchConfigId, launchFeeWei: launchFee.toString(),
    receiptStatus: null, blockNumber: null,
    createdAt: new Date().toISOString(),
  };
  atomicWriteJson(file, record);
  console.log("📄 رکورد اولیه (state=broadcast) نوشته شد:", file);

  const rc = await tx.wait(1, 180000);
  if (rc.status !== 1) {
    console.log("⛔ تراکنش لانچ ریورت شد (status=0) — رکورد با token=null می‌ماند");
  }

  // استخراج آدرس توکن/کرو فقط از ایونت Launched — بدون حدس از logs[0] (حدس می‌تواند آدرس اشتباه ذخیره کند!)
  let tokenAddr = null, curveAddr = null, tokensOut = null;
  const iface = lab.interface;
  for (const log of rc.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Launched") {
        tokenAddr = parsed.args.token;
        curveAddr = parsed.args.curve;
        tokensOut = parsed.args.tokensReceived;
      }
    } catch {}
  }
  if (!tokenAddr) console.warn("⚠️ ایونت Launched پیدا نشد — token/curve در رکورد null است؛ از Blockscout دستی بخوان و در رکورد بنویس");

  // به‌روزرسانی رکورد نهایی روی همان فایل
  record.token = tokenAddr ?? null;
  record.curve = curveAddr ?? null;
  record.state = rc.status === 1 ? "confirmed" : "reverted";
  record.receiptStatus = rc.status;
  record.blockNumber = rc.blockNumber;
  record.confirmedAt = new Date().toISOString();
  atomicWriteJson(file, record);
  console.log("🎉 پایان لانچ:", tokenAddr ? `token=${tokenAddr} curve=${curveAddr ?? "?"} tokensOut=${tokensOut ? tokensOut.toString() : "?"}` : "آدرس توکن null (رکورد را دستی تکمیل کن)");
  console.log("📄 رکورد (نهایی):", file);
}

async function dryFactoryLaunch(a) {
  const name = a.name ?? `DRY ${Date.now() % 100000}`;
  const symbol = a.symbol ?? `D${Date.now() % 100000}`;
  const master = masterWallet();
  const claimer = claimerWallet();
  const factory = new Contract(ADDR.LAUNCH_FACTORY_V2, FACTORY_V2_ABI, master);
  const params = {
    name, symbol,
    logo: "", description: "", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
    creatorFeeRecipient: claimer.address,
    creatorTaxBps: 0, buybackEnabled: false,
    expectedEconomics: env("EXPECTED_ECONOMICS", ZERO32),
    salt: ZERO32,
  };
  const fee = eth(env("LAUNCH_FEE_ETH", "0.0005"));
  console.log(`🧪 لانچ خشک فکتوری (بدون خرید اول) ${symbol} روی ${ADDR.LAUNCH_FACTORY_V2}`);
  // شبیه‌سازی قبل از ارسال واقعی
  const data = factory.interface.encodeFunctionData("launchToken", [params, ethers.ZeroAddress, master.address]);
  try {
    await provider.call({ to: ADDR.LAUNCH_FACTORY_V2, data, value: fee, from: master.address });
    console.log("🧪 شبیه‌سازی: OK");
  } catch (e) {
    console.log("⛔ شبیه‌سازی ریورت شد — ارسال نشد:", (e.shortMessage ?? e.message).slice(0, 160));
    process.exit(1);
  }
  const tx = await factory.launchToken(params, ethers.ZeroAddress, master.address, { value: fee });
  console.log("tx:", tx.hash);
  const rc = await tx.wait();
  console.log("status:", rc.status === 1 ? "✅" : "❌", "logs:", rc.logs.length);
}

main().catch((e) => { console.error("❌", e.reason ?? e.shortMessage ?? e.message); process.exit(1); });
