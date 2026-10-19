// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { ERC165Checker } from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import { IOrchestratorV4 } from "./interfaces/IOrchestratorV4.sol";
import { IProtocolViewerV4 } from "./interfaces/IProtocolViewerV4.sol";
import { ProtocolViewerV2 } from "./ProtocolViewerV2.sol";

/**
 * @title ProtocolViewerV4
 * @notice ProtocolViewerV2 plus intent reads for OrchestratorV4.
 * @dev The inherited intent reads decode through IOrchestratorV2 and revert on OrchestratorV4 intents. The V4 reads
 * accept only orchestrators that report the IOrchestratorV4 interface, so a caller that routes the wrong way fails
 * with InvalidOrchestrator instead of a decoding error.
 */
contract ProtocolViewerV4 is ProtocolViewerV2, IProtocolViewerV4 {
    function getIntentV4(
        address _orchestrator,
        bytes32 _intentHash
    ) external view returns (IntentViewV4 memory intentView) {
        intentView = _intentViewV4(_orchestratorV4(_orchestrator), _intentHash);
    }

    function getIntentsV4(
        address _orchestrator,
        bytes32[] calldata _intentHashes
    ) external view returns (IntentViewV4[] memory intentArray) {
        IOrchestratorV4 orchestrator = _orchestratorV4(_orchestrator);
        intentArray = new IntentViewV4[](_intentHashes.length);

        for (uint256 i = 0; i < _intentHashes.length; ++i) {
            intentArray[i] = _intentViewV4(orchestrator, _intentHashes[i]);
        }
    }

    function getAccountIntentsV4(
        address _orchestrator,
        address _account
    ) external view returns (IntentViewV4[] memory intentViews) {
        IOrchestratorV4 orchestrator = _orchestratorV4(_orchestrator);
        bytes32[] memory intentHashes = orchestrator.getAccountIntents(_account);
        intentViews = new IntentViewV4[](intentHashes.length);

        for (uint256 i = 0; i < intentHashes.length; ++i) {
            intentViews[i] = _intentViewV4(orchestrator, intentHashes[i]);
        }
    }

    function _intentViewV4(
        IOrchestratorV4 _orchestrator,
        bytes32 _intentHash
    ) internal view returns (IntentViewV4 memory intentView) {
        IOrchestratorV4.Intent memory intent = _orchestrator.getIntent(_intentHash);
        intentView = IntentViewV4({
            intentHash: _intentHash,
            intent: intent,
            deposit: _getDeposit(intent.escrow, intent.depositId)
        });
    }

    function _orchestratorV4(address _orchestrator) internal view returns (IOrchestratorV4 orchestrator) {
        if (!ERC165Checker.supportsInterface(_orchestrator, type(IOrchestratorV4).interfaceId)) {
            revert InvalidOrchestrator(_orchestrator);
        }
        orchestrator = IOrchestratorV4(_orchestrator);
    }
}
