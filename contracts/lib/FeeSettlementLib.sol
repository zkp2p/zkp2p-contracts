// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IIntentLifecycleHook } from "../interfaces/IIntentLifecycleHook.sol";
import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";
import { IReferralFee } from "../interfaces/IReferralFee.sol";
import { PostIntentHookExecutor } from "./PostIntentHookExecutor.sol";
import { LifecycleSettlementExecutor } from "./LifecycleSettlementExecutor.sol";

/**
 * @title FeeSettlementLib
 * @notice Builds and executes the exact fee and net-payout plan used by OrchestratorV3 settlement.
 * @dev Settlement follows one of two mutually exclusive paths:
 *      1. A configured lifecycle hook consumes the complete gross release under a temporary allowance. No fee or net-payout
 *         transfer is then executed by the orchestrator; the hook owns the complete downstream accounting decision.
 *      2. The lifecycle hook consumes nothing, each fee line is transferred directly, and the executable remainder is sent
 *         either to the intent recipient or through its snapshotted post-intent hook.
 *
 *      Protocol, referral, and manager fees are calculated independently from the gross release and rounded down before
 *      being summed. Public library functions keep this machinery out of the size-constrained orchestrator runtime.
 */
library FeeSettlementLib {
    using SafeERC20 for IERC20;

    /// @dev Denominator for protocol, referral, and manager fee rates expressed in 1e18 precise units.
    uint256 internal constant PRECISE_UNIT = 1e18;

    /// @dev Maximum callback return or revert data copied by the lifecycle settlement boundary.
    uint256 internal constant MAX_RISK_CALLBACK_RETURN_DATA = 2_048;

    /// @notice Emitted for every fee line paid directly by the ordinary settlement path.
    event IntentFeeDistributed(
        bytes32 indexed intentHash,
        IIntentLifecycleHook.FeeType feeType,
        address indexed recipient,
        uint256 amount
    );

    /**
     * @dev Protocol and per-intent manager fee terms supplied by OrchestratorV3. Fee values are rates in 1e18 precise
     *      units; recipients and rates are both required for the corresponding fee line to be included.
     */
    struct FeeConfig {
        address protocolFeeRecipient;
        uint256 protocolFee;
        address managerFeeRecipient;
        uint256 managerFee;
    }

    /**
     * @notice Gives the lifecycle hook first refusal over gross funds, then executes ordinary fees and payout if unconsumed.
     * @dev Builds the exact fee plan and executable amount before invoking the lifecycle hook. The hook may consume either zero
     *      or exactly the gross release; `LifecycleSettlementExecutor` rejects every other balance delta. Full consumption
     *      returns immediately without paying fees or invoking a post-intent hook. Zero consumption distributes every fee
     *      line and routes the executable remainder through `PostIntentHookExecutor`.
     * @param _token Settlement token currently held by OrchestratorV3.
     * @param _lifecycleHook Snapshotted lifecycle hook, or zero to use ordinary settlement directly.
     * @param _intentHash Identifier included in callbacks and settlement events.
     * @param _intent Snapshotted intent containing recipient, referral fees, and optional post-intent hook.
     * @param _releaseAmount Gross amount released from Escrow for this settlement.
     * @param _postIntentHookData Fulfillment-time data forwarded only when the ordinary path invokes a post-intent hook.
     * @param _feeConfig Current protocol terms and snapshotted per-intent manager terms.
     * @param _isManualRelease Whether settlement was initiated through depositor manual release.
     * @param _callbackGasLimit Maximum gas forwarded to the lifecycle settlement callback.
     * @return fundsTransferredTo Address reported as handling the settled amount: lifecycle hook, direct recipient, or post hook.
     * @return reportedAmount Gross amount when the lifecycle hook consumes funds; otherwise the executable amount.
     */
    function executeSettlement(
        IERC20 _token,
        IIntentLifecycleHook _lifecycleHook,
        bytes32 _intentHash,
        IOrchestratorV3.Intent memory _intent,
        uint256 _releaseAmount,
        bytes memory _postIntentHookData,
        FeeConfig memory _feeConfig,
        bool _isManualRelease,
        uint256 _callbackGasLimit
    ) public returns (address fundsTransferredTo, uint256 reportedAmount) {
        (
            IIntentLifecycleHook.FeeAllocation[] memory feeAllocations,
            uint256 totalFees
        ) = _calculateFeeAllocations(_intent, _releaseAmount, _feeConfig);
        uint256 netAmount = _releaseAmount - totalFees;

        bool fundsConsumed = LifecycleSettlementExecutor.execute(
            _lifecycleHook,
            _token,
            IIntentLifecycleHook.SettlementContext({
                intentHash: _intentHash,
                token: address(_token),
                recipient: _intent.to,
                grossAmount: _releaseAmount,
                executableAmount: netAmount,
                isManualRelease: _isManualRelease,
                feeAllocations: feeAllocations
            }),
            _callbackGasLimit,
            MAX_RISK_CALLBACK_RETURN_DATA
        );

        if (fundsConsumed) return (address(_lifecycleHook), _releaseAmount);

        _transferFeeAllocations(_token, _intentHash, feeAllocations);
        fundsTransferredTo = PostIntentHookExecutor.transferOrExecute(
            _token,
            _intentHash,
            _intent,
            netAmount,
            _postIntentHookData
        );
        return (fundsTransferredTo, netAmount);
    }

    /**
     * @dev Builds ordered protocol, referral, and manager fee lines from one gross release. Each line is independently
     *      rounded down before being added to `totalFees`. Protocol is first when configured, referrals retain their
     *      snapshotted array order, and manager is last when configured.
     * @param _intent Intent containing the validated and snapshotted referral fee terms.
     * @param _releaseAmount Gross settlement amount used as the basis for every fee.
     * @param _feeConfig Protocol and manager fee recipients and rates.
     * @return allocations Ordered exact fee-payment plan supplied to risk policy or ordinary distribution.
     * @return totalFees Sum of every independently rounded fee amount.
     */
    function _calculateFeeAllocations(
        IOrchestratorV3.Intent memory _intent,
        uint256 _releaseAmount,
        FeeConfig memory _feeConfig
    ) internal pure returns (IIntentLifecycleHook.FeeAllocation[] memory allocations, uint256 totalFees) {
        bool hasProtocolFee = _feeConfig.protocolFeeRecipient != address(0) && _feeConfig.protocolFee != 0;
        bool hasManagerFee = _feeConfig.managerFeeRecipient != address(0) && _feeConfig.managerFee != 0;
        uint256 allocationCount = _intent.referralFees.length;
        if (hasProtocolFee) allocationCount++;
        if (hasManagerFee) allocationCount++;

        allocations = new IIntentLifecycleHook.FeeAllocation[](allocationCount);
        uint256 allocationIndex;

        if (hasProtocolFee) {
            uint256 feeAmount = (_releaseAmount * _feeConfig.protocolFee) / PRECISE_UNIT;
            allocations[allocationIndex++] = IIntentLifecycleHook.FeeAllocation({
                feeType: IIntentLifecycleHook.FeeType.PROTOCOL,
                recipient: _feeConfig.protocolFeeRecipient,
                amount: feeAmount
            });
            totalFees += feeAmount;
        }

        for (uint256 referralIndex = 0; referralIndex < _intent.referralFees.length; referralIndex++) {
            IReferralFee.ReferralFee memory referralFee = _intent.referralFees[referralIndex];
            uint256 feeAmount = (_releaseAmount * referralFee.fee) / PRECISE_UNIT;
            allocations[allocationIndex++] = IIntentLifecycleHook.FeeAllocation({
                feeType: IIntentLifecycleHook.FeeType.REFERRAL,
                recipient: referralFee.recipient,
                amount: feeAmount
            });
            totalFees += feeAmount;
        }

        if (hasManagerFee) {
            uint256 feeAmount = (_releaseAmount * _feeConfig.managerFee) / PRECISE_UNIT;
            allocations[allocationIndex] = IIntentLifecycleHook.FeeAllocation({
                feeType: IIntentLifecycleHook.FeeType.MANAGER,
                recipient: _feeConfig.managerFeeRecipient,
                amount: feeAmount
            });
            totalFees += feeAmount;
        }
    }

    /**
     * @dev Transfers every fee line directly from OrchestratorV3 and emits one event per line. Zero-value lines remain in
     *      the plan and emit an event because independently rounded non-zero fee rates may produce a zero token amount.
     * @param _token Settlement token held by OrchestratorV3.
     * @param _intentHash Intent identifier included in each distribution event.
     * @param _allocations Ordered exact fee-payment plan to execute.
     */
    function _transferFeeAllocations(
        IERC20 _token,
        bytes32 _intentHash,
        IIntentLifecycleHook.FeeAllocation[] memory _allocations
    ) internal {
        for (uint256 allocationIndex = 0; allocationIndex < _allocations.length; allocationIndex++) {
            IIntentLifecycleHook.FeeAllocation memory allocation = _allocations[allocationIndex];
            _token.safeTransfer(allocation.recipient, allocation.amount);
            emit IntentFeeDistributed(
                _intentHash,
                allocation.feeType,
                allocation.recipient,
                allocation.amount
            );
        }
    }
}
