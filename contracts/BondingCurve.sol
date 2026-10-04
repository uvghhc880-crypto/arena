// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// NOTE: Platform-specific imports and names have been anonymized.
// Original contract was verified on-chain.

/// @title BondingCurve
/// @notice Constant-product bonding curve for one launch.
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BASIS_POINTS = 10_000;
    uint256 private constant MAX_TOTAL_TRADE_FEE_BPS = 2_000; // 20%

    error CurveGraduated();
    error ZeroAmount();
    error ZeroAddress();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error NotFactory();
    error TransferFailed();
    error AlreadyGraduated();
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidLaunchEconomics();
    error NotReadyToGraduate();
    error NotFeeSweepOperator();
    error InternalSwapRequiresOperator();
    error InvalidFeePolicy();
    error MinimumOutputRequired();
    error NativeValueMismatch(uint256 supplied, uint256 expected);
    error UnexpectedNativeValue();

    event CurveBuy(
        address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax
    );
    event CurveBuyRefunded(address indexed buyer, uint256 refund);
    event CurveSell(
        address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax
    );
    event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount);
    event FeesRescued(
        address indexed protocolRecipient,
        address indexed creatorRecipient,
        uint256 protocolAmount,
        uint256 creatorAmount
    );
    event BuybackLocked(uint256 quoteSpent, uint256 tokensLocked);
    event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut);
    event Initialized(address token);
    event CreatorFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event BuybackEnabledUpdated(bool enabled);
    event AutoGraduationFailed(address indexed token, uint256 gasRemaining);
    event SnipeTaxExempted(address indexed account);
    event SnipeTaxCharged(address indexed recipient, uint256 amount);

    // State variables
    address public token;
    address public immutable pairToken;
    address public deployer;
    address public immutable factory;
    IFeePolicy public immutable feePolicy;
    IFeeEscrow public immutable feeEscrow;
    IBuybackVault public immutable buybackVault;
    address public immutable protocolFeeRecipient;
    address public immutable buybackCreatorRecipient;
    uint16 public immutable protocolFeeShareBps;
    uint16 public immutable buybackBurnBps;
    uint16 public immutable maxInternalPriceImpactBps;
    uint256 public immutable phantomQuote;
    uint256 public immutable feeBps;
    uint256 public immutable creatorTaxBps;
    uint256 public immutable graduationThreshold;
    bool public buybackEnabled;

    uint256 public quoteFeeBalance;
    uint256 public buybackQuoteBalance;
    uint256 public creatorTaxBalance;
    uint256 public trackedQuote;
    uint256 public trackedTokens;
    bool public graduated;
    uint256 public reservedTokens;
    uint256 public launchSupply;
    uint256 public launchedAt;
    uint256 public snipeTaxStartBps;
    uint256 public snipeTaxSeconds;
    mapping(address account => bool exempt) public snipeTaxExempt;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    modifier onlyInitialized() {
        if (token == address(0)) revert NotInitialized();
        _;
    }

    constructor(
        address pairToken_,
        address deployer_,
        address factory_,
        IFeePolicy feePolicy_,
        FeePolicySnapshot memory policy_,
        IFeeEscrow feeEscrow_,
        IBuybackVault buybackVault_,
        uint256 phantomQuote_,
        uint256 feeBps_,
        uint256 creatorTaxBps_,
        bool buybackEnabled_,
        uint256 graduationThreshold_
    ) {
        // ... constructor logic ...
        pairToken = pairToken_;
        deployer = deployer_;
        factory = factory_;
        feePolicy = feePolicy_;
        feeEscrow = feeEscrow_;
        buybackVault = buybackVault_;
        protocolFeeRecipient = policy_.protocolFeeRecipient;
        buybackCreatorRecipient = deployer_;
        protocolFeeShareBps = policy_.protocolFeeShareBps;
        buybackBurnBps = policy_.buybackBurnBps;
        maxInternalPriceImpactBps = policy_.maxInternalPriceImpactBps;
        phantomQuote = phantomQuote_;
        feeBps = feeBps_;
        creatorTaxBps = creatorTaxBps_;
        buybackEnabled = buybackEnabled_;
        graduationThreshold = graduationThreshold_;
    }

    function isNativeQuote() public view returns (bool) {
        return pairToken == address(0);
    }

    function initialize(address token_) external onlyFactory {
        if (token != address(0)) revert AlreadyInitialized();
        if (token_ == address(0)) revert ZeroAddress();
        token = token_;

        uint256 supply = IERC20(token_).totalSupply();
        uint256 reserved = Math.mulDiv(supply, phantomQuote, phantomQuote + graduationThreshold);
        if (reserved == 0 || reserved >= supply) revert InvalidLaunchEconomics();
        reservedTokens = reserved;
        launchSupply = supply;
        launchedAt = block.timestamp;
        snipeTaxStartBps = ISnipeTax(factory).snipeTaxStartBps();
        snipeTaxSeconds = ISnipeTax(factory).snipeTaxSeconds();
        trackedTokens = IERC20(token_).balanceOf(address(this));

        emit Initialized(token_);
    }

    function sellableTokens() public view returns (uint256) {
        uint256 tracked = trackedTokens;
        return tracked > reservedTokens ? tracked - reservedTokens : 0;
    }

    function currentSnipeTaxBps(address recipient) public view returns (uint256) {
        if (snipeTaxExempt[recipient]) return 0;
        uint256 startBps = snipeTaxStartBps;
        if (startBps == 0) return 0;
        uint256 elapsed = block.timestamp - launchedAt;
        uint256 window = snipeTaxSeconds;
        if (elapsed >= window) return 0;
        return startBps >> ((elapsed * 14) / window);
    }

    function exemptFromSnipeTax(address account) external onlyFactory {
        snipeTaxExempt[account] = true;
        emit SnipeTaxExempted(account);
    }

    function setCreatorFeeRecipient(address newRecipient) external onlyFactory {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit CreatorFeeRecipientUpdated(deployer, newRecipient);
        deployer = newRecipient;
    }

    function setBuybackEnabled(bool enabled) external onlyFactory {
        buybackEnabled = enabled;
        emit BuybackEnabledUpdated(enabled);
    }

    function getReserves() public view returns (uint256 quoteReserve_, uint256 tokenReserve_) {
        quoteReserve_ = phantomQuote + trackedQuote - quoteFeeBalance - creatorTaxBalance;
        tokenReserve_ = trackedTokens;
    }

    function quoteReserve() external view returns (uint256 quoteReserve_) {
        (quoteReserve_,) = getReserves();
    }

    function realQuoteReserve() public view returns (uint256) {
        return trackedQuote - quoteFeeBalance - creatorTaxBalance;
    }

    function tokenReserve() external view returns (uint256 tokenReserve_) {
        (, tokenReserve_) = getReserves();
    }

    function readyToGraduate() public view returns (bool) {
        if (graduated) return false;
        return sellableTokens() == 0;
    }

    /// @notice Buy tokens from the curve
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        nonReentrant
        onlyInitialized
        returns (uint256 tokensOut)
    {
        if (graduated) revert CurveGraduated();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 received = _receiveQuote(quoteIn);
        if (received == 0) revert ZeroAmount();
        if (graduated) revert CurveGraduated();

        uint256 quoteReserveBefore = phantomQuote + trackedQuote - quoteFeeBalance - creatorTaxBalance;
        uint256 tokenReserveBefore = trackedTokens;

        uint256 snipeTaxBps = currentSnipeTaxBps(recipient);
        if (snipeTaxBps != 0) {
            uint256 maxSnipeTaxBps = BASIS_POINTS - feeBps - creatorTaxBps - 100;
            if (snipeTaxBps > maxSnipeTaxBps) snipeTaxBps = maxSnipeTaxBps;
        }

        uint256 spent = received;
        uint256 fee = (spent * feeBps) / BASIS_POINTS;
        uint256 tax = (spent * creatorTaxBps) / BASIS_POINTS;
        uint256 snipeTax = (spent * snipeTaxBps) / BASIS_POINTS;
        tokensOut = BondingCurveMath.getAmountOut(
            spent - fee - tax - snipeTax, quoteReserveBefore, tokenReserveBefore, 0
        );

        uint256 sellable = tokenReserveBefore > reservedTokens ? tokenReserveBefore - reservedTokens : 0;
        if (sellable == 0) revert CurveGraduated();

        if (tokensOut > sellable) {
            tokensOut = sellable;
            uint256 net = BondingCurveMath.getAmountIn(sellable, quoteReserveBefore, tokenReserveBefore, 0);
            spent = Math.min(
                Math.mulDiv(net, BASIS_POINTS, BASIS_POINTS - feeBps - creatorTaxBps - snipeTaxBps, Math.Rounding.Ceil),
                received
            );
            fee = (spent * feeBps) / BASIS_POINTS;
            tax = (spent * creatorTaxBps) / BASIS_POINTS;
            snipeTax = (spent * snipeTaxBps) / BASIS_POINTS;
        }

        if (spent * minTokensOut > received * tokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        _accrueFees(fee + snipeTax, tax);
        trackedQuote += spent;
        trackedTokens -= tokensOut;
        IERC20(token).safeTransfer(recipient, tokensOut);

        uint256 refund = received - spent;
        if (refund != 0) {
            emit CurveBuyRefunded(msg.sender, refund);
            _sendQuote(msg.sender, refund);
        }

        if (snipeTax != 0) emit SnipeTaxCharged(recipient, snipeTax);
        emit CurveBuy(msg.sender, recipient, spent, tokensOut, fee + snipeTax, tax);
        _tryAutoGraduate();
    }

    /// @notice Sell tokens back to the curve
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        nonReentrant
        onlyInitialized
        returns (uint256 quoteOut)
    {
        if (graduated || readyToGraduate()) revert CurveGraduated();
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        (uint256 quoteReserveBefore, uint256 tokenReserveBefore) = getReserves();
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 grossQuoteOut = BondingCurveMath.getAmountOut(tokensIn, tokenReserveBefore, quoteReserveBefore, 0);
        uint256 fee = (grossQuoteOut * feeBps) / BASIS_POINTS;
        uint256 tax = (grossQuoteOut * creatorTaxBps) / BASIS_POINTS;
        quoteOut = grossQuoteOut - fee - tax;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);

        _accrueFees(fee, tax);
        trackedQuote -= quoteOut;
        trackedTokens += tokensIn;
        _sendQuote(recipient, quoteOut);

        emit CurveSell(msg.sender, recipient, tokensIn, quoteOut, fee, tax);
    }

    /// @notice Sweep accumulated fees
    function sweepFees(uint256 minBuybackTokensOut) external nonReentrant {
        if (graduated) revert AlreadyGraduated();
        bool isOperator = msg.sender == feePolicy.feeSweepOperator();
        if (!isOperator && msg.sender != deployer) {
            revert NotFeeSweepOperator();
        }
        if (!isOperator && _requiresTrustedOperator()) revert InternalSwapRequiresOperator();
        _sweepFees(minBuybackTokensOut, true);
    }

    /// @notice Graduate to V4 pool
    function graduate(address recipient) external onlyFactory returns (uint256 quoteOut, uint256 tokenOut) {
        if (graduated) revert AlreadyGraduated();
        if (recipient == address(0)) revert ZeroAddress();
        if (!readyToGraduate()) revert NotReadyToGraduate();

        graduated = true;
        _sweepFees(0, false);

        quoteOut = trackedQuote;
        trackedQuote = 0;
        tokenOut = trackedTokens;
        trackedTokens = 0;

        if (quoteOut != 0) {
            _sendQuote(recipient, quoteOut);
        }
        if (tokenOut != 0) {
            IERC20(token).safeTransfer(recipient, tokenOut);
        }

        emit CurveCompleted(recipient, quoteOut, tokenOut);
    }

    /// @notice Rescue fees (onlyFactory)
    function rescueFees() external onlyFactory returns (uint256 protocolAmount, uint256 creatorAmount) {
        uint256 pending = quoteFeeBalance;
        uint256 tax = creatorTaxBalance;
        if (pending == 0 && tax == 0) revert ZeroAmount();

        protocolAmount = (pending * protocolFeeShareBps) / BASIS_POINTS;
        creatorAmount = pending - protocolAmount + tax;

        quoteFeeBalance = 0;
        buybackQuoteBalance = 0;
        creatorTaxBalance = 0;
        trackedQuote -= protocolAmount + creatorAmount;

        if (protocolAmount != 0) _sendQuote(protocolFeeRecipient, protocolAmount);
        if (creatorAmount != 0) _sendQuote(deployer, creatorAmount);  // NOTE: sends to deployer, not creatorFeeRecipient

        emit FeesRescued(protocolFeeRecipient, deployer, protocolAmount, creatorAmount);
    }

    // Internal functions
    function _receiveQuote(uint256 amount) private returns (uint256) {
        if (isNativeQuote()) {
            if (msg.value != amount) revert NativeValueMismatch(msg.value, amount);
            return amount;
        }
        if (msg.value != 0) revert UnexpectedNativeValue();
        IERC20 quote = IERC20(pairToken);
        uint256 balanceBefore = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), amount);
        return quote.balanceOf(address(this)) - balanceBefore;
    }

    function _sendQuote(address recipient, uint256 amount) private {
        if (isNativeQuote()) {
            (bool sent,) = payable(recipient).call{value: amount}("");
            if (!sent) revert TransferFailed();
            return;
        }
        IERC20(pairToken).safeTransfer(recipient, amount);
    }

    function _accrueFees(uint256 fee, uint256 tax) private {
        quoteFeeBalance += fee;
        creatorTaxBalance += tax;
        if (buybackEnabled && fee != 0) {
            uint256 creatorSlice = fee - (fee * protocolFeeShareBps) / BASIS_POINTS;
            buybackQuoteBalance += (creatorSlice * buybackBurnBps) / BASIS_POINTS;
        }
    }

    function _requiresTrustedOperator() private view returns (bool) {
        return buybackQuoteBalance != 0;
    }

    function _tryAutoGraduate() private {
        if (readyToGraduate()) {
            try ILaunchFactoryGraduation(factory).graduate(token) {
                // success
            } catch {
                emit AutoGraduationFailed(token, gasleft());
            }
        }
    }

    function _sweepFees(uint256 minBuybackTokensOut, bool executeBuyback) private {
        uint256 pending = quoteFeeBalance;
        uint256 tax = creatorTaxBalance;
        if (pending == 0 && tax == 0) return;

        uint256 protocolAmount = (pending * protocolFeeShareBps) / BASIS_POINTS;
        uint256 creatorBucket = pending - protocolAmount;
        uint256 buybackAmount = executeBuyback ? Math.min(buybackQuoteBalance, creatorBucket) : 0;
        uint256 creatorAmount = creatorBucket - buybackAmount + tax;

        uint256 tokensLocked;
        if (buybackAmount != 0) {
            if (minBuybackTokensOut == 0) revert MinimumOutputRequired();
            (uint256 quoteReserve_, uint256 tokenReserve_) = getReserves();
            uint256 reserveMovementBps = (buybackAmount * BASIS_POINTS) / (quoteReserve_ + buybackAmount);
            if (reserveMovementBps <= maxInternalPriceImpactBps) {
                uint256 tokensOut =
                    BondingCurveMath.quoteAmountOut(buybackAmount, quoteReserve_, tokenReserve_, 0);
                if (tokensOut != 0 && tokensOut <= sellableTokens()) {
                    tokensLocked = tokensOut;
                }
            }
            if (tokensLocked == 0) {
                creatorAmount += buybackAmount;
                buybackAmount = 0;
            } else if (tokensLocked < minBuybackTokensOut) {
                revert SlippageExceeded(tokensLocked, minBuybackTokensOut);
            }
        }

        quoteFeeBalance = 0;
        buybackQuoteBalance = 0;
        creatorTaxBalance = 0;
        trackedQuote -= protocolAmount + creatorAmount;

        if (tokensLocked != 0) {
            trackedTokens -= tokensLocked;
            IERC20(token).forceApprove(address(buybackVault), tokensLocked);
            buybackVault.lock(token, tokensLocked, buybackCreatorRecipient, protocolFeeRecipient, protocolFeeShareBps);
            emit BuybackLocked(buybackAmount, tokensLocked);
        }
        if (protocolAmount != 0) {
            _creditQuote(protocolFeeRecipient, protocolAmount);
        }
        if (creatorAmount != 0) {
            _creditQuote(deployer, creatorAmount);
        }

        emit FeesSwept(protocolAmount, buybackAmount, creatorAmount);
    }

    function _creditQuote(address recipient, uint256 amount) private {
        if (isNativeQuote()) {
            feeEscrow.credit{value: amount}(recipient);
            return;
        }
        IERC20(pairToken).forceApprove(address(feeEscrow), amount);
        feeEscrow.creditToken(recipient, pairToken, amount);
    }

    receive() external payable {}
}
