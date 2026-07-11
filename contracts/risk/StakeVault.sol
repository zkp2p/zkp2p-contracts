// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IStakeVault } from "../interfaces/IStakeVault.sol";

/**
 * @title StakeVault
 * @notice Holds USDC collateral without iterating over a user's positions.
 * @dev Every intent is an independently checkpointable position. Users choose which matured
 *      positions to checkpoint, making gas cost proportional to the batch they submit rather
 *      than to lifetime protocol usage.
 */
contract StakeVault is Ownable, ReentrancyGuard, IStakeVault {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;

    enum PositionStatus {
        None,
        Reserved,
        Active,
        Abandoned,
        Matured,
        ChargedBack
    }

    struct Position {
        address manager;
        address taker;
        address maker;
        bytes32 paymentMethod;
        uint256 bondAmount;
        uint256 reservedRiskAmount;
        uint256 activatedRiskAmount;
        uint256 releasedRiskAmount;
        uint256 slashedRiskAmount;
        uint64 activatedAt;
        bool chargebackClaimOpen;
        bool reputationHoldOpen;
        MaturitySchedule schedule;
        PositionStatus status;
    }

    IERC20 public immutable override stakeToken;
    mapping(address => bool) public authorizedManagers;
    mapping(address => uint256) public balances;
    mapping(address => uint256) public reservedBalances;
    mapping(address => uint256) public lockedBalances;
    mapping(bytes32 => Position) public positions;
    mapping(bytes32 => bool) public usedIntentHashes;
    mapping(address => uint256) public override openChargebackClaims;
    mapping(address => uint256) public override reputationHolds;

    event AuthorizedManagerUpdated(address indexed manager, bool authorized);
    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, address indexed recipient, uint256 amount);
    event CollateralReserved(
        bytes32 indexed intentHash,
        address indexed taker,
        address indexed maker,
        uint256 bondAmount,
        uint256 riskAmount
    );
    event ReservationAbandoned(bytes32 indexed intentHash, uint256 bondSlashed, address indexed maker);
    event ExposureActivated(
        bytes32 indexed intentHash,
        address indexed taker,
        uint256 riskAmount,
        uint256 activatedAt
    );
    event ExposureCheckpointed(bytes32 indexed intentHash, uint256 releasedAmount, uint256 remainingLocked);
    event ChargebackPaid(bytes32 indexed intentHash, address indexed maker, uint256 amount);
    event ChargebackClaimStatusUpdated(bytes32 indexed intentHash, address indexed taker, bool open);
    event ReputationHoldStatusUpdated(bytes32 indexed intentHash, address indexed taker, bool open);

    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedManager(address caller);
    error InsufficientAvailableStake(address account, uint256 available, uint256 required);
    error IntentHashAlreadyUsed(bytes32 intentHash);
    error InvalidPositionStatus(bytes32 intentHash, PositionStatus status);
    error InvalidMaturitySchedule();
    error RiskAmountExceedsReservation(uint256 requested, uint256 reserved);
    error InvalidSlashBps(uint256 slashBps);
    error UnauthorizedPositionOwner(address caller, address owner);
    error ReputationHoldNotFound(bytes32 intentHash);
    error ChargebackClaimNotFound(bytes32 intentHash);

    modifier onlyManager() {
        if (!authorizedManagers[msg.sender]) revert UnauthorizedManager(msg.sender);
        _;
    }

    constructor(address owner_, IERC20 stakeToken_) {
        if (owner_ == address(0) || address(stakeToken_) == address(0)) revert ZeroAddress();
        stakeToken = stakeToken_;
        transferOwnership(owner_);
    }

    function setAuthorizedManager(address manager, bool authorized) external onlyOwner {
        if (manager == address(0)) revert ZeroAddress();
        authorizedManagers[manager] = authorized;
        emit AuthorizedManagerUpdated(manager, authorized);
    }

    /** @notice Adds freely withdrawable stake to the caller's balance. */
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        balances[msg.sender] += amount;
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /** @notice Withdraws stake that is neither reserved nor locked by active chargeback exposure. */
    function withdraw(uint256 amount, address recipient) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 available = availableBalance(msg.sender);
        if (amount > available) revert InsufficientAvailableStake(msg.sender, available, amount);

        balances[msg.sender] -= amount;
        stakeToken.safeTransfer(recipient, amount);
        emit Withdrawn(msg.sender, recipient, amount);
    }

    function availableBalance(address account) public view returns (uint256) {
        return balances[account] - reservedBalances[account] - lockedBalances[account];
    }

    /** @notice Reserves free collateral for a newly signaled intent. */
    function reserve(
        bytes32 intentHash,
        address taker,
        address maker,
        bytes32 paymentMethod,
        uint256 bondAmount,
        uint256 riskAmount
    ) external override onlyManager {
        if (taker == address(0) || maker == address(0)) revert ZeroAddress();
        if (usedIntentHashes[intentHash]) revert IntentHashAlreadyUsed(intentHash);

        uint256 required = bondAmount + riskAmount;
        uint256 available = availableBalance(taker);
        if (required > available) revert InsufficientAvailableStake(taker, available, required);

        usedIntentHashes[intentHash] = true;
        reservedBalances[taker] += required;
        positions[intentHash] = Position({
            manager: msg.sender,
            taker: taker,
            maker: maker,
            paymentMethod: paymentMethod,
            bondAmount: bondAmount,
            reservedRiskAmount: riskAmount,
            activatedRiskAmount: 0,
            releasedRiskAmount: 0,
            slashedRiskAmount: 0,
            activatedAt: 0,
            chargebackClaimOpen: false,
            reputationHoldOpen: false,
            schedule: MaturitySchedule({
                cliffSeconds: 0,
                stepTwoSeconds: 0,
                finalMaturitySeconds: 0,
                retentionBpsAfterCliff: 0,
                retentionBpsAfterStepTwo: 0
            }),
            status: PositionStatus.Reserved
        });

        emit CollateralReserved(intentHash, taker, maker, bondAmount, riskAmount);
    }

    /** @notice Converts a reservation into a maturing chargeback exposure. */
    function activate(
        bytes32 intentHash,
        uint256 activatedRiskAmount,
        MaturitySchedule calldata schedule
    ) external override {
        Position storage position = positions[intentHash];
        _validatePositionManager(position);
        if (position.status != PositionStatus.Reserved) {
            revert InvalidPositionStatus(intentHash, position.status);
        }
        if (activatedRiskAmount > position.reservedRiskAmount) {
            revert RiskAmountExceedsReservation(activatedRiskAmount, position.reservedRiskAmount);
        }
        if (activatedRiskAmount > 0) _validateSchedule(schedule);

        uint256 totalReservation = position.bondAmount + position.reservedRiskAmount;
        reservedBalances[position.taker] -= totalReservation;

        position.bondAmount = 0;
        position.activatedRiskAmount = activatedRiskAmount;
        position.activatedAt = uint64(block.timestamp);
        position.schedule = schedule;

        if (activatedRiskAmount == 0) {
            position.status = PositionStatus.Matured;
        } else {
            lockedBalances[position.taker] += activatedRiskAmount;
            position.status = PositionStatus.Active;
        }

        emit ExposureActivated(intentHash, position.taker, activatedRiskAmount, block.timestamp);
    }

    /** @notice Resolves a reservation and optionally credits its slashed bond to the maker. */
    function abandon(bytes32 intentHash, uint16 bondSlashBps)
        external
        override
        nonReentrant
        returns (uint256 slashedBond)
    {
        if (bondSlashBps > BPS) revert InvalidSlashBps(bondSlashBps);
        Position storage position = positions[intentHash];
        _validatePositionManager(position);
        if (position.status != PositionStatus.Reserved) {
            revert InvalidPositionStatus(intentHash, position.status);
        }

        uint256 totalReservation = position.bondAmount + position.reservedRiskAmount;
        reservedBalances[position.taker] -= totalReservation;
        slashedBond = (position.bondAmount * bondSlashBps) / BPS;
        if (slashedBond > 0) {
            balances[position.taker] -= slashedBond;
            balances[position.maker] += slashedBond;
        }

        position.status = PositionStatus.Abandoned;
        _openReputationHold(intentHash, position);
        emit ReservationAbandoned(intentHash, slashedBond, position.maker);
    }

    /**
     * @notice Releases collateral that has matured under the position's transparent step schedule.
     * @return releasedAmount Amount newly made withdrawable.
     */
    function checkpoint(bytes32 intentHash) public returns (uint256 releasedAmount) {
        Position storage position = positions[intentHash];
        if (position.status != PositionStatus.Active) {
            revert InvalidPositionStatus(intentHash, position.status);
        }

        uint256 currentLocked = position.activatedRiskAmount
            - position.releasedRiskAmount
            - position.slashedRiskAmount;
        uint256 requiredLocked = _requiredLocked(position);
        if (requiredLocked < currentLocked) {
            releasedAmount = currentLocked - requiredLocked;
            position.releasedRiskAmount += releasedAmount;
            lockedBalances[position.taker] -= releasedAmount;
        }
        if (requiredLocked == 0) position.status = PositionStatus.Matured;

        emit ExposureCheckpointed(intentHash, releasedAmount, requiredLocked);
    }

    /** @notice Checkpoints caller-owned positions in a bounded caller-selected batch. */
    function checkpointMany(bytes32[] calldata intentHashes) external returns (uint256 totalReleased) {
        for (uint256 i = 0; i < intentHashes.length; ++i) {
            Position storage position = positions[intentHashes[i]];
            if (position.taker != msg.sender) revert UnauthorizedPositionOwner(msg.sender, position.taker);
            if (position.status == PositionStatus.Active) {
                totalReleased += checkpoint(intentHashes[i]);
            }
        }
    }

    /** @notice Credits a proven chargeback from the still-locked portion of a position. */
    function resolveChargeback(bytes32 intentHash, uint256 amount, bool finalClaim)
        external
        override
        nonReentrant
        returns (uint256 paidToMaker)
    {
        Position storage position = positions[intentHash];
        _validatePositionManager(position);
        if (position.status != PositionStatus.Active && position.status != PositionStatus.Matured) {
            revert InvalidPositionStatus(intentHash, position.status);
        }

        _openReputationHold(intentHash, position);

        uint256 currentLocked;
        if (position.status == PositionStatus.Active) {
            currentLocked = position.activatedRiskAmount
                - position.releasedRiskAmount
                - position.slashedRiskAmount;
            uint256 requiredLocked = _requiredLocked(position);
            if (requiredLocked < currentLocked) {
                uint256 newlyMatured = currentLocked - requiredLocked;
                position.releasedRiskAmount += newlyMatured;
                lockedBalances[position.taker] -= newlyMatured;
                currentLocked = requiredLocked;
            }
        }

        paidToMaker = Math.min(amount, currentLocked);
        position.slashedRiskAmount += paidToMaker;
        if (paidToMaker > 0) {
            balances[position.taker] -= paidToMaker;
            lockedBalances[position.taker] -= paidToMaker;
            balances[position.maker] += paidToMaker;
        }

        uint256 remainingLocked = currentLocked - paidToMaker;
        if (finalClaim) {
            // The Attestor has now accounted for the full release amount, so collateral above
            // the final compensated claim is no longer exposed and becomes freely withdrawable.
            if (remainingLocked > 0) {
                position.releasedRiskAmount += remainingLocked;
                lockedBalances[position.taker] -= remainingLocked;
            }
            if (position.chargebackClaimOpen) {
                position.chargebackClaimOpen = false;
                openChargebackClaims[position.taker] -= 1;
                emit ChargebackClaimStatusUpdated(intentHash, position.taker, false);
            }
            position.status = PositionStatus.ChargedBack;
        } else if (remainingLocked == 0) {
            position.status = PositionStatus.Matured;
        }
        if (!finalClaim && !position.chargebackClaimOpen) {
            position.chargebackClaimOpen = true;
            openChargebackClaims[position.taker] += 1;
            emit ChargebackClaimStatusUpdated(intentHash, position.taker, true);
        }

        emit ChargebackPaid(intentHash, position.maker, paidToMaker);
    }

    /**
     * @notice Clears the durable account hold after the position manager synchronizes its
     *         negative reputation update. Exact manager authorization survives manager rotation.
     */
    function clearReputationHold(bytes32 intentHash) external override {
        Position storage position = positions[intentHash];
        _validatePositionManager(position);
        if (!position.reputationHoldOpen) revert ReputationHoldNotFound(intentHash);

        position.reputationHoldOpen = false;
        reputationHolds[position.taker] -= 1;
        emit ReputationHoldStatusUpdated(intentHash, position.taker, false);
    }

    /** @notice Closes only the access hold; it never releases the position's collateral. */
    function closeChargebackClaim(bytes32 intentHash) external override {
        Position storage position = positions[intentHash];
        _validatePositionManager(position);
        if (!position.chargebackClaimOpen) revert ChargebackClaimNotFound(intentHash);

        position.chargebackClaimOpen = false;
        openChargebackClaims[position.taker] -= 1;
        emit ChargebackClaimStatusUpdated(intentHash, position.taker, false);
    }

    function getRequiredLocked(bytes32 intentHash) external view returns (uint256) {
        Position storage position = positions[intentHash];
        if (position.status != PositionStatus.Active) return 0;
        return _requiredLocked(position);
    }

    function hasReputationHold(bytes32 intentHash) external view override returns (bool) {
        return positions[intentHash].reputationHoldOpen;
    }

    function hasOpenChargebackClaim(bytes32 intentHash) external view override returns (bool) {
        return positions[intentHash].chargebackClaimOpen;
    }

    function _requiredLocked(Position storage position) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - position.activatedAt;
        uint256 retentionBps;
        if (elapsed < position.schedule.cliffSeconds) {
            retentionBps = BPS;
        } else if (elapsed < position.schedule.stepTwoSeconds) {
            retentionBps = position.schedule.retentionBpsAfterCliff;
        } else if (elapsed < position.schedule.finalMaturitySeconds) {
            retentionBps = position.schedule.retentionBpsAfterStepTwo;
        } else {
            retentionBps = 0;
        }
        uint256 nominalRequired = (position.activatedRiskAmount * retentionBps) / BPS;
        uint256 actualRemaining = position.activatedRiskAmount
            - position.releasedRiskAmount
            - position.slashedRiskAmount;
        return Math.min(nominalRequired, actualRemaining);
    }

    function _validateSchedule(MaturitySchedule calldata schedule) internal pure {
        if (
            schedule.cliffSeconds == 0
                || schedule.stepTwoSeconds <= schedule.cliffSeconds
                || schedule.finalMaturitySeconds <= schedule.stepTwoSeconds
                || schedule.retentionBpsAfterCliff > BPS
                || schedule.retentionBpsAfterStepTwo > schedule.retentionBpsAfterCliff
        ) revert InvalidMaturitySchedule();
    }

    function _validatePositionManager(Position storage position) internal view {
        if (position.manager != msg.sender) revert UnauthorizedManager(msg.sender);
    }

    function _openReputationHold(bytes32 intentHash, Position storage position) internal {
        if (!position.reputationHoldOpen) {
            position.reputationHoldOpen = true;
            reputationHolds[position.taker] += 1;
            emit ReputationHoldStatusUpdated(intentHash, position.taker, true);
        }
    }
}
