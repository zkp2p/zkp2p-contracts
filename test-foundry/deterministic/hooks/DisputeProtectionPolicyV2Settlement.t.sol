// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";

contract DisputeProtectionPolicyV2SettlementTest is OrchestratorV4Fixture {
    event ProtectionOpened(bytes32 indexed intentHash, address indexed depositor);

    bytes32 internal constant ID = keccak256("intent");
    uint256 internal constant NET = INTENT_AMOUNT - 1e6;
    StakeVaultV2 internal vault;
    DisputeProtectionPolicyV2 internal policy;

    function setUp() public override {
        super.setUp();
        vault = new StakeVaultV2(address(this), token);
        policy = new DisputeProtectionPolicyV2(
            address(this), vault,
            new DisputeVerifier(address(this), new NullifierRegistryV2(new NullifierRegistry()), new AttestationVerifierMock()),
            new NullifierRegistry()
        );
        vault.setController(address(policy), true);
        policy.setOrchestratorAuthorization(address(this), true);
    }

    function _context(bytes32 id, uint256 window) internal view returns (IIntentSettlementPolicy.SettlementContext memory) {
        return IIntentSettlementPolicy.SettlementContext(id, address(token), taker, other, depositor, METHOD, INTENT_AMOUNT, NET, abi.encode(window));
    }

    function _isOpen(bytes32 id) internal view returns (bool) {
        return policy.getProtection(id).depositor != address(0);
    }

    function _fund(bytes32 id, uint256 window) internal {
        token.transfer(address(vault), NET);
        policy.onDeferredPayoutFunded(_context(id, window));
    }

    function test_RegisteredRelayerTakerIsProtected() public {
        relayerRegistry.addRelayer(taker);
        vm.expectEmit(true, true, false, true, address(policy));
        emit ProtectionOpened(ID, depositor);
        assertEq(policy.settleIntent(_context(ID, 14 days)), address(vault));
        assertTrue(_isOpen(ID));
    }

    function test_SettleReturnsVaultOnlyWhenDeferred() public {
        assertEq(policy.settleIntent(_context(ID, 0)), address(0));
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(vault), INTENT_AMOUNT);
        vault.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
        bytes32 stakeId = keccak256("stake");
        assertEq(policy.settleIntent(_context(stakeId, 14 days)), address(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        bytes32 deferredId = keccak256("deferred");
        assertEq(policy.settleIntent(_context(deferredId, 14 days)), address(vault));
        _fund(deferredId, 14 days);
        (address owner, uint256 amount,) = vault.locks(deferredId);
        assertEq(owner, other);
        assertEq(amount, NET);
    }

    function test_ZeroWindowDoesNotWriteStorage() public {
        vm.record();
        policy.settleIntent(_context(ID, 0));
        (, bytes32[] memory writes) = vm.accesses(address(policy));
        assertEq(writes.length, 0);
    }

    function test_SettlementDataShorterThanWindowReverts() public {
        bytes[3] memory settlementData = [bytes(""), bytes(hex"ff"), new bytes(31)];
        for (uint256 i; i < settlementData.length; ++i) {
            IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
            context.settlementData = settlementData[i];
            vm.expectRevert();
            policy.settleIntent(context);
        }
    }

    function test_WindowAboveMaximumReverts() public {
        uint256[3] memory windows = [uint256(180 days + 1), uint256(type(uint64).max) + 1, type(uint256).max];
        for (uint256 i; i < windows.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(P.InvalidDisputeWindow.selector, windows[i]));
            policy.settleIntent(_context(ID, windows[i]));
        }
        assertFalse(_isOpen(ID));
    }

    function test_SignedWindowsSetDeferredMaturity() public {
        uint256[3] memory windows = [uint256(1), uint256(7 days), uint256(180 days)];
        assertEq(policy.MAX_DISPUTE_WINDOW(), windows[2]);
        for (uint256 i; i < windows.length; ++i) {
            bytes32 id = bytes32(i + 1);
            assertEq(policy.settleIntent(_context(id, windows[i])), address(vault));
            _fund(id, windows[i]);
            (,, uint64 maturesAt) = vault.locks(id);
            assertEq(maturesAt, block.timestamp + windows[i]);
        }
    }

    function test_TrailingSettlementWordsAreIgnored() public {
        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 0);
        context.settlementData = abi.encode(uint256(0), keccak256("reserved"), type(uint256).max, uint256(2));
        assertEq(policy.settleIntent(context), address(0));
        assertFalse(_isOpen(ID));
    }

    function test_UnauthorizedOrchestratorRejected() public {
        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 0);
        vm.startPrank(other);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, other));
        policy.settleIntent(context);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, other));
        policy.onDeferredPayoutFunded(context);
        vm.stopPrank();
    }

    function test_SupportsOnlyMinimalSettlementAndERC165Interfaces() public view {
        bytes4 expected = IIntentSettlementPolicy.settleIntent.selector ^ IIntentSettlementPolicy.onDeferredPayoutFunded.selector;
        assertEq(expected, type(IIntentSettlementPolicy).interfaceId);
        assertTrue(policy.supportsInterface(expected));
        assertTrue(policy.supportsInterface(0x01ffc9a7));
        assertFalse(policy.supportsInterface(0xffffffff));
        assertFalse(policy.supportsInterface(type(IOrchestratorV4).interfaceId));
    }
}
