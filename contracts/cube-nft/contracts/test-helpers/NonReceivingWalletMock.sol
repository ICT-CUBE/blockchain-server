// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A plain contract with no `onERC721Received` implementation, used only in tests to prove
/// that `authorizedTransfer`'s use of `_safeTransfer` rejects transfers to non-receiving contracts
/// exactly like standard ERC-721 `safeTransferFrom` would. Not part of the deployed system.
contract NonReceivingWalletMock {}
