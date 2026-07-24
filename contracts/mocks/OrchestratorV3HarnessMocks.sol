// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IIntentLifecycleHook } from "../interfaces/IIntentLifecycleHook.sol";

interface IOrchestratorV3ReentryTarget {
    function cancelIntent(bytes32 _intentHash) external;
    function cleanupOrphanedIntents(bytes32[] calldata _intentHashes) external;
    function setRiskHook(IIntentLifecycleHook _hook) external;
}

/** @notice Risk hook that catches deliberate attempts to reenter each guarded V3 entrypoint. */
contract OrchestratorV3ReentrantRiskHook is IIntentLifecycleHook {
    IOrchestratorV3ReentryTarget public immutable orchestrator;
    bool public reenterOnCreate;
    bool public setterReentrySucceeded;
    bool public cancelReentrySucceeded;
    bool public cleanupReentrySucceeded;

    constructor(IOrchestratorV3ReentryTarget _orchestrator) {
        orchestrator = _orchestrator;
    }

    function setReenterOnCreate(bool _enabled) external {
        reenterOnCreate = _enabled;
    }

    function onIntentCreated(bytes32) external override {
        if (reenterOnCreate) {
            try orchestrator.setRiskHook(this) {
                setterReentrySucceeded = true;
            } catch { }
        }
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

    function settleIntent(RiskSettlementContext calldata _context) external override {
        try orchestrator.cancelIntent(_context.intentHash) {
            cancelReentrySucceeded = true;
        } catch { }
        bytes32[] memory intentHashes = new bytes32[](1);
        intentHashes[0] = _context.intentHash;
        try orchestrator.cleanupOrphanedIntents(intentHashes) {
            cleanupReentrySucceeded = true;
        } catch { }
        try orchestrator.setRiskHook(this) {
            setterReentrySucceeded = true;
        } catch { }
    }
}
