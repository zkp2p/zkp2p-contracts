// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {Vm} from "forge-std/Vm.sol";

contract OrchestratorPruneParityTest is OrchestratorLegacyFixture {
    event IntentPruned(bytes32 indexed intentHash);

    bytes32[] internal intentHashes;

    function setUp() public override {
        super.setUp();
        vm.startPrank(offRamper);
        escrow.addFunds(0, 200e6);
        escrow.setIntentRange(0, IEscrow.Range({min: 10e6, max: 100e6}));
        vm.stopPrank();
        escrow.setMaxIntentsPerDeposit(10);
        orchestrator.setAllowMultipleIntents(true);

        intentHashes.push(_signalAmount(onRamper, 50e6));
        vm.warp(block.timestamp + 1);
        intentHashes.push(_signalAmount(onRamper, 60e6));
        vm.warp(block.timestamp + 1);
        intentHashes.push(_signalAmount(onRamper, 70e6));
    }

    function _signalAmount(address account, uint256 amount) internal returns (bytes32) {
        IOrchestrator.SignalIntentParams memory params = _baseSignalParams(account);
        params.amount = amount;
        params.to = account;
        params.gatingServiceSignature = _resign(params);
        return _signal(account, params);
    }

    function _allIntents() internal view returns (bytes32[] memory hashes) {
        hashes = new bytes32[](intentHashes.length);
        for (uint256 i = 0; i < hashes.length; i++) {
            hashes[i] = intentHashes[i];
        }
    }

    function _prune(address caller, bytes32[] memory hashes) internal {
        vm.prank(caller);
        orchestrator.pruneIntents(hashes);
    }

    function _containsPrunedEvent(Vm.Log[] memory logs) internal view returns (bool) {
        bytes32 signature = keccak256("IntentPruned(bytes32)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(orchestrator) && logs[i].topics.length > 0 && logs[i].topics[0] == signature)
            {
                return true;
            }
        }
        return false;
    }

    function test_PruneIntentsDeletesEveryIntent() public {
        for (uint256 i = 0; i < intentHashes.length; i++) {
            assertEq(orchestrator.getIntent(intentHashes[i]).owner, onRamper);
        }
        _prune(address(escrow), _allIntents());
        for (uint256 i = 0; i < intentHashes.length; i++) {
            assertEq(orchestrator.getIntent(intentHashes[i]).owner, address(0));
        }
    }

    function test_PruneIntentsRemovesEveryAccountIntent() public {
        bytes32[] memory beforeIntents = orchestrator.getAccountIntents(onRamper);
        assertEq(beforeIntents.length, 3);
        for (uint256 i = 0; i < intentHashes.length; i++) {
            assertTrue(_contains(beforeIntents, intentHashes[i]));
        }
        _prune(address(escrow), _allIntents());
        assertEq(orchestrator.getAccountIntents(onRamper).length, 0);
    }

    function test_PruneIntentsEmitsForEveryIntent() public {
        bytes32[] memory hashes = _allIntents();
        for (uint256 i = 0; i < hashes.length; i++) {
            vm.expectEmit(true, false, false, false, address(orchestrator));
            emit IntentPruned(hashes[i]);
        }
        _prune(address(escrow), hashes);
    }

    function test_PruneIntentsSkipsZeroHashes() public {
        bytes32[] memory hashes = new bytes32[](3);
        hashes[0] = intentHashes[0];
        hashes[1] = bytes32(0);
        hashes[2] = intentHashes[2];
        _prune(address(escrow), hashes);
        assertEq(orchestrator.getIntent(intentHashes[0]).owner, address(0));
        assertEq(orchestrator.getIntent(intentHashes[1]).owner, onRamper);
        assertEq(orchestrator.getIntent(intentHashes[2]).owner, address(0));
    }

    function test_PruneIntentsUnknownHashesDoNotRevert() public {
        _prune(address(escrow), _unknownHashes());
    }

    function test_PruneIntentsUnknownHashesEmitNothing() public {
        vm.recordLogs();
        _prune(address(escrow), _unknownHashes());
        assertFalse(_containsPrunedEvent(vm.getRecordedLogs()));
    }

    function test_PruneIntentsFromWrongCallerSkipsWithoutEvents() public {
        vm.recordLogs();
        _prune(maliciousOnRamper, _allIntents());
        assertFalse(_containsPrunedEvent(vm.getRecordedLogs()));
        for (uint256 i = 0; i < intentHashes.length; i++) {
            assertEq(orchestrator.getIntent(intentHashes[i]).owner, onRamper);
        }
    }

    function test_PruneIntentsUpdatesMultipleAccounts() public {
        bytes32 secondAccountIntent = _signalAmount(onRamperTwo, 40e6);
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = intentHashes[0];
        hashes[1] = secondAccountIntent;
        assertEq(orchestrator.getAccountIntents(onRamper).length, 3);
        assertEq(orchestrator.getAccountIntents(onRamperTwo).length, 1);

        _prune(address(escrow), hashes);

        bytes32[] memory firstAccount = orchestrator.getAccountIntents(onRamper);
        assertEq(firstAccount.length, 2);
        assertFalse(_contains(firstAccount, intentHashes[0]));
        assertTrue(_contains(firstAccount, intentHashes[1]));
        assertTrue(_contains(firstAccount, intentHashes[2]));
        assertEq(orchestrator.getAccountIntents(onRamperTwo).length, 0);
    }

    function test_PruneIntentsEmptyArrayDoesNotRevert() public {
        _prune(address(escrow), new bytes32[](0));
    }

    function test_PruneIntentsEmptyArrayEmitsNothing() public {
        vm.recordLogs();
        _prune(address(escrow), new bytes32[](0));
        assertFalse(_containsPrunedEvent(vm.getRecordedLogs()));
    }

    function _unknownHashes() internal pure returns (bytes32[] memory hashes) {
        hashes = new bytes32[](2);
        hashes[0] = keccak256("nonexistent1");
        hashes[1] = keccak256("nonexistent2");
    }

    function _contains(bytes32[] memory values, bytes32 needle) internal pure returns (bool) {
        for (uint256 i = 0; i < values.length; i++) {
            if (values[i] == needle) return true;
        }
        return false;
    }
}
