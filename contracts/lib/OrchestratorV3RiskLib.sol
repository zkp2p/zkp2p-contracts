// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "../interfaces/IEscrow.sol";
import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";

/**
 * @title OrchestratorV3RiskLib
 * @notice Executes V3 risk-hook selection, admission, and compact intent reads.
 * @dev The linked library keeps the V3 implementation below the EIP-170 runtime-size limit while
 *      preserving OrchestratorV3 as the storage, authorization, and event-emitting context.
 */
library OrchestratorV3RiskLib {
    event DepositRiskHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);

    error ZeroAddress();
    error InvalidContract(address account);
    error InvalidRiskHook(address hook);
    error UnauthorizedCallerOrDelegate(address caller, address depositor, address delegate);

    /** @notice Updates the risk hook used by future intents for one depositor-controlled deposit. */
    function setDepositRiskHook(
        mapping(address => mapping(uint256 => IIntentRiskHook)) storage _depositRiskHooks,
        address _escrow,
        uint256 _depositId,
        IIntentRiskHook _hook
    ) external {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_escrow.code.length == 0) revert InvalidContract(_escrow);

        address hookAddress = address(_hook);
        if (hookAddress != address(0) && hookAddress.code.length == 0) {
            revert InvalidRiskHook(hookAddress);
        }

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        bool isDepositorOrDelegate = msg.sender == deposit.depositor
            || (deposit.delegate != address(0) && msg.sender == deposit.delegate);
        if (!isDepositorOrDelegate) {
            revert UnauthorizedCallerOrDelegate(msg.sender, deposit.depositor, deposit.delegate);
        }

        _depositRiskHooks[_escrow][_depositId] = _hook;
        emit DepositRiskHookSet(_escrow, _depositId, hookAddress, msg.sender);
    }

    /** @notice Returns the scalar intent fields used by the snapshotted risk hook. */
    function getRiskIntent(
        mapping(bytes32 => IOrchestratorV2.Intent) storage _intents,
        bytes32 _intentHash
    ) external view returns (IOrchestratorV3.RiskIntentData memory riskIntent) {
        IOrchestratorV2.Intent storage intent = _intents[_intentHash];
        riskIntent = IOrchestratorV3.RiskIntentData({
            owner: intent.owner,
            to: intent.to,
            escrow: intent.escrow,
            depositId: intent.depositId,
            amount: intent.amount,
            paymentMethod: intent.paymentMethod,
            createdAt: uint64(intent.timestamp)
        });
    }
}
