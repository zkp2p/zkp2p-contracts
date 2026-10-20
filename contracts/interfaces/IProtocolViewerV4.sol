// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOrchestratorV4 } from "./IOrchestratorV4.sol";
import { IProtocolViewerV2 } from "./IProtocolViewerV2.sol";

/**
 * @notice ProtocolViewerV2 plus intent reads for OrchestratorV4, whose Intent layout V2 cannot decode.
 * @dev Route by orchestrator: the inherited intent reads serve V1-V3 orchestrators, the V4 reads serve OrchestratorV4.
 */
interface IProtocolViewerV4 is IProtocolViewerV2 {

    /* ============ Structs ============ */

    struct IntentViewV4 {
        bytes32 intentHash;
        IOrchestratorV4.Intent intent;
        DepositView deposit;
    }

    /* ============ Functions ============ */

    function getIntentV4(address _orchestrator, bytes32 _intentHash) external view returns (IntentViewV4 memory intentView);

    function getIntentsV4(
        address _orchestrator,
        bytes32[] calldata _intentHashes
    ) external view returns (IntentViewV4[] memory intentArray);

    function getAccountIntentsV4(
        address _orchestrator,
        address _account
    ) external view returns (IntentViewV4[] memory intentViews);
}
