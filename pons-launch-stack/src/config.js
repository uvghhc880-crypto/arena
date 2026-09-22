// تنظیمات پروژه — بدون وابستگی به dotenv (خواندن دستی فایل .env)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// پارس ساده‌ی .env — با چک fail-closed امنیت فایل (ممیزی ۳):
// لینک-سمبلیک یا مالک متفاوت یا پرمیشن باز ⇒ abort؛ با ALLOW_WEAK_ENV=1 صریحاً قابل‌غلبه است.
(function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const weakOk = process.env.ALLOW_WEAK_ENV === "1";
  try {
    const lst = fs.lstatSync(envPath);
    if (lst.isSymbolicLink() && !weakOk) {
      console.error("⛔ .env یک symbolic link است — به دلایل امنیتی اجرا متوقف شد. (ALLOW_WEAK_ENV=1 برای غلبه‌ی صریح)");
      process.exit(1);
    }
    const st = fs.statSync(envPath);
    if (typeof process.getuid === "function" && st.uid !== process.getuid() && st.uid !== 0 && !weakOk) {
      console.error(`⛔ مالک .env (${st.uid}) کاربر فعلی (${process.getuid()}) نیست — اجرا متوقف شد. (ALLOW_WEAK_ENV=1)`);
      process.exit(1);
    }
    if (st.mode & 0o077) {
      if (weakOk) console.warn("⚠️ پرمیشن .env باز است و با ALLOW_WEAK_ENV=1 پذیرفتید — `chmod 600 .env` بهتر است");
      else {
        console.error("⛔ پرمیشن .env باز است (خوانایی group/other) — ابتدا `chmod 600 .env` بزن. (ALLOW_WEAK_ENV=1 برای غلبه)");
        process.exit(1);
      }
    }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    // کامنت انتهای خط (با فاصله) حذف می‌شود: KEY=0x1abc # یادداشت
    if (val.includes(" #")) val = val.split(" #")[0].trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
})();

export const env = (key, def = undefined) => {
  const v = process.env[key];
  return v === undefined || v === "" ? def : v;
};

export const CHAIN = {
  id: Number(env("CHAIN_ID", "4663")),
  rpcUrl: env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
};

// --- آدرس‌های روی Robinhood Chain (تأییدشده روی Blockscout) ---
export const ADDR = {
  // کانترکت لانچ اتمیک پونز V2 — لانچ + خرید اول در یک تراکنش
  LAUNCH_AND_BUY: "0xe33e9e479df8802cb0866d5d05258bec4cf62948",
  // اسکروی فی کریتور — claim از اینجاست
  FEE_ESCROW: "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e",
  // یونیورسال روتر (برای فروش روی مارکت‌های V3/V4) — deployments رسمی uniswap/contracts، فایل 4663.md
  // نسخه‌ی قدیمی‌تر: 0x8876789976decbfcbbbe364623c63652db8c0904 | نسخه‌ی v2.1.2 (فرمت calldata جدید): 0x204FAca1764B154221e35c0d20aBb3c525710498
  UNIVERSAL_ROUTER: env("UNIVERSAL_ROUTER_ADDRESS", "0x8876789976decbfcbbbe364623c63652db8c0904"),
  // V4 PoolManager (مقصد نقدینگی بعد از گرجوئیشن) — checksum فرمت رسمی (حروف کوچک)
  POOL_MANAGER: env("POOL_MANAGER_ADDRESS", "0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  // Permit2 یونیسواپ (استاندارد)
  PERMIT2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  // WETH رسمی Robinhood Chain (docs.robinhood.com/chain/contracts)
  WETH: env("WETH_ADDRESS", "0x0bd7d308f8e1639fab988df18a8011f41eacad73"),
  // فکتوری اصلی V2 (خواندنی: launchFee/canLaunch/getLaunchConfig)
  LAUNCH_FACTORY_V2: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  // کانترکت کمکی بچ‌بای فارم واقعی (صرفاً مرجع/رصد — لازمش نداریم؛ کرو recipient می‌گیرد)
  BATCH_HELPER: "0x14b9A544e8c179Fc2040D3089dCC73bAF25aa8F9",
};

export const LAUNCHES_DIR = path.join(ROOT, "launches");
export const WALLETS_OUT = path.join(ROOT, "wallets-out");
for (const d of [LAUNCHES_DIR, WALLETS_OUT]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// آرگومان‌های خط فرمان به‌صورت --key value یا --key=value
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.includes("=")) {
      const [k, ...rest] = key.split("=");
      args[k] = rest.join("=");
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = "true";
      else { args[key] = next; i++; }
    }
  }
  return args;
}
