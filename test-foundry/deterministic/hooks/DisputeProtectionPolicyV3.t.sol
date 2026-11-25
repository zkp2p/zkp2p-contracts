// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DisputeProtectionPolicyV3} from "contracts/hooks/DisputeProtectionPolicyV3.sol";
import {IDisputeProtectionPolicyV3 as P} from "contracts/interfaces/IDisputeProtectionPolicyV3.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IIntentSettlementPolicy as S} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IStakeVaultV2} from "contracts/interfaces/IStakeVaultV2.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {DisputeVerifierV2} from "contracts/unifiedVerifier/DisputeVerifierV2.sol";
import {ReceiptVerifier} from "contracts/unifiedVerifier/ReceiptVerifier.sol";
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";
import {PayoutHookTokenMock} from "../../mocks/PayoutHookTokenMock.sol";
import {ReentrantPayoutRecipientMock} from "../../mocks/ReentrantPayoutRecipientMock.sol";

/// @notice A payout recipient with no code path into the vault.
contract VaultUnawareRecipient {}

/// @notice Burns 1% of every transfer, so a vault payout arrives short.
contract ClaimFeeToken is ERC20 {
    constructor() ERC20("Fee USDC", "fUSDC") {
        _mint(msg.sender, 100_000e6);
    }

    function _transfer(address _from, address _to, uint256 _amount) internal override {
        uint256 fee = _amount / 100;
        super._transfer(_from, _to, _amount - fee);
        _burn(_from, fee);
    }
}

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
    event RemainderPaid(bytes32 indexed intentHash, address indexed recipient, uint256 amount);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    uint64 internal constant WINDOW = 14 days;
    uint256 internal constant GROSS = 100e6;
    uint256 internal constant NET = 99.05e6;
    bytes32 internal constant METHOD = keccak256("paypal");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant SHARE = keccak256("PEER_RELEASE_SHARE");
    bytes32 internal constant ID = keccak256("intent");
    bytes32 internal constant ID2 = keccak256("second");
    address internal constant TAKER = address(0x11);
    address internal constant RECIPIENT = address(0x22);
    address internal constant DEPOSITOR = address(0x33);
    address internal constant STRANGER = address(0x44);
    string internal constant REENTRANT_CALL = "ReentrancyGuard: reentrant call";

    IERC20 internal token;
    StakeVaultV2 internal vault;
    DisputeProtectionPolicyV3 internal policy;
    DisputeVerifierV2 internal verifier;
    ReceiptVerifier internal receipts;
    NullifierRegistry internal disputes;
    NullifierRegistryV3 internal payments;
    OrchestratorRegistry internal orchestrators;

    function setUp() public {
        vm.warp(1000);
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

    function _assertLock(bytes32 id, address owner, uint256 amount, uint256 maturesAt) internal view {
        (address lockOwner, uint256 lockAmount, uint64 lockMaturity) = vault.locks(id);
        assertEq(lockOwner, owner);
        assertEq(lockAmount, amount);
        assertEq(lockMaturity, maturesAt);
    }

    /// @dev The vault holds exactly its liabilities and the policy keeps nothing between calls.
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
        assertEq(protection.releaseAt, 0);
        assertEq(protection.paymentMethod, METHOD);
        assertEq(protection.releaseAmount, GROSS);
        _assertLock(ID, TAKER, GROSS, block.timestamp + WINDOW);
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
        assertEq(protection.releaseAt, 0);
        assertEq(protection.paymentMethod, METHOD);
        assertEq(protection.releaseAmount, GROSS);
        _assertLock(ID, RECIPIENT, NET, block.timestamp + WINDOW);
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
        _assertLock(ID, TAKER, GROSS, block.timestamp + 180 days);
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

    /* ============ Fiat disputes: whole lock (V2 parity) ============ */

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
        vm.recordLogs();
        policy.submitDispute(_dispute(ID, 1, USD));

        assertEq(vault.claimable(DEPOSITOR), NET);
        assertEq(vault.stakeBalance(RECIPIENT), 0);
        assertEq(token.balanceOf(RECIPIENT), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 index; index < logs.length; ++index) {
            assertTrue(logs[index].topics[0] != RemainderPaid.selector);
        }
        _assertNothingStranded();
    }

    /* ============ Share disputes ============ */

    function test_ShareDisputeOnStakePaysShareAndFreesTheRest() public {
        _settleStaked(ID);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeResolved(ID, TAKER, DEPOSITOR, 24e6, _disputeId(ID));
        policy.submitDispute(attestation);

        assertEq(vault.claimable(DEPOSITOR), 24e6);
        assertEq(vault.stakeBalance(TAKER), GROSS - 24e6);
        assertEq(vault.lockedStake(TAKER), 0);
        assertEq(vault.freeStake(TAKER), GROSS - 24e6);
        assertEq(token.balanceOf(TAKER), 0);
        _assertOpen(ID, false);
        _assertLock(ID, address(0), 0, 0);
        _assertNothingStranded();
    }

    /// @dev Spec example: ₹8,000 order, 96 USDC locked, ₹6,000 arrived; the enclave signs ⌈96 × 2,000 ÷ 8,000⌉ = 24.
    function test_SpecExampleHonestPartialPaymentPaysMakerTwentyFour() public {
        _stake(TAKER, 96e6);
        S.SettlementContext memory context = _context(ID, RECIPIENT);
        context.releaseAmount = 96e6;
        policy.settleIntent(context);

        policy.submitDispute(_dispute(ID, 24e6, SHARE));

        assertEq(vault.claimable(DEPOSITOR), 24e6);
        assertEq(vault.freeStake(TAKER), 72e6);
    }

    function test_ShareDisputeOnDeferredPaysDepositorAndRemainderToEoaRecipient() public {
        _stake(RECIPIENT, 10e6);
        _settleDeferred(ID, RECIPIENT);
        uint256 compensation = 23_772_000; // ⌈99.05 × 24 ÷ 100⌉ USDC, exact
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeResolved(ID, RECIPIENT, DEPOSITOR, compensation, _disputeId(ID));
        vm.expectEmit(true, true, false, true, address(policy));
        emit RemainderPaid(ID, RECIPIENT, NET - compensation);
        vm.prank(STRANGER);
        policy.submitDispute(attestation);

        assertEq(vault.claimable(DEPOSITOR), compensation);
        assertEq(token.balanceOf(RECIPIENT), NET - compensation);
        assertEq(vault.stakeBalance(RECIPIENT), 10e6);
        assertEq(vault.freeStake(RECIPIENT), 10e6);
        _assertOpen(ID, false);
        _assertLock(ID, address(0), 0, 0);
        _assertNothingStranded();
    }

    function test_ShareDisputeOnDeferredPaysRemainderToVaultUnawareContract() public {
        address recipient = address(new VaultUnawareRecipient());
        _settleDeferred(ID, recipient);

        policy.submitDispute(_dispute(ID, 24e6, SHARE));

        assertEq(vault.claimable(DEPOSITOR), 23_772_000);
        assertEq(token.balanceOf(recipient), NET - 23_772_000);
        assertEq(vault.stakeBalance(recipient), 0);
        _assertNothingStranded();
    }

    /// @dev The maker's favour: ⌈99.05e6 × 33,333,333 ÷ 100e6⌉ = 33,016,667, where floor would give 33,016,666.
    function test_ShareDisputeRoundsUpForTheMaker() public {
        _settleDeferred(ID, RECIPIENT);
        policy.submitDispute(_dispute(ID, 33_333_333, SHARE));
        assertEq(vault.claimable(DEPOSITOR), 33_016_667);
        assertEq(token.balanceOf(RECIPIENT), NET - 33_016_667);

        _settleDeferred(ID2, RECIPIENT);
        policy.submitDispute(_dispute(ID2, 1, SHARE));
        assertEq(vault.claimable(DEPOSITOR), 33_016_667 + 1);
        assertEq(token.balanceOf(RECIPIENT), 2 * NET - 33_016_667 - 1);
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

            policy.submitDispute(_dispute(deferredId, shares[index], SHARE));
            assertEq(vault.claimable(DEPOSITOR) - claimableBefore, GROSS + NET);
        }
        assertEq(token.balanceOf(RECIPIENT), 0);
        _assertNothingStranded();
    }

    function test_ZeroShareReverts() public {
        _settleDeferred(ID, RECIPIENT);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 0, SHARE);

        vm.expectRevert(P.ZeroClaim.selector);
        policy.submitDispute(attestation);

        _assertOpen(ID, true);
        _assertLock(ID, RECIPIENT, NET, block.timestamp + WINDOW);
        assertFalse(disputes.isNullified(keccak256(abi.encodePacked(METHOD, _disputeId(ID)))));
    }

    function test_DisputeNullifierIsWrittenOnceAndReplayReverts() public {
        _settleStaked(ID);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        policy.submitDispute(attestation);
        assertTrue(disputes.isNullified(keccak256(abi.encodePacked(METHOD, _disputeId(ID)))));

        vm.expectRevert(abi.encodeWithSelector(P.ProtectionNotFound.selector, ID));
        policy.submitDispute(attestation);

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
        vm.warp(block.timestamp + WINDOW);
        policy.release(_ids(ID));
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        vm.expectRevert(abi.encodeWithSelector(P.ProtectionNotFound.selector, ID));
        policy.submitDispute(attestation);
    }

    /// @dev Disputes stay possible until a protection is paid out, maturity included.
    function test_DisputeAfterMaturityBeforeReleaseSucceeds() public {
        _settleDeferred(ID, RECIPIENT);
        vm.warp(block.timestamp + WINDOW + 1 days);
        policy.submitDispute(_dispute(ID, 24e6, SHARE));
        assertEq(vault.claimable(DEPOSITOR), 23_772_000);
    }

    /* ============ Remainder transfer safety ============ */

    /// @dev The recipient re-enters through a token hook during the remainder transfer; every attempt fails on the
    /// guard, and each party is paid exactly once.
    function test_ReentrantRemainderTransferCannotDoublePay() public {
        PayoutHookTokenMock hookToken = new PayoutHookTokenMock();
        _deploy(hookToken);
        ReentrantPayoutRecipientMock recipient = new ReentrantPayoutRecipientMock();
        _settleDeferred(ID, address(recipient));
        _settleDeferred(ID2, address(recipient));
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        IDisputeVerifier.DisputeAttestation memory second = _dispute(ID2, 24e6, SHARE);
        vm.warp(block.timestamp + WINDOW);

        bytes[] memory payloads = new bytes[](3);
        payloads[0] = abi.encodeCall(DisputeProtectionPolicyV3.submitDispute, (attestation));
        payloads[1] = abi.encodeCall(DisputeProtectionPolicyV3.submitDispute, (second));
        payloads[2] = abi.encodeCall(DisputeProtectionPolicyV3.release, (_ids(ID2)));
        recipient.arm(address(policy), payloads);
        hookToken.setHookTarget(address(recipient));

        policy.submitDispute(attestation);

        assertEq(recipient.hookCalls(), 1);
        assertEq(recipient.reentrySuccesses(), 0);
        assertEq(recipient.failureCount(), 3);
        for (uint256 index; index < 3; ++index) {
            assertEq(recipient.failure(index), abi.encodeWithSignature("Error(string)", REENTRANT_CALL));
        }
        assertEq(vault.claimable(DEPOSITOR), 23_772_000);
        assertEq(hookToken.balanceOf(address(recipient)), NET - 23_772_000);
        _assertOpen(ID, false);
        _assertOpen(ID2, true);
        _assertLock(ID2, address(recipient), NET, 1000 + WINDOW);
        _assertNothingStranded();
    }

    /// @dev A stake token that delivers less than the vault releases leaves the policy short of the remainder.
    function test_ShortRemainderDeliveryReverts() public {
        _deploy(new ClaimFeeToken());
        S.SettlementContext memory context = _context(ID, RECIPIENT);
        policy.settleIntent(context);
        token.transfer(address(vault), 2 * NET);
        policy.onDeferredPayoutFunded(context);
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(ID, 24e6, SHARE);
        uint256 remainder = NET - 23_772_000;

        vm.expectRevert(
            abi.encodeWithSelector(P.RemainderTransferFailed.selector, remainder, remainder - remainder / 100)
        );
        policy.submitDispute(attestation);
        _assertOpen(ID, true);
    }

    /* ============ Release ============ */

    function test_ReleaseBeforeMaturityReverts() public {
        _settleDeferred(ID, RECIPIENT);
        vm.warp(block.timestamp + WINDOW - 1);
        vm.expectRevert(
            abi.encodeWithSelector(P.NotMatured.selector, uint64(1000 + WINDOW), uint64(vm.getBlockTimestamp()))
        );
        policy.release(_ids(ID));
    }

    function test_ReleaseUnknownIntentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(P.ProtectionNotFound.selector, ID));
        policy.release(_ids(ID));
    }

    function test_ReleaseAtMaturityPaysDeferredPayoutToRecipient() public {
        _settleDeferred(ID, RECIPIENT);
        vm.warp(block.timestamp + WINDOW);
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
        vm.warp(block.timestamp + WINDOW);
        policy.release(_ids(ID));

        assertEq(vault.lockedStake(TAKER), 0);
        assertEq(vault.freeStake(TAKER), GROSS);
        _assertOpen(ID, false);
    }

    function test_BatchReleaseIsAtomic() public {
        _settleStaked(ID);
        vm.warp(block.timestamp + 1);
        _settleDeferred(ID2, RECIPIENT);
        vm.warp(1000 + WINDOW);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = ID;
        ids[1] = ID2;

        vm.expectRevert(abi.encodeWithSelector(P.NotMatured.selector, uint64(1001 + WINDOW), uint64(1000 + WINDOW)));
        policy.release(ids);
        _assertOpen(ID, true);

        vm.warp(1001 + WINDOW);
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

        vm.expectEmit(true, true, false, true, address(policy));
        emit DisputeVerifierUpdated(address(verifier), address(next));
        policy.setDisputeVerifier(address(next));
        assertEq(address(policy.disputeVerifier()), address(next));
    }

    function test_RenounceDisabled() public {
        vm.expectRevert(P.OwnershipRenunciationDisabled.selector);
        policy.renounceOwnership();
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(P.ZeroAddress.selector);
        new DisputeProtectionPolicyV3(address(0), vault, verifier, receipts, disputes, orchestrators);
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
