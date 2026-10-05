# بخش‌های مفقود - سورس کد کامل از زنجیره

## ۱. بدنه کامل کتابخانه محاسباتی منحنی باندینگ

سورس کد اصلی در مسیر `contracts/libraries/BondingCurveMath.sol` قرار دارد. از آنجا که کد به صورت مستقیم در چانک‌های API پخش شده و فایل‌بندی آن به صورت یکپارچه نیست، فرمول‌های اصلی از نحوه فراخوانی در قرارداد منحنی باندینگ قابل استخراج هستند:

### فرمول‌های استفاده‌شده در کد:

```solidity
// خروجی بر اساس ورودی - فرمول محصول ثابت
// getAmountOut(amountIn, reserveIn, reserveOut, offset)
// = (amountIn * reserveOut) / (reserveIn + offset + amountIn)

// ورودی بر اساس خروجی مورد نظر
// getAmountIn(amountOut, reserveIn, reserveOut, offset)
// = (amountOut * (reserveIn + offset)) / (reserveOut - amountOut)
// با بررسی اینکه amountOut < reserveOut

// قیمت‌گذاری مستقیم برای بازخرید
// quoteAmountOut(quoteIn, quoteReserve, tokenReserve, phantomQuote)
// = (quoteIn * tokenReserve) / (quoteReserve + phantomQuote + quoteIn)
```

**نکته مهم:** پارامتر `phantomQuote` (یا `offset`) ذخیره مجازی‌ای است که شکل منحنی را قبل از رسیدن سرمایه واقعی تعیین می‌کند. این پارامتر در سازنده منحنی باندینگ ست می‌شود و مقدار آن از `pairTokenEconomics` در فکتوری می‌آید.

---

## ۲. محاسبات و تسویه کامل قرارداد هوک میم

### ۲.۱ ثبت استخر (registerPool)

```solidity
function _registerPool(
    PoolKey calldata key,
    address memecoin,
    address creator,
    address buybackCreatorRecipient,
    uint16 creatorTaxBps,
    bool buybackEnabled,
    FeePolicySnapshot memory policy
) private {
    PoolId poolId = key.toId();
    if (launches[poolId].registered) revert AlreadyRegistered();
    if (creator == address(0) || buybackCreatorRecipient == address(0)) revert ZeroAddress();
    
    // بررسی سقف‌ها
    if (policy.protocolFeeRecipient == address(0) || 
        policy.protocolFeeShareBps > MAX_PROTOCOL_FEE_SHARE_BPS ||
        policy.buybackBurnBps > BASIS_POINTS || 
        policy.hookFeeBps > MAX_HOOK_FEE_BPS ||
        policy.maxInternalPriceImpactBps == 0 || 
        policy.maxInternalPriceImpactBps >= BASIS_POINTS) {
        revert InvalidBps();
    }
    if (uint256(creatorTaxBps) + policy.hookFeeBps > MAX_TOTAL_TRADE_FEE_BPS) revert InvalidBps();

    // تشخیص طرف میم‌کوین
    if (address(key.hooks) != address(this)) revert InvalidPoolKey();
    bool memecoinIsCurrency0 = Currency.unwrap(key.currency0) == memecoin;
    if (!memecoinIsCurrency0 && Currency.unwrap(key.currency1) != memecoin) revert InvalidPoolKey();

    address quoteToken = memecoinIsCurrency0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);

    launches[poolId] = LaunchInfo({
        registered: true,
        memecoinIsCurrency0: memecoinIsCurrency0,
        memecoin: memecoin,
        quoteToken: quoteToken,
        creator: creator,
        buybackCreatorRecipient: buybackCreatorRecipient,
        protocolFeeRecipient: policy.protocolFeeRecipient,
        creatorTaxBps: creatorTaxBps,
        protocolFeeShareBps: policy.protocolFeeShareBps,
        buybackBurnBps: policy.buybackBurnBps,
        hookFeeBps: policy.hookFeeBps,
        maxInternalPriceImpactBps: policy.maxInternalPriceImpactBps,
        buybackEnabled: buybackEnabled
    });
    _poolKeys[poolId] = key;
}
```

### ۲.۲ جمع‌آوری کارمزد پس از هر سواپ (afterSwap)

