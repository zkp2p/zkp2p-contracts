// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV2} from "../interfaces/INullifierRegistryV2.sol";
import {IRiskManager} from "../interfaces/IRiskManager.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";

/**
 * @title ChargebackManager
 * @notice Stateful chargeback policy composed into the concrete RiskManager lifecycle coordinator.
 *
 * @dev COVERAGE MODEL
 *      A chargeback-enabled intent is admitted with either existing stake or a deferred payout:
 *
 *      - STAKE_BACKED reserves the complete intent amount from the taker's selected stake owner.
 *      - DEFERRED_PAYOUT reserves no stake at admission and funds complete gross coverage from settlement proceeds.
 *      - UNBONDED creates no coverage and permits ordinary settlement distribution immediately.
 *
 *      Settled coverage always equals the complete gross Escrow release. Clean maturity either unlocks stake-backed
 *      coverage or resolves deferred coverage into the exact settlement fee claims, leaving the executable amount as
 *      payout-recipient-owned free stake. A valid chargeback instead awards the complete lock to the depositor and
 *      discards every contingent fee.
 *
 * @dev COMPOSITION
 *      The concrete RiskManager authenticates Orchestrator callbacks, guards reentrancy, owns common intent status, and
 *      invokes this contract's internal entrypoints in lifecycle order. This module deliberately has no external
 *      admission, cancellation, settlement, maturity, or chargeback entrypoint and cannot bypass the coordinator.
 *      StakeVault remains a shared dependency exposed through `_stakeVault`.
 *
 * @dev EVIDENCE
 *      Chargeback attestations use a manager- and chain-bound EIP-712 digest. The configured `IAttestationVerifier` may
 *      be the exact verifier and offchain signer backend used for payment attestations; chargeback security does not
 *      depend on a distinct verifier instance or signer set. Proof-based settlements additionally bind the original
 *      payment nullifier to the exact intent in both registry directions. Manual releases rely on the signed
 *      intent-bound chargeback payload because they have no payment-verifier call.
 *
 * @dev SECURITY INVARIANTS
 *      1. The raw intent hash identifies chargeback coverage and is never used for intent-extension exposure.
 *      2. Every settled backed position holds coverage equal to its complete gross release.
 *      3. Deferred settlement transfers exactly the gross release from Orchestrator to StakeVault and accepts the
 *         transfer only when the Vault token balance increases by that exact amount.
 *      4. Chargeback and clean maturity are mutually exclusive through the coordinator's common lifecycle status.
 *      5. Dispute identifiers are single-use within their payment method.
 *      6. This module never takes custody of settlement or stake tokens.
 */
