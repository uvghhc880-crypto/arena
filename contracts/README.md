# Contract Source Code

All platform-specific names have been anonymized.

## Main Contracts

1. **LaunchFactory.sol** - Main factory for launching tokens with bonding curves. Handles launch, graduation, fee management, creator fee recipient changes.

2. **BondingCurve.sol** - Constant-product bonding curve for one launch. Handles buy/sell, fee sweeps, graduation, snipe tax.

3. **MemeHook.sol** - Singleton Uniswap V4 hook shared by all graduated pools. Handles post-swap fees, internal swaps for buyback.

4. **BuybackVault.sol** - Holds bought-back memecoin supply and releases linearly over 5 years.

5. **LaunchDeployer.sol** - Deploys bonding curve and token pairs using CREATE2.

6. **GraduationGuard.sol** - Library that guards graduation by ensuring pool parameters are correct.

7. **GraduationExecutor.sol** - Executes graduation from bonding curve to Uniswap V4 pool.

8. **GraduationMath.sol** - Library for calculating sqrtPriceX96 and tick for graduation.

9. **LauncherToken.sol** - ERC-20 memecoin with mutable metadata (logo, description, socials).

10. **LaunchLocker.sol** - Locks V4 position NFTs for graduated pools.

11. **Interfaces.sol** - Interface definitions for FeePolicy, FeeEscrow, BuybackVault, SnipeTax, and BondingCurveMath.

12. **FeeEscrow.sol** - Escrows native ETH and ERC-20 token fees for recipients.

## Source Verification

All source code extracted from the verified contract on Blockscout. Platform names replaced with generic names.