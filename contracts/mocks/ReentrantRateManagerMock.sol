// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IRateManager } from "../interfaces/IRateManager.sol";
import { IEscrowV2 } from "../interfaces/IEscrowV2.sol";

/**
 * @notice Rate manager mock that attempts to reenter setRateManager during onDepositOptIn.
 *         Used to verify CEI ordering protects against reentrancy.
 */
contract ReentrantRateManagerMock is IRateManager {
    address public escrow;
    bytes32 public attackRateManagerId;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address _escrow) {
        escrow = _escrow;
    }

    function setAttackParams(bytes32 _attackRateManagerId) external {
        attackRateManagerId = _attackRateManagerId;
    }

    function onDepositOptIn(uint256 _depositId, bytes32 /*_rateManagerId*/) external override {
        reentryAttempted = true;

        try IEscrowV2(escrow).setRateManager(_depositId, address(this), attackRateManagerId) {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }

    function getRate(bytes32, address, uint256, bytes32, bytes32) external pure override returns (uint256) {
        return 0;
    }

    function getFee(bytes32) external pure override returns (address, uint256) {
        return (address(0), 0);
    }

    function isRateManager(bytes32) external pure override returns (bool) {
        return true;
    }
}
