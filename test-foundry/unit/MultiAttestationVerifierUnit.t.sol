// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { MultiAttestationVerifier } from "../../contracts/unifiedVerifier/MultiAttestationVerifier.sol";

contract MultiAttestationVerifierUnit is Test {
    MultiAttestationVerifier public verifier;

    address public witnessA;
    address public witnessB;

    function setUp() public {
        witnessA = makeAddr("witnessA");
        witnessB = makeAddr("witnessB");

        verifier = new MultiAttestationVerifier();
    }

    function test_verify_reachesSignatureThresholdValidationWithValidConfig() public {
        address[] memory witnesses = _twoWitnesses();
        bytes memory data = abi.encode(witnesses, uint256(2));
        bytes[] memory signatures = new bytes[](0);

        vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds signatures");
        verifier.verify(bytes32(0), signatures, data);
    }

    function test_verify_revertsOnEmptyData() public {
        vm.expectRevert("MAV: witness config required");
        verifier.verify(bytes32(0), new bytes[](0), "");
    }

    function test_verify_revertsOnEmptyWitnesses() public {
        address[] memory witnesses = new address[](0);

        vm.expectRevert("MAV: empty witnesses");
        verifier.verify(bytes32(0), new bytes[](0), abi.encode(witnesses, uint256(1)));
    }

    function test_verify_revertsOnZeroThreshold() public {
        vm.expectRevert("MAV: threshold must be > 0");
        verifier.verify(bytes32(0), new bytes[](0), abi.encode(_singleWitness(witnessA), uint256(0)));
    }

    function test_verify_revertsWhenThresholdExceedsWitnessCount() public {
        vm.expectRevert("MAV: threshold exceeds count");
        verifier.verify(bytes32(0), new bytes[](0), abi.encode(_singleWitness(witnessA), uint256(2)));
    }

    function test_verify_revertsOnZeroWitness() public {
        address[] memory witnesses = new address[](2);
        witnesses[0] = witnessA;
        witnesses[1] = address(0);

        vm.expectRevert("MAV: zero witness");
        verifier.verify(bytes32(0), new bytes[](0), abi.encode(witnesses, uint256(1)));
    }

    function test_verify_revertsOnDuplicateWitness() public {
        address[] memory witnesses = new address[](2);
        witnesses[0] = witnessA;
        witnesses[1] = witnessA;

        vm.expectRevert("MAV: duplicate witness");
        verifier.verify(bytes32(0), new bytes[](0), abi.encode(witnesses, uint256(1)));
    }

    function _singleWitness(address witnessAddress) internal pure returns (address[] memory witnesses) {
        witnesses = new address[](1);
        witnesses[0] = witnessAddress;
    }

    function _twoWitnesses() internal view returns (address[] memory witnesses) {
        witnesses = new address[](2);
        witnesses[0] = witnessA;
        witnesses[1] = witnessB;
    }
}
