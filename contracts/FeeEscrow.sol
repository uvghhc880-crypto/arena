// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// NOTE: Platform-specific names anonymized. Source from verified on-chain contract.

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeEscrow
/// @notice Escrows native ETH and ERC-20 token fees for recipients.
contract FeeEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance(address recipient, uint256 requested, uint256 available);
    error TransferFailed();

    event FeeCredited(address indexed recipient, address indexed token, uint256 amount);
    event FeeWithdrawn(address indexed recipient, address indexed token, uint256 amount);

    mapping(address => uint256) public nativeCredits;
    mapping(address => mapping(address => uint256)) public tokenCredits;

    /// @notice Credit native ETH to a recipient
    function credit(address recipient) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        nativeCredits[recipient] += msg.value;
        emit FeeCredited(recipient, address(0), msg.value);
    }

    /// @notice Credit ERC-20 tokens to a recipient
    function creditToken(address recipient, address token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        tokenCredits[recipient][token] += amount;
        emit FeeCredited(recipient, token, amount);
    }

    /// @notice Withdraw native ETH
    function withdraw() external nonReentrant {
        uint256 amount = nativeCredits[msg.sender];
        if (amount == 0) revert ZeroAmount();
        nativeCredits[msg.sender] = 0;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit FeeWithdrawn(msg.sender, address(0), amount);
    }

    /// @notice Withdraw ERC-20 tokens
    function withdrawToken(address token) external nonReentrant {
        uint256 amount = tokenCredits[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        tokenCredits[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit FeeWithdrawn(msg.sender, token, amount);
    }

    receive() external payable {}
}
