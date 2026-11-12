// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IBondedArbitrator} from "./interfaces/IBondedArbitrator.sol";
import {IEscrow} from "./interfaces/IEscrow.sol";
import {INonPaymentVerifier} from "./interfaces/INonPaymentVerifier.sol";
import {INullifierRegistryV2} from "./interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV4} from "./interfaces/IOrchestratorV4.sol";
import {IStakeVaultV2} from "./interfaces/IStakeVaultV2.sol";

/**
 * @title BondedArbitrator
 * @notice OrchestratorV4 arbitrator that releases an intent only against locked stake. An operator releases funds
 * to the intent recipient against a required platform transaction id and locks the same amount of its bond owner's
 * StakeVaultV2 stake for the payment method's
 * dispute window. The depositor takes the share of that stake a signed scan of the seller account shows was never
 * paid: all of it when nothing matching arrived, the shortfall when less arrived. Otherwise the stake unlocks at
 * maturity, or earlier when the depositor confirms the payment.
 * @dev The signal policy names this contract as the intent arbitrator. It exposes only release, so the arbitrator's
 * cancel and extend powers stay unused. Authorize it as a StakeVaultV2 controller and a NullifierRegistryV2 writer.
 */
contract BondedArbitrator is IBondedArbitrator, Ownable2Step, Pausable, ReentrancyGuard {
    /* ============ Constants ============ */

    uint256 internal constant PRECISE_UNIT = 1e18;
    uint64 public constant MAX_DISPUTE_WINDOW = 90 days;
    uint64 public constant MAX_LOOKBACK = 30 days;
    uint64 public constant MAX_SCAN_AGE = 1 hours;

    /* ============ Immutables ============ */

    IOrchestratorV4 public immutable orchestrator;
    IStakeVaultV2 public immutable stakeVault;
    INullifierRegistryV2 public immutable nullifierRegistry;

    /* ============ State Variables ============ */

    INonPaymentVerifier public nonPaymentVerifier;

    /// @notice Dispute window per payment method; zero disables arbitrated release on that method.
    mapping(bytes32 => uint64) public disputeWindow;

    /// @notice Stake owners governance allows to back releases.
    mapping(address => bool) public isBondOwner;

    /// @notice Bond owner that authorized each operator.
    mapping(address => address) public bondOwnerOf;

    /// @notice Most stake an operator's open releases may hold locked, set by its bond owner.
    mapping(address => uint256) public operatorCap;

    /// @notice Stake currently locked by each operator's open releases.
    mapping(address => uint256) public operatorLocked;

    mapping(bytes32 => Release) internal releases;

    /* ============ Constructor ============ */

    constructor(
        address _owner,
        IOrchestratorV4 _orchestrator,
        IStakeVaultV2 _stakeVault,
        INullifierRegistryV2 _nullifierRegistry,
        INonPaymentVerifier _nonPaymentVerifier
    ) {
        if (
            _owner == address(0) || address(_orchestrator) == address(0) || address(_stakeVault) == address(0)
                || address(_nullifierRegistry) == address(0) || address(_nonPaymentVerifier) == address(0)
        ) revert ZeroAddress();
        orchestrator = _orchestrator;
        stakeVault = _stakeVault;
        nullifierRegistry = _nullifierRegistry;
        nonPaymentVerifier = _nonPaymentVerifier;
        _transferOwnership(_owner);
    }

    /* ============ Operator Functions ============ */

    /// @inheritdoc IBondedArbitrator
    function release(bytes32 _intentHash, uint256 _releaseAmount, PaymentClaim calldata _claim)
        external
        override
        whenNotPaused
        nonReentrant
    {
        address bondOwner = bondOwnerOf[msg.sender];
        if (bondOwner == address(0) || !isBondOwner[bondOwner]) revert UnauthorizedOperator(msg.sender);

        IOrchestratorV4.Intent memory intent = orchestrator.getIntent(_intentHash);
        if (intent.arbitrator != address(this)) revert NotArbitrator(_intentHash);
        uint64 window = disputeWindow[intent.paymentMethod];
        if (window == 0) revert ArbitrationDisabled(intent.paymentMethod);
        _validateClaim(intent, _releaseAmount, _claim);

        IEscrow.Deposit memory deposit = IEscrow(intent.escrow).getDeposit(intent.depositId);
        if (address(deposit.token) != address(stakeVault.stakeToken())) revert UnsupportedToken(address(deposit.token));

        uint256 locked = operatorLocked[msg.sender] + _releaseAmount;
        if (locked > operatorCap[msg.sender]) revert OperatorCapExceeded(msg.sender, locked, operatorCap[msg.sender]);
        operatorLocked[msg.sender] = locked;

        Release memory opened = Release({
            operator: msg.sender,
            bondOwner: bondOwner,
            depositor: deposit.depositor,
            releasedAt: uint64(block.timestamp),
            paymentMethod: intent.paymentMethod,
            payeeId: intent.payeeId,
            fiatCurrency: intent.fiatCurrency,
            claim: _claim
        });
        releases[_intentHash] = opened;

        // The required transaction id backs one intent only, across verified fulfilments and arbitrated releases.
        nullifierRegistry.addNullifier(keccak256(abi.encodePacked(intent.paymentMethod, _claim.txIdHash)), _intentHash);
        // The vault rejects a zero amount and the escrow rejects more than the intent holds.
        uint64 maturesAt = uint64(block.timestamp) + window;
        stakeVault.lockStake(bondOwner, _lockId(_intentHash), _releaseAmount, maturesAt);
        orchestrator.releaseFundsToPayer(_intentHash, _releaseAmount);

        emit ArbitratedRelease(_intentHash, msg.sender, bondOwner, _releaseAmount, maturesAt, opened);
    }

    /* ============ Depositor and Permissionless Functions ============ */

    /// @inheritdoc IBondedArbitrator
    /// @dev Anyone may submit: the scan is bound to the deposit's payee and the award always goes to the depositor.
    function disputeNonPayment(INonPaymentVerifier.NonPaymentAttestation calldata _attestation)
        external
        override
        nonReentrant
    {
        bytes32 intentHash = _attestation.intentHash;
        Release memory open = _openRelease(intentHash);

        (, uint256 amount, uint64 maturesAt) = stakeVault.locks(_lockId(intentHash));
        if (block.timestamp >= maturesAt) revert DisputeWindowClosed(maturesAt);

        INonPaymentVerifier.NonPaymentDetails memory scan = nonPaymentVerifier.verifyNonPayment(_attestation);
        if (
            scan.paymentMethod != open.paymentMethod || scan.payeeId != open.payeeId
                || scan.fiatCurrency != open.fiatCurrency || scan.windowStart > open.claim.paidAfter
                || scan.windowEnd < open.releasedAt || scan.claimedAmount != open.claim.amount
                || scan.payerHash != open.claim.payerHash || scan.txIdHash != open.claim.txIdHash
        ) revert ScanMismatch(intentHash);
        // The scan must reach the present, so a payment that arrived after release still defeats the dispute.
        if (uint256(scan.windowEnd) + MAX_SCAN_AGE < block.timestamp) revert StaleEvidence(scan.windowEnd);
        // A skipped payment must already back another intent, such as the same buyer's later verified order.
        for (uint256 i = 0; i < scan.excludedPaymentIds.length; i++) {
            bytes32 boundTo = nullifierRegistry.intentHashByNullifier(
                keccak256(abi.encodePacked(open.paymentMethod, scan.excludedPaymentIds[i]))
            );
            if (boundTo == bytes32(0) || boundTo == intentHash) revert UnboundExclusion(scan.excludedPaymentIds[i]);
        }
        // The unpaid share of the release; the vault returns the rest of the lock to the bond owner's free stake.
        // mulDiv keeps any claimed amount disputable, however large the operator made it.
        uint256 owed = scan.receivedAmount >= scan.claimedAmount
            ? 0
            : Math.mulDiv(amount, scan.claimedAmount - scan.receivedAmount, scan.claimedAmount);
        if (owed == 0) revert PaymentCovered(scan.receivedAmount, scan.claimedAmount);
        _close(intentHash, open.operator, amount);
        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](1);
        claims[0] = IStakeVaultV2.Claim({beneficiary: open.depositor, amount: owed});
        stakeVault.resolveLock(_lockId(intentHash), claims);

        emit ReleaseOverturned(intentHash, open.bondOwner, open.depositor, owed, scan.historyHash);
    }

    /// @inheritdoc IBondedArbitrator
    function acknowledge(bytes32 _intentHash) external override nonReentrant {
        Release memory open = _openRelease(_intentHash);
        if (msg.sender != open.depositor) revert UnauthorizedDepositor(msg.sender);
        _unlock(_intentHash, open, true);
    }

    /// @inheritdoc IBondedArbitrator
    function settle(bytes32[] calldata _intentHashes) external override nonReentrant {
        for (uint256 i = 0; i < _intentHashes.length; i++) {
            Release memory open = _openRelease(_intentHashes[i]);
            (,, uint64 maturesAt) = stakeVault.locks(_lockId(_intentHashes[i]));
            if (block.timestamp < maturesAt) revert NotMatured(maturesAt);
            _unlock(_intentHashes[i], open, false);
        }
    }

    /* ============ Bond Owner Functions ============ */

    /// @inheritdoc IBondedArbitrator
    /// @dev Revoking stops new releases only. Open releases keep their lock until dispute or maturity.
    function setOperator(address _operator, uint256 _cap) external override {
        if (!isBondOwner[msg.sender]) revert UnauthorizedBondOwner(msg.sender);
        if (_operator == address(0)) revert ZeroAddress();
        address current = bondOwnerOf[_operator];
        if (current != address(0) && current != msg.sender) revert OperatorTaken(_operator, current);

        if (_cap == 0) {
            delete bondOwnerOf[_operator];
        } else {
            bondOwnerOf[_operator] = msg.sender;
        }
        operatorCap[_operator] = _cap;
        emit OperatorSet(msg.sender, _operator, _cap);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Approves or removes a stake owner that may back releases.
     * @param _bondOwner Stake owner in StakeVaultV2.
     * @param _approved Whether its operators may release.
     */
    function setBondOwner(address _bondOwner, bool _approved) external onlyOwner {
        if (_bondOwner == address(0)) revert ZeroAddress();
        isBondOwner[_bondOwner] = _approved;
        emit BondOwnerSet(_bondOwner, _approved);
    }

    /**
     * @notice GOVERNANCE ONLY: Sets a payment method's dispute window; zero disables arbitrated release on it.
     * @param _paymentMethod Payment method hash.
     * @param _window Seconds a release's bond stays locked.
     */
    function setDisputeWindow(bytes32 _paymentMethod, uint64 _window) external onlyOwner {
        if (_window > MAX_DISPUTE_WINDOW) revert InvalidDisputeWindow(_window);
        disputeWindow[_paymentMethod] = _window;
        emit DisputeWindowSet(_paymentMethod, _window);
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the scan verifier for future disputes.
     * @param _verifier New NonPaymentVerifier.
     */
    function setNonPaymentVerifier(INonPaymentVerifier _verifier) external onlyOwner {
        if (address(_verifier) == address(0)) revert ZeroAddress();
        emit NonPaymentVerifierSet(address(nonPaymentVerifier), address(_verifier));
        nonPaymentVerifier = _verifier;
    }

    /// @notice GOVERNANCE ONLY: Stops new releases. Disputes, acknowledgements and settlement stay open.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice GOVERNANCE ONLY: Resumes releases.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Ownership renunciation is disabled so governance keeps the pause and rail switches.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /// @inheritdoc IBondedArbitrator
    function getRelease(bytes32 _intentHash) external view override returns (Release memory) {
        return releases[_intentHash];
    }

    /// @inheritdoc IBondedArbitrator
    function lockId(bytes32 _intentHash) external view override returns (bytes32) {
        return _lockId(_intentHash);
    }

    /* ============ Internal Functions ============ */

    /// @dev The claim must include a non-zero transaction id hash and cover what is released at the intent's rate.
    function _validateClaim(IOrchestratorV4.Intent memory _intent, uint256 _releaseAmount, PaymentClaim calldata _claim)
        internal
        view
    {
        if (uint256(_claim.paidAfter) + MAX_LOOKBACK < _intent.timestamp || _claim.paidAfter > block.timestamp) {
            revert InvalidClaimWindow(_claim.paidAfter, _intent.timestamp);
        }
        if (_claim.txIdHash == bytes32(0)) revert UnidentifiedPayment();
        uint256 releaseFiatValue = _releaseAmount * _intent.conversionRate / PRECISE_UNIT;
        if (_claim.amount == 0 || _claim.amount < releaseFiatValue) revert ClaimBelowRelease(_claim.amount, releaseFiatValue);
    }

    function _openRelease(bytes32 _intentHash) internal view returns (Release memory open) {
        open = releases[_intentHash];
        if (open.operator == address(0)) revert ReleaseNotFound(_intentHash);
    }

    function _unlock(bytes32 _intentHash, Release memory _open, bool _acknowledged) internal {
        (, uint256 amount,) = stakeVault.locks(_lockId(_intentHash));
        _close(_intentHash, _open.operator, amount);
        stakeVault.unlockStake(_lockId(_intentHash));
        emit ReleaseSettled(_intentHash, _open.bondOwner, _acknowledged);
    }

    function _close(bytes32 _intentHash, address _operator, uint256 _amount) internal {
        delete releases[_intentHash];
        operatorLocked[_operator] -= _amount;
    }

    /// @dev Domain-separated from DisputeProtectionPolicyV2, which locks under the bare intent hash.
    function _lockId(bytes32 _intentHash) internal view returns (bytes32) {
        return keccak256(abi.encode(address(this), _intentHash));
    }
}
