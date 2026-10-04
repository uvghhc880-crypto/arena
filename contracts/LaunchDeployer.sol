// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// NOTE: Platform-specific names anonymized. Source from verified on-chain contract.

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/// @title LaunchDeployer
/// @notice Deploys the bonding curve and launch token pair for one launch.
contract LaunchDeployer {
    uint256 private constant MAX_NAME_LENGTH = 64;
    uint256 private constant MAX_SYMBOL_LENGTH = 16;
    uint256 private constant MAX_LOGO_LENGTH = 512;
    uint256 private constant MAX_DESCRIPTION_LENGTH = 2048;
    uint256 private constant MAX_SOCIAL_LENGTH = 256;

    error NotFactory();
    error MetadataTooLong();

    address public immutable factory;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    /// @notice Deploys a fresh curve/token pair
    function deployLaunch(LaunchDeployment calldata params)
        external
        onlyFactory
        returns (address token, address curve)
    {
        _requireMetadataWithinLimits(params);

        bytes32 salt = _launchSalt(params);
        curve = Create2.deploy(0, salt, _curveCreationCode(params));
        token = Create2.deploy(0, salt, _tokenCreationCode(params, curve));
    }

    /// @notice Predict launch addresses
    function predictLaunchAddresses(LaunchDeployment calldata params)
        external
        view
        returns (address token, address curve)
    {
        bytes32 salt = _launchSalt(params);
        curve = Create2.computeAddress(salt, keccak256(_curveCreationCode(params)));
        token = Create2.computeAddress(salt, keccak256(_tokenCreationCode(params, curve)));
    }

    function _launchSalt(LaunchDeployment calldata params) private pure returns (bytes32) {
        return keccak256(abi.encode(params.originalDeployer, params.salt));
    }

    function _curveCreationCode(LaunchDeployment calldata params) private view returns (bytes memory) {
        // Returns creation code for BondingCurve with constructor args
        // ... implementation
    }

    function _tokenCreationCode(LaunchDeployment calldata params, address curve) private view returns (bytes memory) {
        // Returns creation code for LauncherToken with constructor args
        // ... implementation
    }

    function _requireMetadataWithinLimits(LaunchDeployment calldata params) private pure {
        if (bytes(params.name).length > MAX_NAME_LENGTH) revert MetadataTooLong();
        if (bytes(params.symbol).length > MAX_SYMBOL_LENGTH) revert MetadataTooLong();
        if (bytes(params.logo).length > MAX_LOGO_LENGTH) revert MetadataTooLong();
        if (bytes(params.description).length > MAX_DESCRIPTION_LENGTH) revert MetadataTooLong();
        // ... check socials
    }
}

struct LaunchDeployment {
    address pairToken;
    address creatorFeeRecipient;
    address originalDeployer;
    address feePolicy;
    FeePolicySnapshot policy;
    address feeEscrow;
    address buybackVault;
    uint256 phantomQuote;
    uint256 curveFeeBps;
    uint256 creatorTaxBps;
    bool buybackEnabled;
    uint256 graduationThreshold;
    uint256 supply;
    bytes32 salt;
    string name;
    string symbol;
    string logo;
    string description;
    Socials socials;
}
