// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";
import {BlacklistTokenMock} from "../../mocks/BlacklistTokenMock.sol";
import {PayoutHookTokenMock} from "../../mocks/PayoutHookTokenMock.sol";
import {ReentrantPayoutRecipientMock} from "../../mocks/ReentrantPayoutRecipientMock.sol";

/// @notice A payout recipient with no code path into the vault.
contract VaultUnawareRecipient {}

contract DisputeProtectionPolicyV3Test is Test {
    event ProtectionOpened(bytes32 indexed intentHash, address indexed depositor);
    event ProtectionReleased(bytes32 indexed intentHash);
    event DisputeResolved(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 compensatedAmount,
        bytes32 disputeId
    );
    event RemainderRelocked(bytes32 indexed intentHash, address indexed owner, uint256 amount, uint64 maturesAt);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    uint64 internal constant START = 1000;
    uint64 internal constant WINDOW = 14 days;
    uint64 internal constant MATURES_AT = START + WINDOW;
    uint256 internal constant GROSS = 100e6;
    uint256 internal constant NET = 99.05e6;
    uint256 internal constant DEFERRED_SHARE = 23_772_000; // ⌈99.05 × 24 ÷ 100⌉ USDC, exact
    bytes32 internal constant METHOD = keccak256("paypal");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant SHARE = keccak256("PEER_RELEASE_SHARE");
    bytes32 internal constant ID = keccak256("intent");
    bytes32 internal constant ID2 = keccak256("second");
    bytes32 internal constant REVERSAL_ID = keccak256("reversal-case");
    address internal constant TAKER = address(0x11);
    address internal constant RECIPIENT = address(0x22);
    address internal constant DEPOSITOR = address(0x33);
    address internal constant STRANGER = address(0x44);
    string internal constant REENTRANT_CALL = "ReentrancyGuard: reentrant call";
    string internal constant BLACKLISTED = "Blacklistable: account is blacklisted";

    IERC20 internal token;
    StakeVaultV2 internal vault;
    DisputeProtectionPolicyV3 internal policy;
    DisputeVerifierV2 internal verifier;
    ReceiptVerifier internal receipts;
    NullifierRegistry internal disputes;
    NullifierRegistryV3 internal payments;
    OrchestratorRegistry internal orchestrators;

    function setUp() public {
        vm.warp(START);
        _deploy(new USDCMock(100_000e6, "USDC", "USDC"));
    }

    /* ============ Harness ============ */

    function _deploy(IERC20 _token) internal {
        token = _token;
        vault = new StakeVaultV2(address(this), token);
        payments = new NullifierRegistryV3(new NullifierRegistryV2(new NullifierRegistry()));
        payments.addWritePermission(address(this));
        disputes = new NullifierRegistry();
        verifier = new DisputeVerifierV2(address(this), payments, new AttestationVerifierMock());
        receipts = new ReceiptVerifier(address(this), payments, new AttestationVerifierMock());
        orchestrators = new OrchestratorRegistry();
        orchestrators.addOrchestrator(address(this));
        policy = new DisputeProtectionPolicyV3(address(this), vault, verifier, receipts, disputes, orchestrators);
        disputes.addWritePermission(address(policy));
        vault.setController(address(policy), true);
    }

    function _context(bytes32 id, address recipient) internal view returns (S.SettlementContext memory) {
        return S.SettlementContext(
            id, address(token), TAKER, recipient, DEPOSITOR, METHOD, GROSS, NET, abi.encode(uint256(WINDOW))
        );
    }

    function _stake(address owner, uint256 amount) internal {
        token.transfer(owner, amount);
        vm.startPrank(owner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    function _settleStaked(bytes32 id) internal {
        _stake(TAKER, GROSS);
        assertEq(policy.settleIntent(_context(id, RECIPIENT)), address(0));
    }

    function _settleDeferred(bytes32 id, address recipient) internal {
        S.SettlementContext memory context = _context(id, recipient);
        assertEq(policy.settleIntent(context), address(vault));
        token.transfer(address(vault), NET);
        policy.onDeferredPayoutFunded(context);
    }

    function _disputeId(bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode("dispute", id));
    }

    function _dispute(bytes32 id, uint256 amount, bytes32 currency)
        internal
        returns (IDisputeVerifier.DisputeAttestation memory)
    {
        return _dispute(id, amount, currency, _disputeId(id));
    }

    function _dispute(bytes32 id, uint256 amount, bytes32 currency, bytes32 disputeId)
        internal
        returns (IDisputeVerifier.DisputeAttestation memory)
    {
        bytes32 nullifier = keccak256(abi.encode("payment", id));
        if (payments.intentHashByNullifier(nullifier) == bytes32(0)) payments.addNullifier(nullifier, id);
        bytes32[] memory candidates = new bytes32[](1);
        candidates[0] = nullifier;
        bytes memory data = abi.encode(
            IDisputeVerifier.DisputeDetails(METHOD, keccak256("payment-id"), disputeId, amount, currency), candidates
        );
        return IDisputeVerifier.DisputeAttestation(id, keccak256(data), new bytes[](0), data);
    }

    function _assertOpen(bytes32 id, bool open) internal view {
        assertEq(policy.getProtection(id).depositor != address(0), open);
    }

    function _assertPartiallyDisputed(bytes32 id, bool deferredPayout) internal view {
        P.Protection memory protection = policy.getProtection(id);
        assertEq(protection.depositor, DEPOSITOR);
        assertEq(protection.deferredPayout, deferredPayout);
        assertEq(protection.paymentMethod, METHOD);
        assertEq(protection.releaseAt, 0);
        assertEq(protection.releaseAmount, GROSS);
        assertTrue(protection.partiallyDisputed);
    }

    function _assertLock(bytes32 id, address owner, uint256 amount, uint256 maturesAt) internal view {
        (address lockOwner, uint256 lockAmount, uint64 lockMaturity) = vault.locks(id);
        assertEq(lockOwner, owner);
        assertEq(lockAmount, amount);
        assertEq(lockMaturity, maturesAt);
    }

    /// @dev The vault holds exactly its liabilities and the policy holds nothing.
    function _assertNothingStranded() internal view {
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
        assertEq(token.balanceOf(address(policy)), 0);
        assertEq(vault.claimable(address(policy)), 0);
    }

    function _ids(bytes32 id) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }

    /* ============ Settlement ============ */

    function test_SettleStoresReleaseAmountOnStakedLock() public {
        _stake(TAKER, GROSS);
        vm.expectEmit(true, true, false, true, address(policy));
        emit ProtectionOpened(ID, DEPOSITOR);
        assertEq(policy.settleIntent(_context(ID, RECIPIENT)), address(0));

        P.Protection memory protection = policy.getProtection(ID);
        assertEq(protection.depositor, DEPOSITOR);
        assertFalse(protection.deferredPayout);
        assertEq(protection.paymentMethod, METHOD);
        assertEq(protection.releaseAt, 0);
        assertEq(protection.releaseAmount, GROSS);
        assertFalse(protection.partiallyDisputed);
        _assertLock(ID, TAKER, GROSS, MATURES_AT);
    }

    function test_SettleStoresReleaseAmountOnDeferredPayout() public {
        vm.recordLogs();
        _settleDeferred(ID, RECIPIENT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 policyLogCount;
        for (uint256 index; index < logs.length; ++index) {
            if (logs[index].emitter == address(policy)) ++policyLogCount;
        }
        assertEq(policyLogCount, 1);

        P.Protection memory protection = policy.getProtection(ID);
        assertEq(protection.depositor, DEPOSITOR);
        assertTrue(protection.deferredPayout);
        assertEq(protection.paymentMethod, METHOD);
        assertEq(protection.releaseAt, 0);
        assertEq(protection.releaseAmount, GROSS);
        assertFalse(protection.partiallyDisputed);
        _assertLock(ID, RECIPIENT, NET, MATURES_AT);
    }

    /// @dev A reader that decodes V2's `(depositor, deferredPayout, paymentMethod)` positionally stays correct.
    function test_GetProtectionKeepsV2LeadingOrder() public {
        _settleDeferred(ID, RECIPIENT);
        (bool success, bytes memory returned) =
            address(policy).staticcall(abi.encodeWithSignature("getProtection(bytes32)", ID));
        assertTrue(success);
        assertEq(returned.length, 6 * 32);
        (address depositor, bool deferredPayout, bytes32 paymentMethod) = abi.decode(returned, (address, bool, bytes32));
        assertEq(depositor, DEPOSITOR);
        assertTrue(deferredPayout);
        assertEq(paymentMethod, METHOD);
    }

    function test_SettlementZeroWindowCreatesNoRecord() public {
        S.SettlementContext memory context = _context(ID, RECIPIENT);
        context.settlementData = abi.encode(uint256(0));
        vm.recordLogs();
        vm.record();
        assertEq(policy.settleIntent(context), address(0));
        (, bytes32[] memory writes) = vm.accesses(address(policy));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        _assertOpen(ID, false);
    }

    function test_NonStakeTokenCreatesNoRecord() public {
        S.SettlementContext memory context = _context(ID, RECIPIENT);
        context.token = STRANGER;
        vm.recordLogs();
        assertEq(policy.settleIntent(context), address(0));
        assertEq(vm.getRecordedLogs().length, 0);
        _assertOpen(ID, false);
    }

    function test_SettlementWindowBounded() public {
        S.SettlementContext memory context = _context(ID, RECIPIENT);
        context.settlementData = abi.encode(uint256(180 days + 1));
        vm.expectRevert(abi.encodeWithSelector(P.InvalidDisputeWindow.selector, 180 days + 1));
        policy.settleIntent(context);
        assertEq(policy.MAX_DISPUTE_WINDOW(), 180 days);

        _stake(TAKER, GROSS);
        context.settlementData = abi.encode(uint256(180 days));
        policy.settleIntent(context);
        _assertLock(ID, TAKER, GROSS, START + 180 days);
    }

    function test_LifecycleEntrypointsRequireAuthorizedOrchestrator() public {
        S.SettlementContext memory context = _context(ID, RECIPIENT);
        vm.startPrank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, STRANGER));
        policy.settleIntent(context);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, STRANGER));
        policy.onDeferredPayoutFunded(context);
        vm.stopPrank();
    }

    /* ============ Full disputes: whole lock (V2 parity) ============ */

    function test_FiatDisputeOnStakePaysWholeLock() public {
        _settleStaked(ID);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 100, USD);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeResolved(ID, TAKER, DEPOSITOR, GROSS, _disputeId(ID));
        policy.submitDispute(attestation);

        assertEq(vault.claimable(DEPOSITOR), GROSS);
        assertEq(vault.stakeBalance(TAKER), 0);
        _assertOpen(ID, false);
        _assertLock(ID, address(0), 0, 0);
        assertTrue(disputes.isNullified(keccak256(abi.encodePacked(METHOD, _disputeId(ID)))));
        _assertNothingStranded();
    }

    function test_FiatDisputeOnDeferredPaysWholeLock() public {
        _settleDeferred(ID, RECIPIENT);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 1, USD);
        vm.recordLogs();
        policy.submitDispute(attestation);

        assertEq(vault.claimable(DEPOSITOR), NET);
        assertEq(vault.stakeBalance(RECIPIENT), 0);
        assertEq(token.balanceOf(RECIPIENT), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 index; index < logs.length; ++index) {
            assertTrue(logs[index].topics[0] != RemainderRelocked.selector);
        }
        _assertOpen(ID, false);
        _assertNothingStranded();
    }

    /// @dev A full dispute stays possible after maturity until the protection is released.
    function test_FiatDisputeAfterMaturityBeforeReleaseSucceeds() public {
        _settleDeferred(ID, RECIPIENT);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 1, USD);
        vm.warp(MATURES_AT + 1 days);
        policy.submitDispute(attestation);
        assertEq(vault.claimable(DEPOSITOR), NET);
        _assertOpen(ID, false);
    }

    /* ============ Share disputes ============ */

    function test_ShareDisputeOnStakePaysShareAndRelocksTheRest() public {
        _settleStaked(ID);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeResolved(ID, TAKER, DEPOSITOR, 24e6, _disputeId(ID));
        vm.expectEmit(true, true, false, true, address(policy));
        emit RemainderRelocked(ID, TAKER, GROSS - 24e6, MATURES_AT);
        policy.submitDispute(attestation);

        assertEq(vault.claimable(DEPOSITOR), 24e6);
        assertEq(vault.stakeBalance(TAKER), GROSS - 24e6);
        assertEq(vault.lockedStake(TAKER), GROSS - 24e6);
        assertEq(vault.freeStake(TAKER), 0);
        assertEq(token.balanceOf(TAKER), 0);
        _assertLock(ID, TAKER, GROSS - 24e6, MATURES_AT);
        _assertPartiallyDisputed(ID, false);
        assertTrue(disputes.isNullified(keccak256(abi.encodePacked(METHOD, _disputeId(ID)))));
        _assertNothingStranded();
    }

    /// @dev Spec example: ₹8,000 order, 96 USDC locked, ₹6,000 arrived; the enclave signs ⌈96 × 2,000 ÷ 8,000⌉ = 24.
    /// The other 72 stays locked until maturity, then returns to the stake owner.
    function test_SpecExampleHonestPartialPaymentPaysMakerTwentyFour() public {
        _stake(TAKER, 96e6);
        S.SettlementContext memory context = _context(ID, RECIPIENT);
        context.releaseAmount = 96e6;
        policy.settleIntent(context);

        policy.submitDispute(_dispute(ID, 24e6, SHARE));
        assertEq(vault.claimable(DEPOSITOR), 24e6);
        assertEq(vault.freeStake(TAKER), 0);
        _assertLock(ID, TAKER, 72e6, MATURES_AT);

        vm.warp(MATURES_AT);
        policy.release(_ids(ID));
        assertEq(vault.freeStake(TAKER), 72e6);
        _assertOpen(ID, false);
    }

    function test_ShareDisputeOnDeferredRelocksRemainderForRecipient() public {
        _stake(RECIPIENT, 10e6);
        _settleDeferred(ID, RECIPIENT);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeResolved(ID, RECIPIENT, DEPOSITOR, DEFERRED_SHARE, _disputeId(ID));
        vm.expectEmit(true, true, false, true, address(policy));
        emit RemainderRelocked(ID, RECIPIENT, NET - DEFERRED_SHARE, MATURES_AT);
        vm.prank(STRANGER);
        policy.submitDispute(attestation);

        assertEq(vault.claimable(DEPOSITOR), DEFERRED_SHARE);
        assertEq(token.balanceOf(RECIPIENT), 0);
        assertEq(vault.stakeBalance(RECIPIENT), 10e6 + NET - DEFERRED_SHARE);
        assertEq(vault.freeStake(RECIPIENT), 10e6);
        _assertLock(ID, RECIPIENT, NET - DEFERRED_SHARE, MATURES_AT);
        _assertPartiallyDisputed(ID, true);
        _assertNothingStranded();

        vm.warp(MATURES_AT);
        policy.release(_ids(ID));
        assertEq(token.balanceOf(RECIPIENT), NET - DEFERRED_SHARE);
        assertEq(vault.stakeBalance(RECIPIENT), 10e6);
        _assertOpen(ID, false);
        _assertNothingStranded();
    }

    function test_ReleaseAfterShareDisputePaysOnlyRemainderAtMaturity() public {
        address recipient = address(new VaultUnawareRecipient());
        _settleDeferred(ID, recipient);
        _settleStaked(ID2);
        policy.submitDispute(_dispute(ID, 24e6, SHARE));
        policy.submitDispute(_dispute(ID2, 24e6, SHARE));
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = ID;
        ids[1] = ID2;

        vm.warp(MATURES_AT - 1);
        vm.expectRevert(abi.encodeWithSelector(P.NotMatured.selector, MATURES_AT, MATURES_AT - 1));
        policy.release(ids);

        vm.warp(MATURES_AT);
        policy.release(ids);
        assertEq(token.balanceOf(recipient), NET - DEFERRED_SHARE);
        assertEq(vault.stakeBalance(recipient), 0);
        assertEq(vault.freeStake(TAKER), GROSS - 24e6);
        assertEq(vault.lockedStake(TAKER), 0);
        assertEq(vault.claimable(DEPOSITOR), DEFERRED_SHARE + 24e6);
        _assertOpen(ID, false);
        _assertOpen(ID2, false);
        _assertNothingStranded();
    }

    /// @dev The maker's favour: ⌈99.05e6 × 33,333,333 ÷ 100e6⌉ = 33,016,667, where floor would give 33,016,666.
    function test_ShareDisputeRoundsUpForTheMaker() public {
        _settleDeferred(ID, RECIPIENT);
        policy.submitDispute(_dispute(ID, 33_333_333, SHARE));
        assertEq(vault.claimable(DEPOSITOR), 33_016_667);
        _assertLock(ID, RECIPIENT, NET - 33_016_667, MATURES_AT);

        _settleDeferred(ID2, RECIPIENT);
        policy.submitDispute(_dispute(ID2, 1, SHARE));
        assertEq(vault.claimable(DEPOSITOR), 33_016_667 + 1);
        _assertLock(ID2, RECIPIENT, NET - 1, MATURES_AT);
        _assertNothingStranded();
    }

    function test_ShareAtOrAboveReleasePaysWholeLockNeverMore() public {
        uint256[3] memory shares = [GROSS, GROSS + 1, type(uint256).max];
        for (uint256 index; index < shares.length; ++index) {
            bytes32 stakedId = keccak256(abi.encode("staked", index));
            bytes32 deferredId = keccak256(abi.encode("deferred", index));
            _settleStaked(stakedId);
            _settleDeferred(deferredId, RECIPIENT);

            uint256 claimableBefore = vault.claimable(DEPOSITOR);
            policy.submitDispute(_dispute(stakedId, shares[index], SHARE));
            assertEq(vault.claimable(DEPOSITOR) - claimableBefore, GROSS);
            assertEq(vault.stakeBalance(TAKER), 0);
            _assertOpen(stakedId, false);

            policy.submitDispute(_dispute(deferredId, shares[index], SHARE));
            assertEq(vault.claimable(DEPOSITOR) - claimableBefore, GROSS + NET);
            _assertOpen(deferredId, false);
            _assertLock(deferredId, address(0), 0, 0);
        }
        assertEq(token.balanceOf(RECIPIENT), 0);
        _assertNothingStranded();
    }

    /// @dev Maturity bars only a share dispute that must relock a remainder; a share claim of the whole lock leaves
    /// nothing to relock and is allowed until release, like a full dispute.
    function test_PartialShareDisputeAtOrAfterMaturityReverts() public {
        _settleDeferred(ID, RECIPIENT);
        IDisputeVerifier.DisputeAttestation memory partialClaim = _dispute(ID, 24e6, SHARE);

        vm.warp(MATURES_AT);
        vm.expectRevert(abi.encodeWithSelector(P.ProtectionMatured.selector, ID, MATURES_AT));
        policy.submitDispute(partialClaim);
        vm.warp(MATURES_AT + 30 days);
        vm.expectRevert(abi.encodeWithSelector(P.ProtectionMatured.selector, ID, MATURES_AT));
        policy.submitDispute(partialClaim);
        _assertLock(ID, RECIPIENT, NET, MATURES_AT);

        policy.submitDispute(_dispute(ID, GROSS, SHARE, keccak256("whole")));
        assertEq(vault.claimable(DEPOSITOR), NET);
        _assertOpen(ID, false);
    }

    function test_PartialShareDisputeOneSecondBeforeMaturitySucceeds() public {
        _settleStaked(ID);
        IDisputeVerifier.DisputeAttestation memory partialClaim = _dispute(ID, 24e6, SHARE);
        vm.warp(MATURES_AT - 1);
        policy.submitDispute(partialClaim);
        _assertLock(ID, TAKER, GROSS - 24e6, MATURES_AT);
    }

    function test_SecondShareDisputeReverts() public {
        _settleDeferred(ID, RECIPIENT);
        policy.submitDispute(_dispute(ID, 24e6, SHARE));

        IDisputeVerifier.DisputeAttestation memory another = _dispute(ID, 10e6, SHARE, keccak256("another-scan"));
        vm.expectRevert(abi.encodeWithSelector(P.AlreadyPartiallyDisputed.selector, ID));
        policy.submitDispute(another);
        IDisputeVerifier.DisputeAttestation memory whole = _dispute(ID, GROSS, SHARE, keccak256("whole"));
        vm.expectRevert(abi.encodeWithSelector(P.AlreadyPartiallyDisputed.selector, ID));
        policy.submitDispute(whole);

        assertEq(vault.claimable(DEPOSITOR), DEFERRED_SHARE);
        _assertLock(ID, RECIPIENT, NET - DEFERRED_SHARE, MATURES_AT);
    }

    /// @dev The paid part is reversed later (a card-funded payment charged back, a pending row that failed): a full
    /// dispute takes the whole remaining lock, also after maturity, until release.
    function test_ShareDisputeThenReversalFullDisputeTakesRemainingLock() public {
        _settleDeferred(ID, RECIPIENT);
        _settleStaked(ID2);
        policy.submitDispute(_dispute(ID, 24e6, SHARE));
        policy.submitDispute(_dispute(ID2, 24e6, SHARE));
        IDisputeVerifier.DisputeAttestation memory deferredReversal = _dispute(ID, 1, USD, REVERSAL_ID);
        IDisputeVerifier.DisputeAttestation memory stakedReversal = _dispute(ID2, 1, USD, keccak256("reversal-2"));

        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeResolved(ID, RECIPIENT, DEPOSITOR, NET - DEFERRED_SHARE, REVERSAL_ID);
        policy.submitDispute(deferredReversal);
        vm.warp(MATURES_AT + 1 days);
        policy.submitDispute(stakedReversal);

        assertEq(vault.claimable(DEPOSITOR), NET + GROSS);
        assertEq(vault.stakeBalance(RECIPIENT), 0);
        assertEq(vault.stakeBalance(TAKER), 0);
        assertEq(token.balanceOf(RECIPIENT), 0);
        _assertOpen(ID, false);
        _assertOpen(ID2, false);
        _assertLock(ID, address(0), 0, 0);
        _assertLock(ID2, address(0), 0, 0);
        _assertNothingStranded();
    }

    function test_ZeroShareReverts() public {
        _settleDeferred(ID, RECIPIENT);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 0, SHARE);

        vm.expectRevert(P.ZeroClaim.selector);
        policy.submitDispute(attestation);

        _assertOpen(ID, true);
        _assertLock(ID, RECIPIENT, NET, MATURES_AT);
        assertFalse(disputes.isNullified(keccak256(abi.encodePacked(METHOD, _disputeId(ID)))));
    }

    function test_DisputeNullifierIsWrittenOnceAndReplayReverts() public {
        _settleStaked(ID);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        policy.submitDispute(attestation);
        assertTrue(disputes.isNullified(keccak256(abi.encodePacked(METHOD, _disputeId(ID)))));

        vm.expectRevert(abi.encodeWithSelector(P.AlreadyPartiallyDisputed.selector, ID));
        policy.submitDispute(attestation);
        IDisputeVerifier.DisputeAttestation memory sameIdFull = _dispute(ID, 1, USD, _disputeId(ID));
        vm.expectRevert(bytes("Nullifier already exists"));
        policy.submitDispute(sameIdFull);

        _settleDeferred(ID2, RECIPIENT);
        IDisputeVerifier.DisputeAttestation memory reused = _dispute(ID2, 24e6, SHARE, _disputeId(ID));
        vm.expectRevert(bytes("Nullifier already exists"));
        policy.submitDispute(reused);
        _assertOpen(ID2, true);
    }

    function test_DisputeUnknownIntentReverts() public {
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        vm.expectRevert(abi.encodeWithSelector(P.ProtectionNotFound.selector, ID));
        policy.submitDispute(attestation);
    }

    function test_DisputeAfterReleaseReverts() public {
        _settleDeferred(ID, RECIPIENT);
        vm.warp(MATURES_AT);
        policy.release(_ids(ID));
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 1, USD);
        vm.expectRevert(abi.encodeWithSelector(P.ProtectionNotFound.selector, ID));
        policy.submitDispute(attestation);
    }

    /* ============ Recipients that cannot receive ============ */

    /// @dev A dispute never transfers to the recipient, so a blacklisted recipient cannot block the maker's share or
    /// a later full dispute. Releasing to it still reverts, as on V2.
    function test_ShareDisputeSucceedsForBlacklistedRecipient() public {
        BlacklistTokenMock blacklistToken = new BlacklistTokenMock();
        _deploy(blacklistToken);
        _settleDeferred(ID, RECIPIENT);
        blacklistToken.setBlacklisted(RECIPIENT, true);

        policy.submitDispute(_dispute(ID, 24e6, SHARE));
        assertEq(vault.claimable(DEPOSITOR), DEFERRED_SHARE);
        vm.prank(DEPOSITOR);
        vault.claim();
        assertEq(blacklistToken.balanceOf(DEPOSITOR), DEFERRED_SHARE);

        vm.warp(MATURES_AT);
        vm.expectRevert(bytes(BLACKLISTED));
        policy.release(_ids(ID));

        policy.submitDispute(_dispute(ID, 1, USD, REVERSAL_ID));
        assertEq(vault.claimable(DEPOSITOR), NET - DEFERRED_SHARE);
        _assertOpen(ID, false);
        _assertNothingStranded();
    }

    /// @dev The recipient re-enters through a token hook while `release` pays the relocked remainder; every attempt
    /// fails on the guard and each party is paid exactly once.
    function test_ReentrantRemainderPayoutCannotDoublePay() public {
        PayoutHookTokenMock hookToken = new PayoutHookTokenMock();
        _deploy(hookToken);
        ReentrantPayoutRecipientMock recipient = new ReentrantPayoutRecipientMock();
        _settleDeferred(ID, address(recipient));
        _settleDeferred(ID2, address(recipient));
        policy.submitDispute(_dispute(ID, 24e6, SHARE));
        IDisputeVerifier.DisputeAttestation memory reversal = _dispute(ID, 1, USD, REVERSAL_ID);
        IDisputeVerifier.DisputeAttestation memory second = _dispute(ID2, 1, USD);
        vm.warp(MATURES_AT);

        bytes[] memory payloads = new bytes[](3);
        payloads[0] = abi.encodeCall(DisputeProtectionPolicyV3.submitDispute, (reversal));
        payloads[1] = abi.encodeCall(DisputeProtectionPolicyV3.submitDispute, (second));
        payloads[2] = abi.encodeCall(DisputeProtectionPolicyV3.release, (_ids(ID2)));
        recipient.arm(address(policy), payloads);
        hookToken.setHookTarget(address(recipient));

        policy.release(_ids(ID));

        assertEq(recipient.hookCalls(), 1);
        assertEq(recipient.reentrySuccesses(), 0);
        assertEq(recipient.failureCount(), 3);
        for (uint256 index; index < 3; ++index) {
            assertEq(recipient.failure(index), abi.encodeWithSignature("Error(string)", REENTRANT_CALL));
        }
        assertEq(vault.claimable(DEPOSITOR), DEFERRED_SHARE);
        assertEq(hookToken.balanceOf(address(recipient)), NET - DEFERRED_SHARE);
        _assertOpen(ID, false);
        _assertOpen(ID2, true);
        _assertLock(ID2, address(recipient), NET, MATURES_AT);
        _assertNothingStranded();
    }

    /* ============ Release ============ */

    function test_ReleaseBeforeMaturityReverts() public {
        _settleDeferred(ID, RECIPIENT);
        vm.warp(MATURES_AT - 1);
        vm.expectRevert(abi.encodeWithSelector(P.NotMatured.selector, MATURES_AT, MATURES_AT - 1));
        policy.release(_ids(ID));
    }

    function test_ReleaseUnknownIntentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(P.ProtectionNotFound.selector, ID));
        policy.release(_ids(ID));
    }

    function test_ReleaseAtMaturityPaysDeferredPayoutToRecipient() public {
        _settleDeferred(ID, RECIPIENT);
        vm.warp(MATURES_AT);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ProtectionReleased(ID);
        vm.prank(STRANGER);
        policy.release(_ids(ID));

        assertEq(token.balanceOf(RECIPIENT), NET);
        assertEq(vault.stakeBalance(RECIPIENT), 0);
        _assertOpen(ID, false);
        _assertLock(ID, address(0), 0, 0);
        _assertNothingStranded();
    }

    function test_ReleaseAtMaturityUnlocksStake() public {
        _settleStaked(ID);
        vm.warp(MATURES_AT);
        policy.release(_ids(ID));

        assertEq(vault.lockedStake(TAKER), 0);
        assertEq(vault.freeStake(TAKER), GROSS);
        _assertOpen(ID, false);
    }

    function test_BatchReleaseIsAtomic() public {
        _settleStaked(ID);
        vm.warp(START + 1);
        _settleDeferred(ID2, RECIPIENT);
        vm.warp(MATURES_AT);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = ID;
        ids[1] = ID2;

        vm.expectRevert(abi.encodeWithSelector(P.NotMatured.selector, MATURES_AT + 1, MATURES_AT));
        policy.release(ids);
        _assertOpen(ID, true);

        vm.warp(MATURES_AT + 1);
        policy.release(ids);
        _assertOpen(ID, false);
        _assertOpen(ID2, false);
        assertEq(vault.freeStake(TAKER), GROSS);
        assertEq(token.balanceOf(RECIPIENT), NET);
    }

    /* ============ Governance and views ============ */

    function test_SetDisputeVerifierIsOwnerOnlyAndEmits() public {
        DisputeVerifierV2 next = new DisputeVerifierV2(address(this), payments, new AttestationVerifierMock());
        vm.prank(STRANGER);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setDisputeVerifier(address(next));

        vm.expectRevert(P.ZeroAddress.selector);
        policy.setDisputeVerifier(address(0));
        vm.expectRevert(abi.encodeWithSelector(P.InvalidContract.selector, STRANGER));
        policy.setDisputeVerifier(STRANGER);
        assertEq(address(policy.disputeVerifier()), address(verifier));

        vm.expectEmit(true, true, false, true, address(policy));
        emit DisputeVerifierUpdated(address(verifier), address(next));
        policy.setDisputeVerifier(address(next));
        assertEq(address(policy.disputeVerifier()), address(next));
    }

    function test_RenounceDisabled() public {
        vm.expectRevert(P.OwnershipRenunciationDisabled.selector);
        policy.renounceOwnership();
    }

    function test_ConstructorRejectsZeroOwnerAndMissingVerifiers() public {
        vm.expectRevert(P.ZeroAddress.selector);
        new DisputeProtectionPolicyV3(address(0), vault, verifier, receipts, disputes, orchestrators);

        vm.expectRevert(P.ZeroAddress.selector);
        new DisputeProtectionPolicyV3(address(this), vault, DisputeVerifierV2(address(0)), receipts, disputes, orchestrators);
        vm.expectRevert(abi.encodeWithSelector(P.InvalidContract.selector, STRANGER));
        new DisputeProtectionPolicyV3(address(this), vault, DisputeVerifierV2(STRANGER), receipts, disputes, orchestrators);

        vm.expectRevert(P.ZeroAddress.selector);
        new DisputeProtectionPolicyV3(address(this), vault, verifier, ReceiptVerifier(address(0)), disputes, orchestrators);
        vm.expectRevert(abi.encodeWithSelector(P.InvalidContract.selector, STRANGER));
        new DisputeProtectionPolicyV3(address(this), vault, verifier, ReceiptVerifier(STRANGER), disputes, orchestrators);
    }

    function test_Views() public view {
        assertEq(policy.RELEASE_SHARE_CURRENCY(), SHARE);
        assertEq(policy.MAX_DISPUTE_WINDOW(), 180 days);
        assertEq(address(policy.stakeVault()), address(vault));
        assertEq(address(policy.disputeVerifier()), address(verifier));
        assertEq(address(policy.receiptVerifier()), address(receipts));
        assertEq(address(policy.disputeNullifierRegistry()), address(disputes));
        assertEq(address(policy.orchestratorRegistry()), address(orchestrators));
        assertEq(policy.owner(), address(this));
    }
}