abstract contract ChargebackManager is IRiskManager, EIP712 {
    using SafeERC20 for IERC20;

    /* ============ Constants ============ */

    /// @notice Operational ceiling that keeps settlement deadlines safely representable as `uint64`.
    uint64 public constant MAX_RISK_WINDOW = 365 days;

    /// @notice Compatibility getter for the canonical maximum of protocol, referral, and manager fee lines.
    /// @dev Orchestrator validates and constructs the fee plan; this module does not enforce the count independently.
    uint256 public constant MAX_FEE_ALLOCATIONS = 12;

    /// @notice EIP-712 type hash; chain and manager binding are supplied by the domain separator.
    bytes32 public constant CHARGEBACK_ATTESTATION_TYPEHASH =
        keccak256("ChargebackAttestation(bytes32 intentHash,bytes32 dataHash)");

    /// @dev Pending coverage cannot mature without a coordinator lifecycle transition.
    uint64 private constant PENDING_COVERAGE_MATURITY = type(uint64).max;

    /* ============ Chargeback State ============ */

    /**
     * @dev Chargeback-only policy snapshot and accounting for one admitted intent.
     *      Common parties, payment method, intent amount, and lifecycle status remain in the coordinator.
     */
    struct ChargebackPosition {
        address stakeOwner;
        RiskMode mode;
        bool isManualRelease;
        uint64 riskWindow;
        uint64 coverageDeadline;
        uint256 coverageAmount;
        uint256 grossReleasedAmount;
        uint256 executableAmount;
    }

    /// @notice Verifies typed chargeback attestations at submission time.
    /// @dev This may be the same verifier and signer backend used by the unified payment verifier.
    IAttestationVerifier public override attestationVerifier;

    /// @notice Canonical registry binding proof-based payment nullifiers to fulfilled intents.
    INullifierRegistryV2 public immutable override nullifierRegistry;

    /// @dev Mutable chargeback policy for future positions; admitted positions snapshot the applicable values.
    mapping(bytes32 => ChargebackConfig) internal chargebackConfigs;

    /// @dev Chargeback-only per-intent state composed into the coordinator's aggregate position view.
    mapping(bytes32 => ChargebackPosition) internal chargebackPositions;

    /// @dev Contingent fees retained only while deferred-payout coverage remains unresolved.
    mapping(bytes32 => FeeAllocation[]) internal deferredFeeAllocations;

    /// @notice Global replay protection for payment-method-scoped dispute identifiers.
    mapping(bytes32 => bool) public override usedChargebackNullifiers;

    /* ============ Constructor ============ */

    /**
     * @notice Initializes chargeback evidence dependencies and the deployed manager's EIP-712 domain.
     * @dev Both dependencies must be non-zero deployed contracts. They are intentionally independent interfaces, not
     *      independent trust roots: a deployment may supply the same attestation verifier used for payment attestations.
     *      The concrete coordinator owns governance and supplies the shared StakeVault dependency separately.
     * @param _attestationVerifier Initial verifier for signed chargeback evidence.
     * @param _nullifierRegistry Registry binding verified payment nullifiers to fulfilled intents.
     */
    constructor(IAttestationVerifier _attestationVerifier, INullifierRegistryV2 _nullifierRegistry)
        EIP712("ZKP2P RiskManager", "1")
    {
        if (address(_attestationVerifier) == address(0) || address(_nullifierRegistry) == address(0)) {
            revert ZeroAddress();
        }
        if (address(_attestationVerifier).code.length == 0) {
            revert InvalidContract(address(_attestationVerifier));
        }
        if (address(_nullifierRegistry).code.length == 0) {
            revert InvalidContract(address(_nullifierRegistry));
        }

        attestationVerifier = _attestationVerifier;
        nullifierRegistry = _nullifierRegistry;
    }

    /* ============ Internal Admission and Settlement ============ */

    /**
     * @dev Snapshots chargeback policy and reserves admission coverage when configured.
     *
     *      The coordinator must first validate the common intent lifecycle, platform enabled state, deposit token, and
     *      intent guardian. For chargebackable policy, the selected stake owner is preferred when its free stake covers
     *      the complete intent amount. Otherwise deferred payout is selected when enabled. Deferred admission rejects a
     *      post-intent hook because deferred settlement consumes the complete gross release.
     *
     *      Canonical parties and amounts come from the authenticated Orchestrator admission path and are not subjected
     *      to redundant shape or zero-value checks here.
     * @param _intentHash Raw intent hash used as the coverage lock identifier.
     * @param _taker Taker whose selected stake owner may provide admission coverage.
     * @param _payoutRecipient Recipient that will own a future deferred funded lock.
     * @param _paymentMethod Payment method selecting the chargeback policy.
     * @param _intentAmount Complete intent amount requiring admission coverage.
     * @return mode Snapshotted coverage mode.
     * @return stakeOwner Owner of existing or future funded coverage.
     * @return coverageAmount Amount locked at admission, or zero for unbonded and deferred positions.
     * @return riskWindow Snapshotted post-settlement chargeback window.
     */
    function _admitChargeback(
        bytes32 _intentHash,
        address _taker,
        address _payoutRecipient,
        bytes32 _paymentMethod,
        uint256 _intentAmount
    ) internal returns (RiskMode mode, address stakeOwner, uint256 coverageAmount, uint64 riskWindow) {
        IStakeVault vault = _stakeVault();
        ChargebackConfig memory config = chargebackConfigs[_paymentMethod];
        stakeOwner = vault.stakeOwnerOf(_taker);
        mode = RiskMode.UNBONDED;
        riskWindow = config.riskWindow;

        if (config.chargebackable) {
            uint256 available = vault.freeStake(stakeOwner);
            if (available >= _intentAmount) {
                mode = RiskMode.STAKE_BACKED;
                coverageAmount = _intentAmount;
            } else if (config.deferredPayoutEnabled) {
                address postIntentHook = _getPostIntentHook(_intentHash);
                if (postIntentHook != address(0)) {
                    revert DeferredPostIntentHookUnsupported(_intentHash, postIntentHook);
                }
                mode = RiskMode.DEFERRED_PAYOUT;
                stakeOwner = _payoutRecipient;
            } else {
                revert InsufficientCollateral(stakeOwner, available, _intentAmount);
            }
        }

        chargebackPositions[_intentHash] = ChargebackPosition({
            stakeOwner: stakeOwner,
            mode: mode,
            isManualRelease: false,
            riskWindow: riskWindow,
            coverageDeadline: 0,
            coverageAmount: coverageAmount,
            grossReleasedAmount: 0,
            executableAmount: 0
        });

        if (coverageAmount != 0) {
            vault.lockStake(stakeOwner, _intentHash, coverageAmount, PENDING_COVERAGE_MATURITY);
        }
    }

    /**
     * @dev Resolves the chargeback half of a pending cancellation after the coordinator resolves intent-extension
     *      exposure. Stake-backed coverage is unlocked; unbonded and deferred positions have no admission lock.
     *      Contradictory modes revert so corrupted module state cannot silently strand coverage.
     * @param _intentHash Raw intent hash identifying the pending coverage position and lock.
     * @return stakeOwner Snapshotted coverage owner used by the coordinator's cancellation event.
     * @return mode Snapshotted coverage mode.
     * @return releasedCoverage Admission coverage returned to free stake, if any.
     */
    function _cancelChargeback(bytes32 _intentHash)
        internal
        returns (address stakeOwner, RiskMode mode, uint256 releasedCoverage)
    {
        ChargebackPosition storage position = chargebackPositions[_intentHash];
        stakeOwner = position.stakeOwner;
        mode = position.mode;
        releasedCoverage = position.coverageAmount;
        position.coverageAmount = 0;

        if (mode == RiskMode.STAKE_BACKED) {
            _stakeVault().unlockStake(_intentHash);
        } else if (mode != RiskMode.UNBONDED && mode != RiskMode.DEFERRED_PAYOUT) {
            revert PositionModeMismatch(_intentHash, mode);
        }
    }

    /**
     * @dev Applies the chargeback half of settlement after the coordinator resolves intent-extension exposure.
     *
     *      UNBONDED consumes no tokens and requires no later chargeback transition. STAKE_BACKED consumes no tokens and
     *      resizes its existing lock to the complete gross release. DEFERRED_PAYOUT transfers exactly the complete gross
     *      release directly from the calling Orchestrator to StakeVault and creates an equally sized funded lock. The
     *      caller's canonical settlement context is not redundantly shape-validated.
     *
     *      The coordinator must transition its common lifecycle to RELEASED for unbonded mode and SETTLED for either
     *      backed mode after this function returns.
     * @param _context Canonical settlement amount, execution amount, release type, and contingent fee plan.
     * @return stakeOwner Snapshotted coverage owner used by the coordinator's settlement event.
     * @return mode Snapshotted coverage mode.
     * @return coverageAmount Gross amount held through the risk window, or zero for unbonded settlement.
     * @return coverageDeadline Half-open chargeback deadline, or zero for unbonded settlement.
     */
    function _settleChargeback(RiskSettlementContext calldata _context)
        internal
        returns (address stakeOwner, RiskMode mode, uint256 coverageAmount, uint64 coverageDeadline)
    {
        ChargebackPosition storage position = chargebackPositions[_context.intentHash];
        stakeOwner = position.stakeOwner;
        mode = position.mode;
        position.grossReleasedAmount = _context.grossAmount;
        position.executableAmount = _context.executableAmount;
        position.isManualRelease = _context.isManualRelease;

        if (mode == RiskMode.UNBONDED) return (stakeOwner, mode, 0, 0);
        if (mode != RiskMode.STAKE_BACKED && mode != RiskMode.DEFERRED_PAYOUT) {
            revert PositionModeMismatch(_context.intentHash, mode);
        }

        coverageDeadline = _calculateCoverageDeadline(position.riskWindow);
        coverageAmount = _context.grossAmount;
        position.coverageDeadline = coverageDeadline;
        position.coverageAmount = coverageAmount;

        if (mode == RiskMode.STAKE_BACKED) {
            _stakeVault().resizeLock(_context.intentHash, coverageAmount, coverageDeadline);
        } else {
            _fundDeferredCoverage(_context, position, coverageDeadline);
        }
    }

    /* ============ Internal Terminal Accounting ============ */

    /**
     * @dev Releases complete settled coverage at or after its half-open deadline. Stake-backed principal becomes free
     *      stake. Deferred principal resolves into the stored non-zero fee claims while every unallocated unit remains
     *      free stake of the payout recipient. The coordinator must verify and transition common SETTLED status.
     * @param _intentHash Raw intent hash identifying the settled coverage lock.
     * @return stakeOwner Snapshotted coverage owner used by the coordinator's release event.
     * @return mode Snapshotted coverage mode.
     * @return releasedCoverage Complete coverage removed by clean maturity.
     */
    function _releaseMaturedChargeback(bytes32 _intentHash)
        internal
        returns (address stakeOwner, RiskMode mode, uint256 releasedCoverage)
    {
        ChargebackPosition storage position = chargebackPositions[_intentHash];
        uint64 currentTime = _chargebackTimestamp();
        uint64 deadline = position.coverageDeadline;
        if (deadline == 0 || currentTime < deadline) revert PositionNotMature(deadline, currentTime);

        stakeOwner = position.stakeOwner;
        mode = position.mode;
        releasedCoverage = position.coverageAmount;
        position.coverageAmount = 0;

        if (mode == RiskMode.STAKE_BACKED) {
            _stakeVault().unlockStake(_intentHash);
        } else if (mode == RiskMode.DEFERRED_PAYOUT) {
            IStakeVault.Claim[] memory claims = _deferredClaims(_intentHash);
            delete deferredFeeAllocations[_intentHash];
            _stakeVault().resolveLock(_intentHash, claims);
        } else {
            revert PositionModeMismatch(_intentHash, mode);
        }
    }

    /**
     * @dev Validates signed chargeback evidence and resolves complete coverage into one immediately claimable depositor
     *      award. The coordinator must require common SETTLED status before calling and transition it to SLASHED as part
     *      of the same non-reentrant transaction.
     *
     *      The attestation verifier is authoritative for signed payload fields that do not participate in onchain
     *      binding. This module therefore verifies payload integrity, payment method, proof-payment binding, timing,
     *      dispute replay protection, verifier approval, and complete coverage without arbitrary non-zero checks on
     *      informational fields.
     * @param _attestation Intent-bound evidence, payload hash, signatures, and encoded chargeback details.
     * @param _paymentMethod Payment method snapshotted in common coordinator state.
     * @param _depositor Depositor receiving the complete chargeback award.
     * @return stakeOwner Owner whose settled lock is resolved.
     * @return mode Snapshotted backed coverage mode.
     * @return compensatedAmount Complete gross release awarded to the depositor.
     * @return disputeId Signed dispute identifier used by the coordinator's chargeback event.
     */
    function _submitChargeback(ChargebackAttestation calldata _attestation, bytes32 _paymentMethod, address _depositor)
        internal
        returns (address stakeOwner, RiskMode mode, uint256 compensatedAmount, bytes32 disputeId)
    {
        ChargebackPosition storage position = chargebackPositions[_attestation.intentHash];
        mode = position.mode;
        if (mode != RiskMode.STAKE_BACKED && mode != RiskMode.DEFERRED_PAYOUT) {
            revert PositionModeMismatch(_attestation.intentHash, mode);
        }

        bytes32 disputeNullifier;
        (disputeId, disputeNullifier) = _validateChargebackAttestation(_attestation, _paymentMethod, position);
        bytes32 digest = _chargebackAttestationDigest(_attestation);
        if (!attestationVerifier.verify(digest, _attestation.signatures, _attestation.data)) {
            revert AttestationVerificationFailed();
        }

        compensatedAmount = position.grossReleasedAmount;
        if (position.coverageAmount != compensatedAmount) {
            revert IncompleteChargebackCoverage(position.coverageAmount, compensatedAmount);
        }

        usedChargebackNullifiers[disputeNullifier] = true;
        position.coverageAmount = 0;
        delete deferredFeeAllocations[_attestation.intentHash];

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: _depositor, amount: compensatedAmount});
        _stakeVault().resolveLock(_attestation.intentHash, claims);

        stakeOwner = position.stakeOwner;
    }

    /* ============ Internal Governance ============ */

    /**
     * @dev Validates and stores chargeback policy for future admissions. Existing positions retain their snapshots.
     *      A chargeback-enabled method needs a non-zero window of at most one year. A disabled method cannot defer
     *      payout or retain a window because neither value has a reachable settlement transition.
     * @param _paymentMethod Payment method whose future chargeback policy is updated.
     * @param _config Chargeback availability, deferred-payout availability, and coverage window.
     */
    function _setChargebackConfig(bytes32 _paymentMethod, ChargebackConfig calldata _config) internal {
        _validateChargebackConfig(_paymentMethod, _config);
        chargebackConfigs[_paymentMethod] = _config;
    }

    /**
     * @dev Replaces the verifier used for subsequent chargeback submissions, including already settled positions.
     *      Governance may use the same verifier instance as the unified payment verifier. The dependency must be a
     *      non-zero deployed contract; the coordinator owns caller authorization and emits the compatibility event.
     * @param _verifier New attestation verifier dependency.
     * @return previousVerifier Address replaced by this update.
     */
    function _setChargebackAttestationVerifier(IAttestationVerifier _verifier)
        internal
        returns (address previousVerifier)
    {
        if (address(_verifier) == address(0)) revert ZeroAddress();
        if (address(_verifier).code.length == 0) revert InvalidContract(address(_verifier));
        previousVerifier = address(attestationVerifier);
        attestationVerifier = _verifier;
    }

    /* ============ Internal Views ============ */

    /**
     * @dev Returns future-admission chargeback policy for aggregate platform configuration views.
     * @param _paymentMethod Payment method to query.
     * @return Current chargeback policy.
     */
    function _getChargebackConfig(bytes32 _paymentMethod) internal view returns (ChargebackConfig memory) {
        return chargebackConfigs[_paymentMethod];
    }

    /**
     * @dev Returns chargeback-only position state for the coordinator's aggregate position view.
     * @param _intentHash Intent identifier to query.
     * @return Stored chargeback state, or a zero-valued position before admission.
     */
    function _getChargebackPosition(bytes32 _intentHash) internal view returns (ChargebackPosition memory) {
        return chargebackPositions[_intentHash];
    }

    /**
     * @dev Returns contingent non-zero fees retained for one unresolved deferred-payout position.
     * @param _intentHash Deferred-payout intent identifier.
     * @return Exact fee plan that clean maturity will materialize as Vault claims.
     */
    function _getDeferredFeeAllocations(bytes32 _intentHash) internal view returns (FeeAllocation[] memory) {
        return deferredFeeAllocations[_intentHash];
    }

    /**
     * @dev Returns the complete EIP-712 digest approved by chargeback witnesses. The inherited domain binds the digest
     *      to this deployed manager and chain.
     * @param _attestation Attestation whose intent and payload hash are committed.
     * @return Typed-data digest consumed by the configured verifier.
     */
    function _chargebackAttestationDigest(ChargebackAttestation calldata _attestation) internal view returns (bytes32) {
        return _hashTypedDataV4(_chargebackAttestationStructHash(_attestation));
    }

    /* ============ Internal Accounting Helpers ============ */

    /**
     * @dev Moves the complete gross settlement directly from Orchestrator to StakeVault, validates the exact Vault-token
     *      balance increase, then adopts it as payout-recipient-owned locked stake. Deferred admission snapshots that
     *      recipient as the coverage stake owner, so funding does not rely on the repeated settlement-context recipient.
     * @param _context Canonical settlement amount and contingent fee plan.
     * @param _position Deferred chargeback position receiving complete funded coverage.
     * @param _coverageDeadline Half-open chargeback deadline assigned to the funded lock.
     */
    function _fundDeferredCoverage(
        RiskSettlementContext calldata _context,
        ChargebackPosition storage _position,
        uint64 _coverageDeadline
    ) private {
        IStakeVault vault = _stakeVault();
        IERC20 token = vault.stakeToken();
        uint256 balanceBefore = token.balanceOf(address(vault));
        token.safeTransferFrom(msg.sender, address(vault), _context.grossAmount);
        uint256 balanceAfter = token.balanceOf(address(vault));
        uint256 received = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (received != _context.grossAmount) {
            revert DeferredStakeTransferMismatch(_context.grossAmount, received);
        }

        vault.fundLock(_position.stakeOwner, _context.intentHash, _context.grossAmount, _coverageDeadline);
        _storeDeferredFeeAllocations(_context.intentHash, _context.feeAllocations);

        emit DeferredSettlementFunded(
            _context.intentHash,
            _position.stakeOwner,
            _context.grossAmount,
            _context.executableAmount,
            _context.grossAmount - _context.executableAmount,
            _coverageDeadline
        );
    }

    /**
     * @dev Stores only non-zero contingent fees because StakeVault claims must be non-zero. The authenticated
     *      Orchestrator supplies the canonical allocation count, recipients, and values.
     * @param _intentHash Deferred-payout intent receiving the fee plan.
     * @param _feeAllocations Canonical ordered settlement fee allocations.
     */
    function _storeDeferredFeeAllocations(bytes32 _intentHash, FeeAllocation[] calldata _feeAllocations) private {
        delete deferredFeeAllocations[_intentHash];
        for (uint256 feeIndex = 0; feeIndex < _feeAllocations.length; feeIndex++) {
            FeeAllocation calldata allocation = _feeAllocations[feeIndex];
            if (allocation.amount != 0) deferredFeeAllocations[_intentHash].push(allocation);
        }
    }

    /**
     * @dev Converts stored deferred fees into claims. Unallocated coverage remains payout-recipient-owned free stake
     *      when StakeVault resolves the lock.
     * @param _intentHash Deferred-payout intent whose fee plan should vest.
     * @return claims Immediate fee claims for clean maturity.
     */
    function _deferredClaims(bytes32 _intentHash) private view returns (IStakeVault.Claim[] memory claims) {
        FeeAllocation[] storage allocations = deferredFeeAllocations[_intentHash];
        claims = new IStakeVault.Claim[](allocations.length);
        for (uint256 feeIndex = 0; feeIndex < allocations.length; feeIndex++) {
            FeeAllocation storage allocation = allocations[feeIndex];
            claims[feeIndex] = IStakeVault.Claim({beneficiary: allocation.recipient, amount: allocation.amount});
        }
    }

    /* ============ Internal Evidence Validation ============ */

    /**
     * @dev Binds signed evidence to the stored payment method and half-open coverage window. Proof-based settlement also
     *      requires the original payment nullifier to identify this exact intent in both registry directions. Manual
     *      releases skip payment binding because no payment verifier created such a binding. The payment-method-scoped
     *      dispute nullifier must remain unused.
     * @param _attestation Intent-bound signed evidence and encoded chargeback details.
     * @param _paymentMethod Payment method snapshotted by the coordinator.
     * @param _position Settled coverage state constraining timing and proof binding.
     * @return disputeId Signed dispute identifier included in the settlement event.
     * @return disputeNullifier Payment-method-scoped replay identifier.
     */
    function _validateChargebackAttestation(
        ChargebackAttestation calldata _attestation,
        bytes32 _paymentMethod,
        ChargebackPosition storage _position
    ) private view returns (bytes32 disputeId, bytes32 disputeNullifier) {
        if (keccak256(_attestation.data) != _attestation.dataHash) {
            revert InvalidAttestation();
        }
        if (block.timestamp >= _position.coverageDeadline) {
            revert ChargebackWindowClosed(_position.coverageDeadline, _chargebackTimestamp());
        }

        ChargebackDetails memory details = abi.decode(_attestation.data, (ChargebackDetails));
        if (details.paymentMethod != _paymentMethod) revert InvalidAttestation();

        if (!_position.isManualRelease) {
            bytes32 paymentNullifier = keccak256(abi.encodePacked(details.paymentMethod, details.originalPaymentId));
            if (
                nullifierRegistry.intentHashByNullifier(paymentNullifier) != _attestation.intentHash
                    || nullifierRegistry.nullifierByIntentHash(_attestation.intentHash) != paymentNullifier
            ) {
                revert InvalidPaymentBinding(_attestation.intentHash, paymentNullifier);
            }
        }

        disputeId = details.disputeId;
        disputeNullifier = keccak256(abi.encodePacked(details.paymentMethod, details.disputeId));
        if (usedChargebackNullifiers[disputeNullifier]) revert ChargebackEvidenceUsed(disputeNullifier);
    }

    /**
     * @dev Enforces relationships required for bounded chargeback timestamps and reachable terminal states.
     * @param _paymentMethod Payment method included in configuration errors.
     * @param _config Proposed chargeback policy.
     */
    function _validateChargebackConfig(bytes32 _paymentMethod, ChargebackConfig calldata _config) private pure {
        if (_config.chargebackable) {
            if (_config.riskWindow == 0 || _config.riskWindow > MAX_RISK_WINDOW) {
                revert InvalidPlatformConfig(_paymentMethod);
            }
        } else if (_config.deferredPayoutEnabled || _config.riskWindow != 0) {
            revert InvalidPlatformConfig(_paymentMethod);
        }
    }

    /**
     * @dev Produces the EIP-712 struct hash. `_hashTypedDataV4` supplies manager, chain, name, and version binding.
     * @param _attestation Attestation whose intent and data hash are committed.
     * @return EIP-712 chargeback struct hash.
     */
    function _chargebackAttestationStructHash(ChargebackAttestation calldata _attestation)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(CHARGEBACK_ATTESTATION_TYPEHASH, _attestation.intentHash, _attestation.dataHash));
    }

    /**
     * @dev Calculates a bounded half-open chargeback deadline from the current settlement timestamp.
     * @param _riskWindow Snapshotted configured risk window.
     * @return Coverage deadline represented in module storage and StakeVault.
     */
    function _calculateCoverageDeadline(uint64 _riskWindow) private view returns (uint64) {
        uint256 deadline = block.timestamp + _riskWindow;
        if (deadline > type(uint64).max) revert TimestampOverflow(deadline);
        return uint64(deadline);
    }

    /**
     * @dev Returns the current block timestamp after checked narrowing to the stored timestamp width.
     * @return Current EVM timestamp represented as `uint64`.
     */
    function _chargebackTimestamp() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow(block.timestamp);
        return uint64(block.timestamp);
    }

    /**
     * @dev Supplies the coordinator-owned, policy-agnostic custody and accounting ledger.
     * @return Shared StakeVault controlled by the deployed RiskManager.
     */
    function _stakeVault() internal view virtual returns (IStakeVault);

    /**
     * @dev Lazily returns the canonical post-intent hook when deferred admission needs to reject payout routing.
     */
    function _getPostIntentHook(bytes32 _intentHash) internal view virtual returns (address);
}
