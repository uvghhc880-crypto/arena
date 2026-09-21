// لانچ توکن با الگوی V2: یک تراکنش = لانچ + خرید اول + exemptions
// کالیبره‌شده روی شش لانچ موج دوم (ساندی: creatorTaxBps=0، buyback=false، pairToken=0 یعنی رپد-نیتیو)
// مهم: creatorFeeRecipient به‌صورت پیش‌فرض برابر ولت کلیمر جداست (الگوی موج دوم)
import fs from "node:fs";
import path from "node:path";
import { Contract, ethers } from "ethers";
import { ADDR, LAUNCHES_DIR, env, parseArgs } from "./config.js";
import { LAUNCH_AND_BUY_ABI } from "./abis.js";
import { masterWallet, claimerWallet, deriveWorkers, workerStart, eth, fmt, nowTag } from "./lib.js";

const FACTORY_V2_ABI = [
  "function launchToken((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, address pairToken, address factoryRef) payable",
];

// مقدار ۳۲بایتی «پوچ» مشاهده‌شده در تمام لانچ‌های ساندیگ شده
const ZERO32 = "0x" + "0".repeat(64);

function pairTokenFromArgs(a) {
  if (a["pair-token"]) return a["pair-token"];
  const pe = env("PAIR_TOKEN");
  return pe ?? ethers.ZeroAddress;
}

async function main() {
  const a = parseArgs();
  if (a.dry === "factory") {
    // --dry factory : حالت تست‌سر — لانچ مستقیم از فکتوری با فی برگشتی، بدون خرید اول (الگوی روش B فارم)
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

  const minOut = a["min-out"] ? BigInt(a["min-out"]) : 0n;

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
    salt: a.salt ? (a.salt.startsWith("0x") ? a.salt : ethers.zeroPadValue(ethers.toBeArray(BigInt(a.salt)), 32)) : ethers.ZeroHash,
  };

  const pairToken = pairTokenFromArgs(a);
  const launchConfigId = Number(a["launch-config-id"] ?? env("LAUNCH_CONFIG_ID", "0"));
  if (!env("LAUNCH_CONFIG_ID") && !a["launch-config-id"]) {
    console.warn("⚠️ launchConfigId صفر فرض شد — اگر LaunchEconomicsMismatch دیدی مقدار درست را در .env بگذار.");
  }

  // ولیو تراکنش = فی لانچ + مبلغ خرید اول — فی از «فکتوری» خوانده می‌شود (launchFee روی LaunchAndBuy
  // در ABI ما نیست؛ فکتوری منبع معتبر است)، در غیر این صورت fallback:
  let launchFee;
  try {
    const factoryRead = new Contract(ADDR.LAUNCH_FACTORY_V2, ["function launchFee() view returns (uint256)"], master);
    launchFee = await factoryRead.launchFee();
    console.log(`ℹ️ فی لانچ آنچین (فکتوری): ${fmt(launchFee)} ETH`);
  } catch {
    launchFee = eth(env("LAUNCH_FEE_ETH", "0.0005"));
    console.log(`ℹ️ فی لانچ fallback: ${fmt(launchFee)} ETH`);
  }
  if (env("LAUNCH_FEE_ETH")) launchFee = eth(env("LAUNCH_FEE_ETH"));

  const value = launchFee + eth(quoteEth);

  console.log(`🚀 لانچ ${name} (${symbol}) | خرید اولیه: ${quoteEth} ETH | exemptions: ${snipeTaxExemptions.length}`);
  console.log(`   creator: ${master.address}`);
  console.log(`   feeRecipient (claimer): ${feeRecipient}`);
  if (exemptN > 0) console.log(`   ولت‌های معاف (${exemptN} ولت، از ایندکس ${exemptStart}): ${snipeTaxExemptions.join(", ")}`);

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
  const rc = await tx.wait();

  // استخراج آدرس توکن/کرو از ایونت Launched
  let tokenAddr, curveAddr, tokensOut;
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
  if (!tokenAddr) tokenAddr = rc.logs[0]?.address;

  const record = {
    name, symbol, txHash: tx.hash,
    token: tokenAddr ?? null, curve: curveAddr ?? null,
    creator: master.address, feeRecipient,
    quoteIn: quoteEth, exemptions: snipeTaxExemptions, workerStart: exemptStart,
    createdAt: new Date().toISOString(),
  };
  const file = path.join(LAUNCHES_DIR, `launch_${nowTag()}_${symbol}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log("🎉 لانچ موفق:", tokenAddr ? `token=${tokenAddr} curve=${curveAddr ?? "?"} tokensOut=${tokensOut ? tokensOut.toString() : "?"}` : "آدرس توکن از ایونت استخراج نشد — دستی چک کن");
  console.log("📄 رکورد:", file, JSON.stringify(record, null, 2));
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
  const tx = await factory.launchToken(params, ethers.ZeroAddress, master.address, { value: fee });
  console.log("tx:", tx.hash);
  const rc = await tx.wait();
  console.log("status:", rc.status === 1 ? "✅" : "❌", "logs:", rc.logs.length);
}

main().catch((e) => { console.error("❌", e.reason ?? e.shortMessage ?? e.message); process.exit(1); });
