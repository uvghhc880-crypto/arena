// ABIهای واقعی استخراج‌شده از Blockscout رسمی Robinhood Chain (کانترکت‌های وریفای‌شده)

// PonsV2LaunchAndBuy: لانچ + خرید اولیه در یک تراکنش (0xe33e9e479df8802cb0866d5d05258bec4cf62948)
export const LAUNCH_AND_BUY_ABI = [
  "function launchAndBuy((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
  "function factory() view returns (address)",
  "event Launched(address indexed token, address indexed curve, address indexed recipient, address launcher, uint256 quoteSpent, uint256 tokensReceived)",
  "error NotApprovedLauncher()",
  "error NativeValueMismatch(uint256 sent, uint256 expected)",
  "error ZeroAmount()",
  "error ZeroAddress()",
];

// PonsV2FeeEscrow: تجمیع فی‌های کریتور + پروتکل (0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e)
export const FEE_ESCROW_ABI = [
  "function credit(address recipient) payable",
  "function claim() returns (uint256 amount)",
  "function claim(uint256 amount) returns (uint256)",
  "function claimToken(address token) returns (uint256 amount)",
  "function claimToken(address token, uint256 amount) returns (uint256)",
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "event Claimed(address indexed recipient, uint256 amount)",
  "event Credited(address indexed recipient, address indexed depositor, uint256 amount)",
];

// PonsV2BondingCurve (ورify‌شده؛ نمونه کروی TWINE = 0xe1229bdc…) — امضاهای واقعی از سورس رسمی
export const BONDING_CURVE_ABI = [
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokenIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event SnipeTaxExempted(address indexed account)",
  "error NativeValueMismatch(uint256 supplied, uint256 expected)",
  "error SlippageExceeded(uint256 actual, uint256 minimum)",
];

// ERC20 حداقلی
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

// Uniswap UniversalRouter (0x8876789976decbfcbbbe364623c63652db8c0904) — فقط execute
export const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "function execute(bytes commands, bytes[] inputs) payable",
];
