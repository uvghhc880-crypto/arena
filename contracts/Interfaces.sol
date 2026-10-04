// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// NOTE: Platform-specific names anonymized. Source from verified on-chain contract.

// ============================================================
// ILaunchpadV2 - Main interfaces
// ============================================================

interface IFeePolicy {
    function feeSweepOperator() external view returns (address);
    function currentFeePolicy() external view returns (FeePolicySnapshot memory);
}

interface IFeeEscrow {
    function credit(address recipient) external payable;
    function creditToken(address recipient, address token, uint256 amount) external;
}

interface IBuybackVault {
    function lock(
        address token,
        uint256 amount,
        address creatorRecipient,
        address protocolFeeRecipient,
        uint16 protocolFeeShareBps
    ) external;
}

interface ISnipeTax {
    function snipeTaxStartBps() external view returns (uint256);
    function snipeTaxSeconds() external view returns (uint256);
}

interface ILaunchFactoryGraduation {
    function graduate(address token) external;
}

struct FeePolicySnapshot {
    address protocolFeeRecipient;
    uint16 protocolFeeShareBps;
    uint16 buybackBurnBps;
    uint16 hookFeeBps;
    uint16 maxInternalPriceImpactBps;
}

// ============================================================
// BondingCurveMath library interface
// ============================================================

library BondingCurveMath {
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 offset)
        internal
        pure
        returns (uint256)
    {
        // Constant-product formula: (amountIn * reserveOut) / (reserveIn + offset + amountIn)
        // ... implementation
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut, uint256 offset)
        internal
        pure
        returns (uint256)
    {
        // ... implementation
    }

    function quoteAmountOut(uint256 quoteIn, uint256 quoteReserve, uint256 tokenReserve, uint256 phantomQuote)
        internal
        pure
        returns (uint256)
    {
        // ... implementation
    }
