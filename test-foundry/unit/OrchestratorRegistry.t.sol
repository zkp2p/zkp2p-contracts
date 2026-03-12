// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { OrchestratorRegistry } from "../../contracts/registries/OrchestratorRegistry.sol";

contract OrchestratorRegistryTest is Test {
    event OrchestratorAdded(address indexed orchestrator);
    event OrchestratorRemoved(address indexed orchestrator);

    OrchestratorRegistry internal registry;

    address internal owner;
    address internal caller;
    address internal orchestrator;

    function setUp() public {
        owner = makeAddr("owner");
        caller = makeAddr("caller");
        orchestrator = makeAddr("orchestrator");

        vm.prank(owner);
        registry = new OrchestratorRegistry();
    }

    function test_addOrchestratorAddsAddressAndEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit OrchestratorAdded(orchestrator);

        vm.prank(owner);
        registry.addOrchestrator(orchestrator);

        assertTrue(registry.isOrchestrator(orchestrator));
    }

    function test_addOrchestratorRevertsWhenCallerIsNotOwner() public {
        vm.prank(caller);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.addOrchestrator(orchestrator);
    }

    function test_addOrchestratorRevertsWhenAddressIsZero() public {
        vm.prank(owner);
        vm.expectRevert(OrchestratorRegistry.ZeroAddress.selector);
        registry.addOrchestrator(address(0));
    }

    function test_addOrchestratorRevertsWhenAlreadyAdded() public {
        vm.startPrank(owner);
        registry.addOrchestrator(orchestrator);
        vm.expectRevert(
            abi.encodeWithSelector(OrchestratorRegistry.OrchestratorAlreadyAdded.selector, orchestrator)
        );
        registry.addOrchestrator(orchestrator);
        vm.stopPrank();
    }

    function test_removeOrchestratorRemovesAddressAndEmitsEvent() public {
        vm.prank(owner);
        registry.addOrchestrator(orchestrator);

        vm.expectEmit(true, false, false, true, address(registry));
        emit OrchestratorRemoved(orchestrator);

        vm.prank(owner);
        registry.removeOrchestrator(orchestrator);

        assertFalse(registry.isOrchestrator(orchestrator));
    }

    function test_removeOrchestratorRevertsWhenCallerIsNotOwner() public {
        vm.prank(owner);
        registry.addOrchestrator(orchestrator);

        vm.prank(caller);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.removeOrchestrator(orchestrator);
    }

    function test_removeOrchestratorRevertsWhenAddressIsZero() public {
        vm.prank(owner);
        registry.addOrchestrator(orchestrator);

        vm.prank(owner);
        vm.expectRevert(OrchestratorRegistry.ZeroAddress.selector);
        registry.removeOrchestrator(address(0));
    }

    function test_removeOrchestratorRevertsWhenAddressIsMissing() public {
        vm.prank(owner);
        registry.addOrchestrator(orchestrator);

        vm.prank(owner);
        registry.removeOrchestrator(orchestrator);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OrchestratorRegistry.OrchestratorNotFound.selector, orchestrator));
        registry.removeOrchestrator(orchestrator);
    }
}
