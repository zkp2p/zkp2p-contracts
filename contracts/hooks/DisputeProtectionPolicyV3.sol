// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IDisputeProtectionPolicyV3} from "../interfaces/IDisputeProtectionPolicyV3.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {IIntentSettlementPolicy} from "../interfaces/IIntentSettlementPolicy.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IReceiptVerifier} from "../interfaces/IReceiptVerifier.sol";
import {IStakeVaultV2} from "../interfaces/IStakeVaultV2.sol";

/**
 * @title DisputeProtectionPolicyV3
 * @notice Settles OrchestratorV4 payouts against the taker's stake, or defers them, for the signed dispute window.
 * A proven dispute pays the maker only the unpaid share of the release, and an enclave-signed receipt confirmation
 * releases the hold early.
 * @dev DisputeProtectionPolicyV2 plus the settled release amount, which makes share disputes possible, and a confirmed
 * releaseAt per protection, which makes it due at min(lock maturity, releaseAt). A dispute stays possible until the
 * protection is paid out. The StakeVaultV2 lock under the intent hash holds owner, amount and maturity. Canonical
 * USDC only.
 */
contract DisputeProtectionPolicyV3 is IDisputeProtectionPolicyV3, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ============ Constants ============ */

    uint64 public constant MAX_DISPUTE_WINDOW = 180 days;

    /// @notice Dispute currency whose `paymentAmount` is the maker's claim in release-amount (USDC base) units.
    bytes32 public constant RELEASE_SHARE_CURRENCY = keccak256("PEER_RELEASE_SHARE");

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVaultV2 public immutable override stakeVault;

    /// @notice Dedicated replay registry for payment-method-scoped dispute nullifiers.
    INullifierRegistry public immutable disputeNullifierRegistry;

    /// @notice Orchestrators allowed to call the settlement callbacks.
    IOrchestratorRegistry public immutable orchestratorRegistry;

    /// @notice Verifier used to validate signed dispute evidence.
    IDisputeVerifier public disputeVerifier;

    /// @notice Verifier used to validate signed receipt confirmations.
    IReceiptVerifier public receiptVerifier;

    /// @dev Open protections keyed by globally unique intent hash; deleted on release or dispute.
    mapping(bytes32 => Protection) internal protections;

    /* ============ Constructor ============ */

    /**
     * @notice Creates the policy; authorize it as a vault controller and a dispute-nullifier writer before use.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _stakeVault Vault holding and locking taker collateral.
     * @param _disputeVerifier Verifier for signed dispute evidence.
     * @param _receiptVerifier Verifier for signed receipt confirmations.
     * @param _disputeNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     * @param _orchestratorRegistry Registry of orchestrators allowed to call the settlement callbacks.
     */
    constructor(
        address _owner,
        IStakeVaultV2 _stakeVault,
        IDisputeVerifier _disputeVerifier,
        IReceiptVerifier _receiptVerifier,
        INullifierRegistry _disputeNullifierRegistry,
        IOrchestratorRegistry _orchestratorRegistry
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        stakeVault = _stakeVault;
        disputeVerifier = _disputeVerifier;
        receiptVerifier = _receiptVerifier;
        disputeNullifierRegistry = _disputeNullifierRegistry;
        orchestratorRegistry = _orchestratorRegistry;
        _transferOwnership(_owner);
    }

    /* ============ Modifiers ============ */

    modifier onlyOrchestrator() {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Lifecycle Functions ============ */

    /// @inheritdoc IIntentSettlementPolicy
    /// @dev settlementData is abi.encode(uint256 disputeWindow). Zero windows and non-stake tokens pay now.
    function settleIntent(SettlementContext calldata _context)
        external override onlyOrchestrator returns (address deferralVault)
    {
        uint256 window = abi.decode(_context.settlementData, (uint256));
        if (window > MAX_DISPUTE_WINDOW) revert InvalidDisputeWindow(window);
        if (window == 0) return address(0);
        if (_context.token != address(stakeVault.stakeToken())) return address(0);

        address stakeOwner = stakeVault.stakeOwnerOf(_context.taker);
        bool staked = stakeVault.freeStake(stakeOwner) >= _context.releaseAmount;
        protections[_context.intentHash] = Protection({
            depositor: _context.depositor,
            deferredPayout: !staked,
            releaseAt: 0,
            paymentMethod: _context.paymentMethod,
            releaseAmount: _context.releaseAmount
        });
        if (staked) {
            stakeVault.lockStake(stakeOwner, _context.intentHash, _context.releaseAmount, _maturity(uint64(window)));
        } else {
            deferralVault = address(stakeVault);
        }
        emit ProtectionOpened(_context.intentHash, _context.depositor);
    }

    /// @inheritdoc IIntentSettlementPolicy
    function onDeferredPayoutFunded(SettlementContext calldata _context) external override onlyOrchestrator nonReentrant {
        uint64 window = uint64(abi.decode(_context.settlementData, (uint256)));
        stakeVault.fundLock(_context.recipient, _context.intentHash, _context.netAmount, _maturity(window));
    }

    /* ============ Permissionless Functions ============ */

    /// @inheritdoc IDisputeProtectionPolicyV3
    function release(bytes32[] calldata _intentHashes) external override nonReentrant {
        for (uint256 i = 0; i < _intentHashes.length; i++) {
            _release(_intentHashes[i]);
        }
    }

    /// @inheritdoc IDisputeProtectionPolicyV3
    function confirmReceipts(IReceiptVerifier.ReceiptAttestation[] calldata _receipts) external override nonReentrant {
        for (uint256 i = 0; i < _receipts.length; i++) {
            _confirmReceipt(_receipts[i]);
        }
    }

    /// @inheritdoc IDisputeProtectionPolicyV3
    /// @dev Reads the claim from the `DisputeDetails` head of the evidence data. The verifier has already checked
    /// that data against the signed hash, and `DisputeDetails` is static, so it is the head of every layout a
    /// DisputeVerifier accepts.
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata _attestation) external override nonReentrant {
        bytes32 intentHash = _attestation.intentHash;
        Protection memory protection = protections[intentHash];
        if (protection.depositor == address(0)) revert ProtectionNotFound(intentHash);

        (bytes32 disputeId, bytes32 disputeNullifier) =
            disputeVerifier.verifyDispute(_attestation, protection.paymentMethod);
        IDisputeVerifier.DisputeDetails memory details =
            abi.decode(_attestation.data, (IDisputeVerifier.DisputeDetails));

        (address stakeOwner, uint256 lockAmount,) = stakeVault.locks(intentHash);
        uint256 compensatedAmount = _compensation(lockAmount, protection.releaseAmount, details);
        if (compensatedAmount == 0) revert ZeroClaim();

        disputeNullifierRegistry.addNullifier(disputeNullifier);
        delete protections[intentHash];

        uint256 remainder = lockAmount - compensatedAmount;
        bool forwardRemainder = protection.deferredPayout && remainder != 0;
        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](forwardRemainder ? 2 : 1);
        claims[0] = IStakeVaultV2.Claim({beneficiary: protection.depositor, amount: compensatedAmount});
        if (forwardRemainder) claims[1] = IStakeVaultV2.Claim({beneficiary: address(this), amount: remainder});
        stakeVault.resolveLock(intentHash, claims);

        emit DisputeResolved(intentHash, stakeOwner, protection.depositor, compensatedAmount, disputeId);
        if (forwardRemainder) _payRemainder(intentHash, stakeOwner, remainder);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future dispute submissions.
     * @param _verifier New dispute verifier.
     */
    function setDisputeVerifier(address _verifier) external onlyOwner {
        address previousVerifier = address(disputeVerifier);
        disputeVerifier = IDisputeVerifier(_verifier);
        emit DisputeVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future receipt confirmations. Rotating it invalidates
     * confirmations signed for the previous verifier but not yet submitted.
     * @param _verifier New receipt verifier.
     */
    function setReceiptVerifier(address _verifier) external onlyOwner {
        address previousVerifier = address(receiptVerifier);
        receiptVerifier = IReceiptVerifier(_verifier);
        emit ReceiptVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice Disables ownership renunciation so governed safety controls cannot become unreachable.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /// @inheritdoc IDisputeProtectionPolicyV3
    function getProtection(bytes32 _intentHash) external view override returns (Protection memory) {
        return protections[_intentHash];
    }

    /* ============ Internal Functions ============ */

    function _release(bytes32 _intentHash) internal {
        Protection storage protection = protections[_intentHash];
        if (protection.depositor == address(0)) revert ProtectionNotFound(_intentHash);

        (,, uint64 maturesAt) = stakeVault.locks(_intentHash);
        uint64 releaseAt = protection.releaseAt;
        uint64 dueAt = releaseAt != 0 && releaseAt < maturesAt ? releaseAt : maturesAt;
        if (block.timestamp < dueAt) revert NotMatured(dueAt, uint64(block.timestamp));

        _payOut(_intentHash, protection.deferredPayout);
    }

    /// @dev Skips stale and repeated entries so one never sinks a keeper's batch; a payout already due is made now
    /// instead of stored.
    function _confirmReceipt(IReceiptVerifier.ReceiptAttestation calldata _receipt) internal {
        bytes32 intentHash = _receipt.intentHash;
        Protection storage protection = protections[intentHash];
        if (protection.depositor == address(0)) {
            emit ReceiptSkipped(intentHash, SkipReason.STALE);
            return;
        }
        if (protection.releaseAt != 0) {
            emit ReceiptSkipped(intentHash, SkipReason.ALREADY_CONFIRMED);
            return;
        }

        uint64 releaseAt = receiptVerifier.verifyReceipt(_receipt, protection.paymentMethod);
        emit ReceiptConfirmed(intentHash, releaseAt);
        if (block.timestamp >= releaseAt) {
            _payOut(intentHash, protection.deferredPayout);
        } else {
            protection.releaseAt = releaseAt;
        }
    }

    /// @dev Closes the protection and hands the whole lock to its owner.
    function _payOut(bytes32 _intentHash, bool _deferredPayout) internal {
        delete protections[_intentHash];
        if (_deferredPayout) {
            stakeVault.payOutLock(_intentHash);
        } else {
            stakeVault.unlockStake(_intentHash);
        }
        emit ProtectionReleased(_intentHash);
    }

    /**
     * @dev The maker's compensation out of a lock. A share dispute's claim is capped at the release amount, so the
     * rounded-up result never exceeds the lock; any other currency claims the whole lock. An open protection always
     * has a nonzero release amount, because the vault rejects zero-amount locks.
     */
    function _compensation(
        uint256 _lockAmount,
        uint256 _releaseAmount,
        IDisputeVerifier.DisputeDetails memory _details
    ) internal pure returns (uint256) {
        if (_details.paymentCurrency != RELEASE_SHARE_CURRENCY) return _lockAmount;
        uint256 claimedShare = Math.min(_details.paymentAmount, _releaseAmount);
        return Math.mulDiv(_lockAmount, claimedShare, _releaseAmount, Math.Rounding.Up);
    }

    /**
     * @dev Withdraws the remainder the vault just credited to this policy and forwards it to the payout recipient,
     * which may be a contract that cannot call the vault. This policy holds no claim or token balance between calls,
     * so the withdrawal must deliver exactly the remainder.
     */
    function _payRemainder(bytes32 _intentHash, address _recipient, uint256 _amount) internal {
        IERC20 token = stakeVault.stakeToken();
        uint256 balanceBefore = token.balanceOf(address(this));
        stakeVault.claim();
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received != _amount) revert RemainderTransferFailed(_amount, received);

        emit RemainderPaid(_intentHash, _recipient, _amount);
        token.safeTransfer(_recipient, _amount);
    }

    function _maturity(uint64 _window) internal view returns (uint64) {
        return uint64(block.timestamp) + _window;
    }
}
