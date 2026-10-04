// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// NOTE: Platform-specific names anonymized. Source from verified on-chain contract.

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title LaunchFactory
/// @notice Main factory for launching tokens with bonding curves
contract LaunchFactory is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BASIS_POINTS = 10_000;
    uint256 private constant MAX_CREATOR_TAX_CEILING_BPS = 1_000; // 10%
    uint256 private constant MAX_SNIPE_TAX_START_BPS = 9_900;
    uint256 private constant MAX_SNIPE_TAX_SECONDS = 60;
    uint256 private constant CREATOR_FEE_RECIPIENT_TIMELOCK = 7 days;
    uint256 private constant CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW = 7 days;
    uint256 private constant GRADUATION_RESCUE_DELAY = 7 days;

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct LaunchConfig {
        uint256 supply;
        uint256 curveFeeBps;
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        bool enabled;
    }

    struct PairTokenEconomics {
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint8 decimals;
    }

    struct PendingCreatorFeeRecipient {
        address newRecipient;
        uint256 effectiveAt;
        uint256 expiresAt;
    }

    struct FeePolicySnapshot {
        address protocolFeeRecipient;
        uint16 protocolFeeShareBps;
        uint16 buybackBurnBps;
        uint16 hookFeeBps;
        uint16 maxInternalPriceImpactBps;
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase; // GraduationPhase enum
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    // Errors
    error InvalidLaunchConfigId();
    error LaunchConfigDisabled();
    error InvalidBasisPoints();
    error ExemptionListTooLong();
    error InvalidSnipeTaxWindow();
    error CurveFeeTooHigh();
    error CreatorTaxTooHigh();
    error CombinedFeeTooHigh();
    error SupplyTooLow();
    error InvalidTickSpacing();
    error LaunchFeeNotPaid();
    error NotWhitelisted();
    error FeeTransferFailed();
    error ZeroAddress();
    error AlreadySet();
    error OwnershipCannotBeRenounced();
    error InvalidTokenParams();
    error TokenNotFound();
    error WrongGraduationPhase();
    error GraduationStillViable();
    error NothingToGraduate();
    error SqrtPriceOutOfBounds();
    error GraduationExecutorNotSet();
    error LaunchDeployerNotSet();
    error NotLaunchForwarder();
    error NotCreatorFeeRecipient();
    error NoPendingChange();
    error TimelockNotElapsed(uint256 effectiveAt);
    error TimelockExpired(uint256 expiresAt);
    error LaunchDependenciesNotWired();
    error PairTokenNotApproved();
    error PairTokenValidationFailed();
    error NotBuybackController();
    error CoreLpFeeMustBeZero();
    error InvalidGraduationThreshold();
    error InvalidPhantomQuote();
    error CurveNotQuotable();
    error PairTokenEconomicsInvalid();
    error PairTokenDecimalsMismatch(uint8 expected, uint8 actual);
    error PairTokenDecimalsUnavailable();
    error LaunchEconomicsMismatch(bytes32 expected, bytes32 actual);
    error InexactTransfer(address token, uint256 expected, uint256 received);
    error GraduationSeedNotViable();
    error SupplyTooHigh();
    error GraduationRescueTooEarly(uint256 availableAt);

    // State variables
    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable permit2;
    address public immutable locker;
    address public immutable memeHook;
    address public immutable feeEscrow;
    address public immutable buybackVault;

    address public graduationExecutor;
    address public launchDeployer;
    address public launchForwarder;
    address public immutable graduationGuard;

    uint256 public maxCreatorTaxBps = 1_000; // 10%
    uint256 public snipeTaxStartBps = 9_900; // 99%
    uint256 public snipeTaxSeconds = 15;
    uint256 public launchFee;
    bool public launchEnabled;

    mapping(address => bool) public whitelistedLaunchers;
    mapping(address => bool) public approvedPairTokens;
    mapping(address => PairTokenEconomics) public pairTokenEconomics;
    mapping(address => FeePolicySnapshot) private _launchFeePolicies;
    mapping(address => LaunchedToken) private _launchedTokens;
    mapping(address => PendingCreatorFeeRecipient) public pendingCreatorFeeRecipient;
    LaunchConfig[] private _launchConfigs;

    // ============================================================
    // KEY FUNCTIONS
    // ============================================================

    /// @notice Launch a token with snipe tax exemptions
    function launchToken(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve) {
        // ... implementation
    }

    /// @notice Launch a token on behalf of another address
    function launchTokenFor(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address originalDeployer,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve) {
        // ... implementation
        // NOTE: originalDeployer is auto-exempted from snipe tax
    }

    /// @notice Graduate a token to V4 pool (permissionless)
    function graduate(address token) external nonReentrant {
        LaunchedToken storage launch = _launchedTokens[token];
        if (!launch.exists) revert TokenNotFound();
        if (launch.phase != 0) revert WrongGraduationPhase(); // NotGraduated
        // ... implementation
    }

    /// @notice Force sweep graduation (onlyOwner)
    function forceSweptGraduation(address token) external onlyOwner nonReentrant {
        // ... implementation
        // Only works when seed is NOT viable
    }

    /// @notice Rescue swept graduation (onlyOwner + timelock)
    function rescueSweptGraduation(address token, address recipient) external onlyOwner nonReentrant {
        // ... implementation
        // Requires GRADUATION_RESCUE_DELAY
        // Sends ALL swept reserves to recipient
    }

    /// @notice Rescue curve fees (onlyOwner)
    function rescueCurveFees(address token) external onlyOwner nonReentrant {
        // ... implementation
    }

    /// @notice Propose creator fee recipient change (onlyOwner + timelock)
    function setCreatorFeeRecipient(address token, address newRecipient) external onlyOwner {
        // ... implementation
        // Creator CANNOT cancel this
    }

    /// @notice Execute creator fee recipient change (permissionless after timelock)
    function executeCreatorFeeRecipientChange(address token) external {
        // ... implementation
    }

    /// @notice Transfer creator fee recipient (creator only, instant)
    function transferCreatorFeeRecipient(address token, address newRecipient) external {
        LaunchedToken storage launch = _launchedTokens[token];
        if (!launch.exists) revert TokenNotFound();
        if (msg.sender != launch.creatorFeeRecipient) revert NotCreatorFeeRecipient();
        // ... implementation
    }

    /// @notice Cancel pending creator fee recipient change (onlyOwner)
    function cancelCreatorFeeRecipientChange(address token) external onlyOwner {
        // ... implementation
    }

    /// @notice Enable/disable buyback (creator or owner)
    function setBuybackEnabled(address token, bool enabled) external {
        // ... implementation
        // Only creator can enable, owner can only disable
    }

    /// @notice Create graduated pool (permissionless)
    function createGraduatedPool(address token) external nonReentrant returns (uint256 positionId) {
        // ... implementation
    }

    // ============================================================
    // ADMIN FUNCTIONS
    // ============================================================

    function setLaunchEnabled(bool enabled) external onlyOwner { launchEnabled = enabled; }
    function setLaunchFee(uint256 newLaunchFee) external onlyOwner { launchFee = newLaunchFee; }
    function setMaxCreatorTaxBps(uint256 bps) external onlyOwner { maxCreatorTaxBps = bps; }
    function setSnipeTaxStartBps(uint256 bps) external onlyOwner { snipeTaxStartBps = bps; }
    function setSnipeTaxSeconds(uint256 secondsWindow) external onlyOwner { snipeTaxSeconds = secondsWindow; }
    function setLaunchForwarder(address forwarder) external onlyOwner { launchForwarder = forwarder; }
    function setPairTokenApproved(address pairToken, bool approved) external onlyOwner { /* ... */ }
    function setPairTokenEconomics(address pairToken, uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals) external onlyOwner { /* ... */ }
    function setWhitelistedLauncher(address launcher, bool enabled) external onlyOwner { /* ... */ }
    function addLaunchConfig(LaunchConfig calldata config) external onlyOwner returns (uint256 id) { /* ... */ }
    function updateLaunchConfig(uint256 id, LaunchConfig calldata config) external onlyOwner { /* ... */ }
    function setGraduationExecutor(address executor) external onlyOwner { /* ... */ }
    function setLaunchDeployer(address deployer) external onlyOwner { /* ... */ }

    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    function getLaunchedToken(address token) external view returns (LaunchedToken memory) { /* ... */ }
    function getLaunchConfig(uint256 id) external view returns (LaunchConfig memory) { /* ... */ }
    function getLaunchFeePolicy(address token) external view returns (FeePolicySnapshot memory) { /* ... */ }
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32) { /* ... */ }
    function canLaunch(address launcher) external view returns (bool) { /* ... */ }
    function launchConfigCount() external view returns (uint256) { /* ... */ }
    function pendingCreatorFeeRecipient(address token) external view returns (address, uint256, uint256) { /* ... */ }
}
