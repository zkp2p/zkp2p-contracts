// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {ITakerRegistry} from "contracts/interfaces/ITakerRegistry.sol";
import {TakerRegistry} from "contracts/registries/TakerRegistry.sol";

/// @dev Signs TakerRegistration statements the way the attestor does, from the EIP-712 definition alone.
abstract contract TakerRegistrationSigner is Test {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant REGISTRATION_TYPEHASH = keccak256(
        "TakerRegistration(address wallet,bytes32 method,bytes32 identityId,uint64 issuedAt,uint64 validUntil)"
    );

    function _signRegistration(
        uint256 signerKey,
        TakerRegistry registry,
        ITakerRegistry.TakerRegistration memory registration
    ) internal view returns (bytes memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("ZKP2P TakerRegistry"), keccak256("1"), block.chainid, address(registry)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                REGISTRATION_TYPEHASH,
                registration.wallet,
                registration.method,
                registration.identityId,
                registration.issuedAt,
                registration.validUntil
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
