// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";
import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title IntentRiskHookMock
 * @notice Configurable lifecycle hook used to exercise OrchestratorV3 callback behavior.
 */
contract IntentRiskHookMock is IIntentRiskHook {
    using SafeERC20 for IERC20;

    bool public revertOnCreate;
    bool public revertOnCallback;
    uint256 public callbackRevertDataSize;
    uint256 public settlementPullAmount;
    uint256 public settlementTransferAmount;
    bytes32 public lastIntentHash;
    RiskSettlementContext public lastSettlementContext;
    uint256 public createdCalls;
    uint256 public cancelledCalls;
    uint256 public settlementCalls;

    function setRevertOnCreate(bool _shouldRevert) external {
        revertOnCreate = _shouldRevert;
    }

    function setRevertOnCallback(bool _shouldRevert) external {
        revertOnCallback = _shouldRevert;
    }

    function setCallbackRevertDataSize(uint256 _size) external {
        callbackRevertDataSize = _size;
    }

    function setSettlementPullAmount(uint256 _amount) external {
        settlementPullAmount = _amount;
    }

    function setSettlementTransferAmount(uint256 _amount) external {
        settlementTransferAmount = _amount;
    }

    function acknowledgeIntentCancellation(IOrchestratorV3 _orchestrator, bytes32 _intentHash) external {
        _orchestrator.acknowledgeIntentCancellation(_intentHash);
    }

    function onIntentCreated(bytes32 _intentHash) external override {
        if (revertOnCreate) revert("risk admission failed");
        lastIntentHash = _intentHash;
        createdCalls++;
    }

    function onIntentCancelled(bytes32 _intentHash) external override {
        _revertWithConfiguredData();
        if (revertOnCallback) revert("risk cancellation failed");
        lastIntentHash = _intentHash;
        cancelledCalls++;
    }

    function settleIntent(RiskSettlementContext calldata _context) external override {
        _revertWithConfiguredData();
        if (revertOnCallback) revert("risk settlement failed");
        lastIntentHash = _context.intentHash;
        lastSettlementContext = _context;
        settlementCalls++;

        if (settlementPullAmount != 0) {
            IERC20(_context.token).safeTransferFrom(msg.sender, address(this), settlementPullAmount);
        }
        if (settlementTransferAmount != 0) {
            IERC20(_context.token).safeTransfer(msg.sender, settlementTransferAmount);
        }
    }

    function _revertWithConfiguredData() internal view {
        uint256 revertDataSize = callbackRevertDataSize;
        if (revertDataSize == 0) return;

        assembly ("memory-safe") {
            revert(mload(0x40), revertDataSize)
        }
    }
}
