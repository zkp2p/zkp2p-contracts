// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { AddressGroupRegistry } from "../registries/AddressGroupRegistry.sol";
import { IAddressGroupRegistry } from "../interfaces/IAddressGroupRegistry.sol";

// Test-only subclass that raises the resolver gas limit so the bounded-returndata copy can be
// demonstrated with payloads far larger than the production stipend permits (harness-level
// proof; production stipend cannot construct such payloads by design).
contract AddressGroupRegistryGasHarness is AddressGroupRegistry {
    uint256 internal resolverGasLimitOverride = RESOLVER_GAS_LIMIT;

    constructor() AddressGroupRegistry(new IAddressGroupRegistry.GroupSeed[](0)) {}

    function setResolverGasLimit(uint256 _limit) external {
        resolverGasLimitOverride = _limit;
    }

    function _resolverGasLimit() internal view override returns (uint256) {
        return resolverGasLimitOverride;
    }
}