```solidity
function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, 
    BalanceDelta delta, bytes calldata)
    internal override returns (bytes4, int128)
{
    PoolId poolId = key.toId();
    LaunchInfo memory info = launches[poolId];
    if (!info.registered) return (IHooks.afterSwap.selector, 0);
    if (info.hookFeeBps == 0 && info.creatorTaxBps == 0) return (IHooks.afterSwap.selector, 0);

    // تشخیص پایه سواپ
    bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
    (Currency feeCurrency, int128 unspecifiedAmount) =
        specifiedIsCurrency0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
    if (unspecifiedAmount < 0) unspecifiedAmount = -unspecifiedAmount;
    if (unspecifiedAmount == 0) return (IHooks.afterSwap.selector, 0);

    uint256 unspecified = uint256(uint128(unspecifiedAmount));
    uint256 feeAmount = (unspecified * info.hookFeeBps) / BASIS_POINTS;
    uint256 taxAmount = (unspecified * info.creatorTaxBps) / BASIS_POINTS;
    uint256 totalAmount = feeAmount + taxAmount;
    if (totalAmount == 0) return (IHooks.afterSwap.selector, 0);

    // برداشت کارمزد از مدیر استخر
    address feeCurrencyAddr = Currency.unwrap(feeCurrency);
    _takeExact(feeCurrency, feeCurrencyAddr, totalAmount);
    
    if (feeAmount != 0) {
        pendingFees[poolId][feeCurrencyAddr] += feeAmount;
        if (info.buybackEnabled) {
            uint256 creatorSlice = feeAmount - (feeAmount * info.protocolFeeShareBps) / BASIS_POINTS;
            pendingBuyback[poolId][feeCurrencyAddr] += (creatorSlice * info.buybackBurnBps) / BASIS_POINTS;
        }
    }
    if (taxAmount != 0) pendingCreatorTax[poolId][feeCurrencyAddr] += taxAmount;

    return (IHooks.afterSwap.selector, int128(uint128(totalAmount)));
}
```

### ۲.۳ تسویه کارمزدهای استخر (sweepPoolFees)

```solidity
function sweepPoolFees(PoolId poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)
    external nonReentrant
{
    LaunchInfo memory info = launches[poolId];
    if (!info.registered) revert UnknownPool();
    bool isOperator = msg.sender == feeSweepOperator;
    if (!isOperator && msg.sender != info.creator) revert NotFeeSweepOperator();
    if (!isOperator && _requiresTrustedOperator(poolId, info)) revert InternalSwapRequiresOperator();

    // تبدیل کارمزدهای میم‌کوین به دارایی پایه
    (uint256 convertedFeeQuote, uint256 convertedTaxQuote, uint256 convertedBuybackQuote, bool converted) =
        _convertPendingMemecoin(poolId, info, minConversionQuoteOut);
    
    uint256 conversionQuoteOut = convertedFeeQuote + convertedTaxQuote;
    if (converted && conversionQuoteOut < minConversionQuoteOut) {
        revert SlippageExceeded(conversionQuoteOut, minConversionQuoteOut);
    }

    // جمع‌آوری و توزیع
    uint256 totalQuote = pendingFees[poolId][info.quoteToken] + convertedFeeQuote;
    uint256 taxQuote = pendingCreatorTax[poolId][info.quoteToken] + convertedTaxQuote;
    uint256 buybackQuote = pendingBuyback[poolId][info.quoteToken] + convertedBuybackQuote;
    if (totalQuote == 0 && taxQuote == 0) return;
    
    pendingFees[poolId][info.quoteToken] = 0;
    pendingCreatorTax[poolId][info.quoteToken] = 0;
    pendingBuyback[poolId][info.quoteToken] = 0;

    _distribute(poolId, info, totalQuote, taxQuote, buybackQuote, minBuybackTokensOut);
}
```

### ۲.۴ تبدیل کارمزدهای میم‌کوین (_convertPendingMemecoin)

