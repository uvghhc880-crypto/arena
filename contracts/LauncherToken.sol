// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// NOTE: Platform-specific names anonymized. Source from verified on-chain contract.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title LauncherToken
/// @notice A memecoin deployed as an ERC-20 whose total supply is pre-minted
/// to the bonding curve and whose owner can store mutable metadata on-chain.
contract LauncherToken is ERC20, Ownable2Step {
    string public logo;
    string public description;
    string public twitter;
    string public telegram;
    string public discord;
    string public website;
    string public farcaster;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory logo_,
        string memory description_,
        string memory twitter_,
        string memory telegram_,
        string memory discord_,
        string memory website_,
        string memory farcaster_,
        address curve
    ) ERC20(name_, symbol_) Ownable2Step(msg.sender) {
        // Reverts on zero-supply launches
        _mint(curve, 1_000_000_000 * 10 ** decimals());
        logo = logo_;
        description = description_;
        twitter = twitter_;
        telegram = telegram_;
        discord = discord_;
        website = website_;
        farcaster = farcaster_;
    }

    /// @notice Replace the stored logo URI
    function setLogo(string calldata newLogo) external onlyOwner {
        logo = newLogo;
    }

    /// @notice Replace the stored description
    function setDescription(string calldata newDescription) external onlyOwner {
        description = newDescription;
    }

    /// @notice Replace the stored social links
    function setSocials(
        string calldata newTwitter,
        string calldata newTelegram,
        string calldata newDiscord,
        string calldata newWebsite,
        string calldata newFarcaster
    ) external onlyOwner {
        twitter = newTwitter;
        telegram = newTelegram;
        discord = newDiscord;
        website = newWebsite;
        farcaster = newFarcaster;
    }

    /// @notice ERC-20 does not have a `renounceOwnership` hook
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    error OwnershipCannotBeRenounced();
}
