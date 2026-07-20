// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { ISettlementHook } from "./ISettlementHook.sol";

/**
 * @title IDeferredPayoutHook
 * @notice RETIRED historical post-intent adapter retained for immutable deployment reproduction.
 */
interface IDeferredPayoutHook is ISettlementHook {
    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroAmount();
    error InvalidContract(address account);
    error UnauthorizedOrchestrator(address caller);
    error InvalidPayoutToken(address expected, address actual);
    error RiskManagerStakeVaultMismatch(address expected, address actual);
    event PayoutDeferred(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        address indexed vault,
        uint256 deferredCoverage
    );
}
