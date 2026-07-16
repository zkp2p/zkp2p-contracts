// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IReferralFee } from "../interfaces/IReferralFee.sol";

/**
 * @title OrchestratorV3FeeLib
 * @notice Snapshots and consumes immutable per-intent fee terms for OrchestratorV3.
 * @dev Keeping fee execution in a linked library leaves OrchestratorV3 below the EIP-170 code-size
 *      limit while preserving the exact fee distribution behavior inherited from OrchestratorV2.
 */
library OrchestratorV3FeeLib {
    using SafeERC20 for IERC20;

    uint256 internal constant PRECISE_UNIT = 1e18;

    struct IntentFeeSnapshot {
        address protocolFeeRecipient;
        uint256 protocolFeeRate;
        uint256 totalFeeRate;
    }

    event IntentProtocolFeeSnapshotted(
        bytes32 indexed intentHash,
        address indexed feeRecipient,
        uint256 feeRate
    );
    event IntentReferralFeeDistributed(
        bytes32 indexed intentHash,
        address indexed feeRecipient,
        uint256 feeAmount
    );

    /** @notice Snapshots all fee terms needed to prove deferred-payout feasibility. */
    function snapshotIntentFees(
        mapping(bytes32 => IntentFeeSnapshot) storage _feeSnapshots,
        mapping(bytes32 => IOrchestratorV2.Intent) storage _intents,
        mapping(bytes32 => address) storage _managerFeeRecipients,
        mapping(bytes32 => uint256) storage _managerFees,
        bytes32 _intentHash,
        address _protocolFeeRecipient,
        uint256 _protocolFee
    ) external {
        IOrchestratorV2.Intent storage intent = _intents[_intentHash];
        uint256 totalFeeRate;
        if (_protocolFeeRecipient != address(0)) totalFeeRate = _protocolFee;
        if (_managerFeeRecipients[_intentHash] != address(0)) {
            totalFeeRate += _managerFees[_intentHash];
        }
        for (uint256 feeIndex = 0; feeIndex < intent.referralFees.length; feeIndex++) {
            totalFeeRate += intent.referralFees[feeIndex].fee;
        }
        _feeSnapshots[_intentHash] = IntentFeeSnapshot({
            protocolFeeRecipient: _protocolFeeRecipient,
            protocolFeeRate: _protocolFee,
            totalFeeRate: totalFeeRate
        });
        emit IntentProtocolFeeSnapshotted(_intentHash, _protocolFeeRecipient, _protocolFee);
    }

    /** @notice Consumes snapshotted protocol terms and distributes every intent fee. */
    function calculateAndTransferFees(
        mapping(bytes32 => IntentFeeSnapshot) storage _feeSnapshots,
        IERC20 _token,
        bytes32 _intentHash,
        IOrchestratorV2.Intent memory _intent,
        uint256 _releaseAmount,
        address _managerFeeRecipient,
        uint256 _managerFee
    ) external returns (uint256 netFees) {
        IntentFeeSnapshot memory feeSnapshot = _feeSnapshots[_intentHash];
        delete _feeSnapshots[_intentHash];

        if (feeSnapshot.protocolFeeRecipient != address(0) && feeSnapshot.protocolFeeRate > 0) {
            uint256 feeAmount = (_releaseAmount * feeSnapshot.protocolFeeRate) / PRECISE_UNIT;
            netFees = feeAmount;
            _token.safeTransfer(feeSnapshot.protocolFeeRecipient, feeAmount);
        }
        for (uint256 feeIndex = 0; feeIndex < _intent.referralFees.length; feeIndex++) {
            IReferralFee.ReferralFee memory referralFee = _intent.referralFees[feeIndex];
            uint256 feeAmount = (_releaseAmount * referralFee.fee) / PRECISE_UNIT;
            netFees += feeAmount;
            _token.safeTransfer(referralFee.recipient, feeAmount);
            emit IntentReferralFeeDistributed(_intentHash, referralFee.recipient, feeAmount);
        }
        if (_managerFeeRecipient != address(0) && _managerFee > 0) {
            uint256 feeAmount = (_releaseAmount * _managerFee) / PRECISE_UNIT;
            netFees += feeAmount;
            _token.safeTransfer(_managerFeeRecipient, feeAmount);
        }
    }
}
