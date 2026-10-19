// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IRelayerRegistry} from "contracts/interfaces/IRelayerRegistry.sol";
import {IRelayerRegistryProvider} from "contracts/interfaces/IRelayerRegistryProvider.sol";

contract ZeroRelayerRegistryOrchestratorMock is IRelayerRegistryProvider {
    function relayerRegistry() external pure override returns (IRelayerRegistry) {
        return IRelayerRegistry(address(0));
    }
}
