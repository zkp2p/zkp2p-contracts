// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { OrchestratorV3 } from "../OrchestratorV3.sol";
import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";

/** @notice State harness for defensive branches that valid admission keeps unreachable. */
contract OrchestratorV3StateHarness is OrchestratorV3 {
    constructor(
        address _owner,
        uint256 _chainId,
        address _escrowRegistry,
        address _paymentVerifierRegistry,
        address _relayerRegistry,
        uint256 _protocolFee,
        address _protocolFeeRecipient,
        uint256 _riskCallbackGasLimit
    ) OrchestratorV3(
        _owner,
        _chainId,
        _escrowRegistry,
        _paymentVerifierRegistry,
        _relayerRegistry,
        _protocolFee,
        _protocolFeeRecipient,
        _riskCallbackGasLimit
    ) { }

    function clearPostIntentHook(bytes32 _intentHash) external {
        delete intents[_intentHash].postIntentHook;
    }
}

interface IOrchestratorV3ReentryTarget {
    function cancelIntent(bytes32 _intentHash) external;
    function cleanupOrphanedIntents(bytes32[] calldata _intentHashes) external;
    function setDepositRiskHook(address _escrow, uint256 _depositId, IIntentRiskHook _hook) external;
}

/** @notice Risk hook that catches deliberate attempts to reenter each guarded V3 entrypoint. */
contract OrchestratorV3ReentrantRiskHook is IIntentRiskHook {
    IOrchestratorV3ReentryTarget public immutable orchestrator;
    address public immutable escrow;
    bool public reenterOnCreate;
    bool public setterReentrySucceeded;
    bool public cancelReentrySucceeded;
    bool public cleanupReentrySucceeded;

    constructor(IOrchestratorV3ReentryTarget _orchestrator, address _escrow) {
        orchestrator = _orchestrator;
        escrow = _escrow;
    }

    function setReenterOnCreate(bool _enabled) external {
        reenterOnCreate = _enabled;
    }

    function onIntentCreated(bytes32) external override returns (bool) {
        if (reenterOnCreate) {
            try orchestrator.setDepositRiskHook(escrow, 0, this) {
                setterReentrySucceeded = true;
            } catch { }
        }
        return false;
    }

    function onIntentCancelled(bytes32 _intentHash) external override {
        try orchestrator.cancelIntent(_intentHash) {
            cancelReentrySucceeded = true;
        } catch { }
        bytes32[] memory intentHashes = new bytes32[](1);
        intentHashes[0] = _intentHash;
        try orchestrator.cleanupOrphanedIntents(intentHashes) {
            cleanupReentrySucceeded = true;
        } catch { }
    }

    function onIntentFulfilled(bytes32, uint256) external override { }
    function onIntentReleased(bytes32, uint256) external override { }
}
