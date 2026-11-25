// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {DisputeProtectionPolicyV3} from "contracts/hooks/DisputeProtectionPolicyV3.sol";
import {IDisputeProtectionPolicyV3 as P} from "contracts/interfaces/IDisputeProtectionPolicyV3.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IIntentSettlementPolicy as S} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {DisputeVerifierV2} from "contracts/unifiedVerifier/DisputeVerifierV2.sol";
import {ReceiptVerifier} from "contracts/unifiedVerifier/ReceiptVerifier.sol";
import {AttestationVerifierMock} from "../mocks/AttestationVerifierMock.sol";

/// @notice Share-dispute maths through the real policy and vault: the maker's share is the rounded-up proportional
/// claim, never exceeds the lock, and the share plus the relocked remainder is exactly the lock.
contract DisputeProtectionPolicyV3ShareFuzzTest is Test {
    uint256 internal constant MAX_RELEASE = 1_000_000_000e6;
    uint64 internal constant WINDOW = 14 days;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant SHARE = keccak256("PEER_RELEASE_SHARE");
    bytes32 internal constant ID = keccak256("intent");
    address internal constant TAKER = address(0x11);
    address internal constant RECIPIENT = address(0x22);
    address internal constant DEPOSITOR = address(0x33);

    USDCMock internal token;
    StakeVaultV2 internal vault;
    DisputeProtectionPolicyV3 internal policy;
    NullifierRegistryV3 internal payments;

    function setUp() public {
        vm.warp(1000);
        token = new USDCMock(4 * MAX_RELEASE, "USDC", "USDC");
        vault = new StakeVaultV2(address(this), token);
        payments = new NullifierRegistryV3(new NullifierRegistryV2(new NullifierRegistry()));
        payments.addWritePermission(address(this));
        NullifierRegistry disputes = new NullifierRegistry();
        OrchestratorRegistry orchestrators = new OrchestratorRegistry();
        orchestrators.addOrchestrator(address(this));
        policy = new DisputeProtectionPolicyV3(
            address(this),
            vault,
            new DisputeVerifierV2(address(this), payments, new AttestationVerifierMock()),
            new ReceiptVerifier(address(this), payments, new AttestationVerifierMock()),
            disputes,
            orchestrators
        );
        disputes.addWritePermission(address(policy));
        vault.setController(address(policy), true);
        token.transfer(TAKER, MAX_RELEASE);
        vm.prank(TAKER);
        token.approve(address(vault), type(uint256).max);
    }

    function testFuzz_ShareDisputeSplitsTheLockExactly(
        uint256 rawRelease,
        uint256 rawLock,
        uint256 claim,
        bool deferredPayout
    ) public {
        uint256 releaseAmount = bound(rawRelease, 1, MAX_RELEASE);
        uint256 lockAmount = deferredPayout ? bound(rawLock, 1, releaseAmount) : releaseAmount;
        claim = bound(claim, 1, type(uint256).max);
        _settle(releaseAmount, lockAmount, deferredPayout);

        policy.submitDispute(_shareDispute(claim));

        uint256 share = vault.claimable(DEPOSITOR);
        (address lockOwner, uint256 remainder, uint64 maturesAt) = vault.locks(ID);
        uint256 claimed = claim < releaseAmount ? claim : releaseAmount;
        assertLe(share, lockAmount);
        assertEq(share + remainder, lockAmount);
        assertGe(share * releaseAmount, lockAmount * claimed);
        assertLt((share - 1) * releaseAmount, lockAmount * claimed);
        if (claim >= releaseAmount) assertEq(share, lockAmount);

        P.Protection memory protection = policy.getProtection(ID);
        assertEq(protection.depositor != address(0), remainder != 0);
        assertEq(protection.partiallyDisputed, remainder != 0);
        if (remainder != 0) {
            assertEq(lockOwner, deferredPayout ? RECIPIENT : TAKER);
            assertEq(maturesAt, 1000 + WINDOW);
        }
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
    }

    function _settle(uint256 _releaseAmount, uint256 _lockAmount, bool _deferredPayout) internal {
        if (!_deferredPayout) {
            vm.prank(TAKER);
            vault.depositStake(_releaseAmount);
        }
        S.SettlementContext memory context = S.SettlementContext(
            ID, address(token), TAKER, RECIPIENT, DEPOSITOR, METHOD, _releaseAmount, _lockAmount, abi.encode(uint256(WINDOW))
        );
        policy.settleIntent(context);
        if (_deferredPayout) {
            token.transfer(address(vault), _lockAmount);
            policy.onDeferredPayoutFunded(context);
        }
    }

    function _shareDispute(uint256 _claim) internal returns (IDisputeVerifier.DisputeAttestation memory) {
        bytes32 nullifier = keccak256("payment-nullifier");
        payments.addNullifier(nullifier, ID);
        bytes32[] memory candidates = new bytes32[](1);
        candidates[0] = nullifier;
        bytes memory data = abi.encode(
            IDisputeVerifier.DisputeDetails(METHOD, keccak256("payment-id"), keccak256("dispute"), _claim, SHARE),
            candidates
        );
        return IDisputeVerifier.DisputeAttestation(ID, keccak256(data), new bytes[](0), data);
    }
}
