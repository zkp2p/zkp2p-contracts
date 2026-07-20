// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IReferralFee } from "../interfaces/IReferralFee.sol";
import { PostIntentHookExecutor } from "./PostIntentHookExecutor.sol";
import { RiskSettlementExecutor } from "./RiskSettlementExecutor.sol";

/**
 * @title FeeSettlementLib
 * @notice Builds and executes the exact fee plan used by OrchestratorV3 settlement.
 * @dev Public library functions keep fee-plan machinery out of the size-constrained orchestrator runtime.
 */
library FeeSettlementLib {
    using SafeERC20 for IERC20;

    uint256 internal constant PRECISE_UNIT = 1e18;
    uint256 internal constant MAX_RISK_CALLBACK_RETURN_DATA = 2_048;

    event IntentReferralFeeDistributed(
        bytes32 indexed intentHash,
        address indexed recipient,
        uint256 amount
    );

    struct FeeConfig {
        address protocolFeeRecipient;
        uint256 protocolFee;
        address managerFeeRecipient;
        uint256 managerFee;
    }

    function executeSettlement(
        IERC20 _token,
        IIntentRiskHook _riskHook,
        bytes32 _intentHash,
        IOrchestratorV2.Intent memory _intent,
        uint256 _releaseAmount,
        bytes memory _postIntentHookData,
        FeeConfig memory _feeConfig,
        bool _isManualRelease,
        uint256 _riskCallbackGasLimit
    ) public returns (address fundsTransferredTo, uint256 netAmount) {
        (
            IIntentRiskHook.FeeAllocation[] memory feeAllocations,
            uint256 totalFees
        ) = _calculateFeeAllocations(_intent, _releaseAmount, _feeConfig);
        netAmount = _releaseAmount - totalFees;

        bool fundsConsumed = RiskSettlementExecutor.execute(
            _riskHook,
            _token,
            IIntentRiskHook.RiskSettlementContext({
                intentHash: _intentHash,
                token: address(_token),
                recipient: _intent.to,
                grossAmount: _releaseAmount,
                executableAmount: netAmount,
                isManualRelease: _isManualRelease,
                feeAllocations: feeAllocations
            }),
            _riskCallbackGasLimit,
            MAX_RISK_CALLBACK_RETURN_DATA
        );

        if (fundsConsumed) return (address(_riskHook), netAmount);

        _transferFeeAllocations(_token, _intentHash, feeAllocations);
        if (_isManualRelease) {
            PostIntentHookExecutor.transferTo(_token, _intent.to, netAmount);
            return (_intent.to, netAmount);
        }

        fundsTransferredTo = PostIntentHookExecutor.transferOrExecute(
            _token,
            _intentHash,
            _intent,
            netAmount,
            _postIntentHookData
        );
    }

    function _calculateFeeAllocations(
        IOrchestratorV2.Intent memory _intent,
        uint256 _releaseAmount,
        FeeConfig memory _feeConfig
    ) internal pure returns (IIntentRiskHook.FeeAllocation[] memory allocations, uint256 totalFees) {
        bool hasProtocolFee = _feeConfig.protocolFeeRecipient != address(0) && _feeConfig.protocolFee != 0;
        bool hasManagerFee = _feeConfig.managerFeeRecipient != address(0) && _feeConfig.managerFee != 0;
        uint256 allocationCount = _intent.referralFees.length;
        if (hasProtocolFee) allocationCount++;
        if (hasManagerFee) allocationCount++;

        allocations = new IIntentRiskHook.FeeAllocation[](allocationCount);
        uint256 allocationIndex;

        if (hasProtocolFee) {
            uint256 feeAmount = (_releaseAmount * _feeConfig.protocolFee) / PRECISE_UNIT;
            allocations[allocationIndex++] = IIntentRiskHook.FeeAllocation({
                feeType: IIntentRiskHook.FeeType.PROTOCOL,
                recipient: _feeConfig.protocolFeeRecipient,
                amount: feeAmount
            });
            totalFees += feeAmount;
        }

        for (uint256 referralIndex = 0; referralIndex < _intent.referralFees.length; referralIndex++) {
            IReferralFee.ReferralFee memory referralFee = _intent.referralFees[referralIndex];
            uint256 feeAmount = (_releaseAmount * referralFee.fee) / PRECISE_UNIT;
            allocations[allocationIndex++] = IIntentRiskHook.FeeAllocation({
                feeType: IIntentRiskHook.FeeType.REFERRAL,
                recipient: referralFee.recipient,
                amount: feeAmount
            });
            totalFees += feeAmount;
        }

        if (hasManagerFee) {
            uint256 feeAmount = (_releaseAmount * _feeConfig.managerFee) / PRECISE_UNIT;
            allocations[allocationIndex] = IIntentRiskHook.FeeAllocation({
                feeType: IIntentRiskHook.FeeType.MANAGER,
                recipient: _feeConfig.managerFeeRecipient,
                amount: feeAmount
            });
            totalFees += feeAmount;
        }
    }

    function _transferFeeAllocations(
        IERC20 _token,
        bytes32 _intentHash,
        IIntentRiskHook.FeeAllocation[] memory _allocations
    ) internal {
        for (uint256 allocationIndex = 0; allocationIndex < _allocations.length; allocationIndex++) {
            IIntentRiskHook.FeeAllocation memory allocation = _allocations[allocationIndex];
            _token.safeTransfer(allocation.recipient, allocation.amount);
            if (allocation.feeType == IIntentRiskHook.FeeType.REFERRAL) {
                emit IntentReferralFeeDistributed(_intentHash, allocation.recipient, allocation.amount);
            }
        }
    }
}
