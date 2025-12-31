// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/**
 * @title RejectEtherMock
 * @notice Mock contract that rejects native token transfers (no receive/fallback).
 * @dev Used to test failure paths when sending ETH to contracts that can't receive it.
 */
contract RejectEtherMock {
    // No receive() or fallback() - will reject any native transfers
}