```solidity
function _convertPendingMemecoin(PoolId poolId, LaunchInfo memory info, uint256 minConversionQuoteOut)
    private returns (uint256 feeQuoteOut, uint256 taxQuoteOut, uint256 buybackQuoteOut, bool converted)
{
    uint256 feePending = pendingFees[poolId][info.memecoin];
    uint256 taxPending = pendingCreatorTax[poolId][info.memecoin];
    uint256 buybackPending = pendingBuyback[poolId][info.memecoin];
    uint256 totalPending = feePending + taxPending;
    if (totalPending == 0) return (0, 0, 0, false);
    if (minConversionQuoteOut == 0) revert MinimumOutputRequired();

    // صفر کردن موقت
    pendingFees[poolId][info.memecoin] = 0;
    pendingCreatorTax[poolId][info.memecoin] = 0;
    pendingBuyback[poolId][info.memecoin] = 0;
    
    // اجرای سواپ داخلی
    (uint256 consumed, uint256 quoteOut) = _executeInternalSwap(poolId, SwapDirection.MemecoinToQuote, totalPending);
    
    if (consumed == 0) {
        // بازگرداندن در صورت عدم موفقیت
        pendingFees[poolId][info.memecoin] += feePending;
        pendingCreatorTax[poolId][info.memecoin] += taxPending;
        pendingBuyback[poolId][info.memecoin] += buybackPending;
        return (0, 0, 0, false);
    }
    converted = true;

    // تخصیص متناسب
    uint256 feeConsumed = FullMath.mulDiv(consumed, feePending, totalPending);
    uint256 taxConsumed = consumed - feeConsumed;
    feeQuoteOut = FullMath.mulDiv(quoteOut, feeConsumed, consumed);
    taxQuoteOut = quoteOut - feeQuoteOut;

    // تخصیص بازخرید
    if (buybackPending != 0) {
        uint256 buybackConsumed = FullMath.mulDiv(buybackPending, feeConsumed, feePending);
        buybackQuoteOut = feeConsumed == 0 ? 0 : FullMath.mulDiv(feeQuoteOut, buybackConsumed, feeConsumed);
        pendingBuyback[poolId][info.memecoin] += buybackPending - buybackConsumed;
    }

    pendingFees[poolId][info.memecoin] += feePending - feeConsumed;
    pendingCreatorTax[poolId][info.memecoin] += taxPending - taxConsumed;
}
```

### ۲.۵ توزیع نهایی (_distribute)

```solidity
function _distribute(
    PoolId poolId, LaunchInfo memory info,
    uint256 totalQuote, uint256 taxQuote, uint256 buybackQuote, uint256 minBuybackTokensOut
) private {
    uint256 protocolAmount = (totalQuote * info.protocolFeeShareBps) / BASIS_POINTS;
    uint256 creatorBucket = totalQuote - protocolAmount;
    uint256 requestedBuyback = buybackQuote < creatorBucket ? buybackQuote : creatorBucket;
    uint256 creatorAmount = creatorBucket - requestedBuyback + taxQuote;

    uint256 buybackSpent;
    uint256 tokensLocked;
    if (requestedBuyback != 0) {
        if (minBuybackTokensOut == 0) revert MinimumOutputRequired();
        (buybackSpent, tokensLocked) = _executeInternalSwap(poolId, SwapDirection.QuoteToMemecoin, requestedBuyback);
        creatorAmount += requestedBuyback - buybackSpent;
        if (tokensLocked != 0) {
            IERC20(info.memecoin).forceApprove(address(buybackVault), tokensLocked);
            buybackVault.lock(info.memecoin, tokensLocked, info.buybackCreatorRecipient,
                info.protocolFeeRecipient, info.protocolFeeShareBps);
            if (tokensLocked < minBuybackTokensOut) {
                revert SlippageExceeded(tokensLocked, minBuybackTokensOut);
            }
        } else if (buybackSpent == 0) {
            emit PoolBuybackSkipped(poolId, requestedBuyback);
        } else {
            revert SlippageExceeded(0, minBuybackTokensOut);
        }
    }

    _payOut(info.creator, info.quoteToken, creatorAmount);
    _payOut(info.protocolFeeRecipient, info.quoteToken, protocolAmount);
}
```

### ۲.۶ پرداخت نهایی با بررسی دقیق (_payOut)

```solidity
function _payOut(address recipient, address quoteToken, uint256 amount) private {
    if (amount == 0) return;
    if (quoteToken == address(0)) {
        feeEscrow.credit{value: amount}(recipient);
    } else {
        uint256 balanceBefore = IERC20(quoteToken).balanceOf(address(feeEscrow));
        IERC20(quoteToken).forceApprove(address(feeEscrow), amount);
        feeEscrow.creditToken(recipient, quoteToken, amount);
        uint256 received = IERC20(quoteToken).balanceOf(address(feeEscrow)) - balanceBefore;
        if (received != amount) revert InexactQuoteTransfer(quoteToken, amount, received);
    }
}
```

**نکته امنیتی مهم:** هوک میم برخلاف منحنی باندینگ، مقدار واقعی دریافتی را بررسی می‌کند (`received != amount`). این یعنی هوک در برابر توکن‌های کارمزدی مقاوم است ولی اگر توکن کارمزدی باشد، `sweepPoolFees` برای همیشه revert می‌کند و `rescuePoolFees` تنها راه نجات است.

---

## ۳. مسیر کامل تغییر دریافت‌کننده کارمزد سازنده در فکتوری

### ۳.۱ انتقال توسط خود سازنده (فوری)

