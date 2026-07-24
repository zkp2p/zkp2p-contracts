// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IRiskManager} from "../../contracts/interfaces/IRiskManager.sol";
import {RiskManagerFixture} from "../deterministic/helpers/RiskManagerFixture.sol";

contract MakerProtectionAttachFuzzTest is RiskManagerFixture {
    uint256 internal constant GROUP_POOL = 15;

    address internal maker = makeAddr("maker");
    uint256[] internal pool;

    function setUp() public override {
        super.setUp();

        for (uint256 groupIndex = 0; groupIndex < GROUP_POOL; groupIndex++) {
            vm.prank(maker);
            pool.push(groupRegistry.createGroup("pool"));
        }
    }

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_AttachDetachSequencePreservesArrayIntegrity(uint8[] calldata ops) public {
        vm.assume(ops.length <= 64);
        bool[] memory expectedAttached = new bool[](GROUP_POOL);
        uint256 expectedCount;

        for (uint256 operationIndex = 0; operationIndex < ops.length; operationIndex++) {
            uint256 poolIndex = uint256(ops[operationIndex] % GROUP_POOL);
            bool isAttach = (ops[operationIndex] & 0x80) == 0;
            uint256 groupId = pool[poolIndex];

            if (isAttach) {
                if (!expectedAttached[poolIndex] && expectedCount == manager.MAX_ATTACHED_GROUPS()) {
                    vm.expectRevert(
                        abi.encodeWithSelector(
                            IRiskManager.MaxGroupsExceeded.selector,
                            expectedCount + 1,
                            manager.MAX_ATTACHED_GROUPS()
                        )
                    );
                    vm.prank(maker);
                    manager.attachGroups(_one(groupId));
                } else {
                    vm.prank(maker);
                    manager.attachGroups(_one(groupId));
                    if (!expectedAttached[poolIndex]) {
                        expectedAttached[poolIndex] = true;
                        expectedCount++;
                    }
                }
            } else {
                vm.prank(maker);
                manager.detachGroups(_one(groupId));
                if (expectedAttached[poolIndex]) {
                    expectedAttached[poolIndex] = false;
                    expectedCount--;
                }
            }

            _assertIntegrity(expectedAttached, expectedCount);
        }
    }

    function _assertIntegrity(bool[] memory expectedAttached, uint256 expectedCount) internal view {
        uint256[] memory attached = manager.getAttachedGroups(maker);

        assertEq(attached.length, expectedCount);
        assertLe(attached.length, manager.MAX_ATTACHED_GROUPS());

        for (uint256 attachedIndex = 0; attachedIndex < attached.length; attachedIndex++) {
            for (uint256 comparisonIndex = attachedIndex + 1; comparisonIndex < attached.length; comparisonIndex++) {
                assertTrue(attached[attachedIndex] != attached[comparisonIndex]);
            }
        }

        for (uint256 poolIndex = 0; poolIndex < GROUP_POOL; poolIndex++) {
            bool isAttached;
            for (uint256 attachedIndex = 0; attachedIndex < attached.length; attachedIndex++) {
                if (attached[attachedIndex] == pool[poolIndex]) {
                    isAttached = true;
                    break;
                }
            }
            assertEq(isAttached, expectedAttached[poolIndex]);
        }
    }

    function _one(uint256 groupId) internal pure returns (uint256[] memory groupIds) {
        groupIds = new uint256[](1);
        groupIds[0] = groupId;
    }
}
