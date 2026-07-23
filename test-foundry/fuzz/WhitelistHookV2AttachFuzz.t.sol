// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {WhitelistPreIntentHookV2} from "contracts/hooks/WhitelistPreIntentHookV2.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

// Minimal escrow stand-in: the hook's config functions only read depositor/delegate.
contract EscrowGetDepositMock {
    address public depositor;

    constructor(address _depositor) {
        depositor = _depositor;
    }

    function getDeposit(uint256) external view returns (IEscrow.Deposit memory deposit) {
        deposit.depositor = depositor;
        deposit.delegate = address(0);
    }
}

contract WhitelistHookV2AttachFuzzTest is Test {
    uint256 internal constant GROUP_POOL = 15; // > MAX_GROUPS_PER_DEPOSIT to exercise the cap

    AddressGroupRegistry internal registry;
    WhitelistPreIntentHookV2 internal hook;
    EscrowGetDepositMock internal escrow;
    address internal depositor;
    uint256[] internal pool;

    function setUp() public {
        depositor = makeAddr("depositor");
        registry = new AddressGroupRegistry();
        hook = new WhitelistPreIntentHookV2(address(new OrchestratorRegistry()), address(registry));
        escrow = new EscrowGetDepositMock(depositor);
        for (uint256 i = 0; i < GROUP_POOL; i++) {
            vm.prank(depositor);
            pool.push(registry.createGroup("pool"));
        }
    }

    function _one(uint256 id) internal pure returns (uint256[] memory values) {
        values = new uint256[](1);
        values[0] = id;
    }

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_AttachDetachSequencePreservesIndexIntegrity(uint8[] calldata ops) public {
        vm.assume(ops.length <= 64);
        bool[] memory expectedAttached = new bool[](GROUP_POOL);
        uint256 expectedCount;

        for (uint256 i = 0; i < ops.length; i++) {
            uint256 poolIndex = uint256(ops[i] % GROUP_POOL);
            bool isAttach = (ops[i] & 0x80) == 0;
            uint256 groupId = pool[poolIndex];

            if (isAttach) {
                if (!expectedAttached[poolIndex] && expectedCount >= hook.MAX_GROUPS_PER_DEPOSIT()) {
                    vm.expectRevert(
                        abi.encodeWithSelector(
                            WhitelistPreIntentHookV2.MaxGroupsExceeded.selector,
                            expectedCount + 1,
                            hook.MAX_GROUPS_PER_DEPOSIT()
                        )
                    );
                    vm.prank(depositor);
                    hook.attachGroups(address(escrow), 0, _one(groupId));
                } else {
                    vm.prank(depositor);
                    hook.attachGroups(address(escrow), 0, _one(groupId));
                    if (!expectedAttached[poolIndex]) {
                        expectedAttached[poolIndex] = true;
                        expectedCount++;
                    }
                }
            } else {
                vm.prank(depositor);
                hook.detachGroups(address(escrow), 0, _one(groupId));
                if (expectedAttached[poolIndex]) {
                    expectedAttached[poolIndex] = false;
                    expectedCount--;
                }
            }

            _assertIntegrity(expectedAttached, expectedCount);
        }
    }

    function _assertIntegrity(bool[] memory expectedAttached, uint256 expectedCount) internal view {
        uint256[] memory attached = hook.getAttachedGroups(address(escrow), 0);

        // count matches the model and never exceeds the cap
        assertEq(attached.length, expectedCount);
        assertLe(attached.length, hook.MAX_GROUPS_PER_DEPOSIT());

        // no duplicates, and every array entry reports attached
        for (uint256 i = 0; i < attached.length; i++) {
            assertTrue(hook.isGroupAttached(address(escrow), 0, attached[i]));
            for (uint256 j = i + 1; j < attached.length; j++) {
                assertTrue(attached[i] != attached[j]);
            }
        }

        // model agreement in both directions
        for (uint256 p = 0; p < GROUP_POOL; p++) {
            assertEq(hook.isGroupAttached(address(escrow), 0, pool[p]), expectedAttached[p]);
        }
    }
}