```solidity
function transferCreatorFeeRecipient(address token, address newRecipient) external {
    LaunchedToken storage launch = _launchedTokens[token];
    if (!launch.exists) revert TokenNotFound();
    if (msg.sender != launch.creatorFeeRecipient) revert NotCreatorFeeRecipient();
    _setCreatorFeeRecipient(token, launch, newRecipient);
}
```

### ۳.۲ پیشنهاد توسط مالک (با تأخیر زمانی ۳ روزه)

```solidity
function setCreatorFeeRecipient(address token, address newRecipient) external onlyOwner {
    LaunchedToken storage launch = _launchedTokens[token];
    if (!launch.exists) revert TokenNotFound();
    if (newRecipient == address(0)) revert ZeroAddress();

    uint256 effectiveAt = block.timestamp + CREATOR_FEE_RECIPIENT_TIMELOCK; // 3 روز
    uint256 expiresAt = effectiveAt + CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW; // 3 روز دیگر
    pendingCreatorFeeRecipient[token] = PendingCreatorFeeRecipient({
        newRecipient: newRecipient, 
        effectiveAt: effectiveAt, 
        expiresAt: expiresAt
    });

    emit CreatorFeeRecipientChangeProposed(token, launch.creatorFeeRecipient, newRecipient, effectiveAt, expiresAt);
}
```

### ۳.۳ اجرای پیشنهاد (بعد از تأخیر زمانی، هر کسی)

```solidity
function executeCreatorFeeRecipientChange(address token) external {
    PendingCreatorFeeRecipient memory pending = pendingCreatorFeeRecipient[token];
    if (pending.newRecipient == address(0)) revert NoPendingChange();
    if (block.timestamp < pending.effectiveAt) revert TimelockNotElapsed(pending.effectiveAt);
    if (block.timestamp > pending.expiresAt) revert TimelockExpired(pending.expiresAt);

    LaunchedToken storage launch = _launchedTokens[token];
    delete pendingCreatorFeeRecipient[token];
    _setCreatorFeeRecipient(token, launch, pending.newRecipient);
}
```

### ۳.۴ لغو پیشنهاد (فقط مالک)

```solidity
function cancelCreatorFeeRecipientChange(address token) external onlyOwner {
    if (!_cancelPendingCreatorFeeRecipientChange(token)) revert NoPendingChange();
}
```

### ۳.۵ اجرای داخلی تغییر

```solidity
function _setCreatorFeeRecipient(address token, LaunchedToken storage launch, address newRecipient) private {
    if (newRecipient == address(0)) revert ZeroAddress();

    address previousRecipient = launch.creatorFeeRecipient;
    launch.creatorFeeRecipient = newRecipient;

    // ارسال به قرارداد مربوطه
    if (launch.phase == GraduationPhase.PoolCreated) {
        memeHook.setCreatorFeeRecipient(_poolIdFor(token, launch), newRecipient);
    } else {
        BondingCurve(launch.curve).setCreatorFeeRecipient(newRecipient);
    }

    // به‌روزرسانی دریافت‌کننده بازخرید
    buybackVault.updateCreatorRecipient(token, newRecipient);

    emit CreatorFeeRecipientUpdated(token, previousRecipient, newRecipient);
}
```

---

## نکات امنیتی کلیدی از این بخش‌ها

### ۱. هوک میم مقدار واقعی دریافتی را بررسی می‌کند
```solidity
uint256 received = IERC20(quoteToken).balanceOf(address(feeEscrow)) - balanceBefore;
if (received != amount) revert InexactQuoteTransfer(quoteToken, amount, received);
```
این یعنی توکن‌های کارمزدی باعث revert دائمی در `sweepPoolFees` می‌شوند.

### ۲. سازنده نمی‌تواند پیشنهاد مالک را لغو کند
فقط خود مالک می‌تواند `cancelCreatorFeeRecipientChange` صدا بزند. سازنده فقط می‌تواند `transferCreatorFeeRecipient` بزند ولی پیشنهاد مالک همچنان فعال می‌ماند.

### ۳. بازخرید از سواپ داخلی استفاده می‌کند
`_executeInternalSwap` با باز کردن قفل مدیر استخر اجرا می‌شود. سقف نوسان قیمت با `maxInternalPriceImpactBps` کنترل می‌شود ولی این سقف slippage است نه محافظت در برابر حمله ساندویچی.

### ۴. تبدیل متناسب کارمزدها
وقتی سواپ داخلی فقط بخشی از کارمزدها را تبدیل می‌کند، نسبت تبدیل به صورت متناسب بین سه سطل (کارمزد، مالیات، بازخرید) تقسیم می‌شود.