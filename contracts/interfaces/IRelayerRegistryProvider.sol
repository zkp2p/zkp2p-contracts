// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IRelayerRegistry} from "./IRelayerRegistry.sol";

/// @notice Exposes an orchestrator's current relayer registry for settlement exemptions.
interface IRelayerRegistryProvider {
    /// @notice Returns the currently configured relayer registry.
    function relayerRegistry() external view returns (IRelayerRegistry);
}
