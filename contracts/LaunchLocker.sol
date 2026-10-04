// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// NOTE: Platform-specific names anonymized. Source from verified on-chain contract.

/// @title LaunchLocker
/// @notice Locks V4 position NFTs for graduated pools
contract LaunchLocker {
    address public immutable positionManager;
    address public factory;

    mapping(uint256 => bool) public lockedPositions;

    event PositionLocked(uint256 indexed tokenId, address indexed poolId);
    event PositionUnlocked(uint256 indexed tokenId);

    constructor(address positionManager_, address factory_) {
        positionManager = positionManager_;
        factory = factory_;
    }

    /// @notice Lock a position NFT (onlyFactory)
    function lockPosition(uint256 tokenId) external {
        // Only factory can call
        // Transfers NFT from caller to this contract
        // ... implementation
    }

    /// @notice Unlock a position NFT (onlyFactory)
    function unlockPosition(uint256 tokenId, address recipient) external {
        // Only factory can call
        // Transfers NFT back to recipient
        // ... implementation
    }

    /// @notice Check if a position is locked
    function isLocked(uint256 tokenId) external view returns (bool) {
        return lockedPositions[tokenId];
    }
}
