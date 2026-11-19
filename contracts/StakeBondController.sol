// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IStakeBondController} from "./interfaces/IStakeBondController.sol";
import {IStakeVaultV2} from "./interfaces/IStakeVaultV2.sol";

/**
 * @title StakeBondController
 * @notice Locks a fixed bond from the caller's StakeVaultV2 stake for a subject the caller names, such as an account
 *         an integrator admits on the bond. Governance may slash the bond until the owner has given `exitDelay` of
 *         exit notice and taken it back.
 * @dev The vault lock is the bond: this controller stores only exit notices. A locked bond is not free stake, so the
 *      owner cannot withdraw it and other controllers cannot lock it. The vault must authorize this controller;
 *      de-authorizing it freezes every bond until it is authorized again.
 */
contract StakeBondController is IStakeBondController, Ownable2Step {
    /* ============ Constants ============ */

    /// @dev Bonds end by exit or slash, never by maturity; the vault only requires a future value.
    uint64 internal constant NEVER_MATURES = type(uint64).max;

    uint64 public constant MAX_EXIT_DELAY = 365 days;

    /* ============ State Variables ============ */

    IStakeVaultV2 public immutable override stakeVault;

    uint256 public immutable override bondAmount;

    uint64 public immutable override exitDelay;

    /// @dev End of the exit notice keyed by bond id, zero while none was given.
    mapping(bytes32 => uint64) internal exitableAt;

    /* ============ Constructor ============ */

    /**
     * @param _owner Governance owner allowed to slash bonds.
     * @param _stakeVault Vault whose stake bonds lock; it must authorize this controller before the first bond.
     * @param _bondAmount Stake each bond locks, in stake-token units.
     * @param _exitDelay Exit notice, at most `MAX_EXIT_DELAY`.
     */
    constructor(address _owner, IStakeVaultV2 _stakeVault, uint256 _bondAmount, uint64 _exitDelay) {
        if (_owner == address(0) || address(_stakeVault) == address(0)) revert ZeroAddress();
        if (_bondAmount == 0) revert ZeroAmount();
        if (_exitDelay == 0 || _exitDelay > MAX_EXIT_DELAY) revert InvalidExitDelay(_exitDelay);
        stakeVault = _stakeVault;
        bondAmount = _bondAmount;
        exitDelay = _exitDelay;
        _transferOwnership(_owner);
    }

    /* ============ Owner Functions ============ */

    /// @inheritdoc IStakeBondController
    /// @dev The vault reverts unless the caller has `bondAmount` of free stake and no bond on `_subject`.
    function postBond(bytes32 _subject) external override {
        bytes32 id = bondId(msg.sender, _subject);
        stakeVault.lockStake(msg.sender, id, bondAmount, NEVER_MATURES);
        emit BondPosted(msg.sender, _subject, id, bondAmount);
    }

    /// @inheritdoc IStakeBondController
    function requestExit(bytes32 _subject) external override {
        bytes32 id = bondId(msg.sender, _subject);
        if (!_isPosted(id)) revert BondNotFound(id);
        uint64 noticeEnd = exitableAt[id];
        if (noticeEnd != 0) revert ExitAlreadyRequested(id, noticeEnd);

        noticeEnd = uint64(block.timestamp) + exitDelay;
        exitableAt[id] = noticeEnd;
        emit BondExitRequested(msg.sender, _subject, id, noticeEnd);
    }

    /// @inheritdoc IStakeBondController
    function exit(bytes32 _subject) external override {
        bytes32 id = bondId(msg.sender, _subject);
        uint64 noticeEnd = exitableAt[id];
        if (noticeEnd == 0) revert ExitNotRequested(id);
        if (block.timestamp < noticeEnd) revert ExitNotReady(id, noticeEnd, uint64(block.timestamp));

        delete exitableAt[id];
        stakeVault.unlockStake(id);
        emit BondExited(msg.sender, _subject, id);
    }

    /* ============ Governance Functions ============ */

    /// @inheritdoc IStakeBondController
    /// @dev Any part of the bond not claimed returns to the owner's free stake. The beneficiary withdraws its claim
    ///      with `StakeVaultV2.claim`.
    function slash(address _stakeOwner, bytes32 _subject, uint256 _amount, address _beneficiary)
        external
        override
        onlyOwner
    {
        bytes32 id = bondId(_stakeOwner, _subject);
        delete exitableAt[id];

        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](1);
        claims[0] = IStakeVaultV2.Claim({beneficiary: _beneficiary, amount: _amount});
        stakeVault.resolveLock(id, claims);
        emit BondSlashed(_stakeOwner, _subject, id, _beneficiary, _amount);
    }

    /// @notice Ownership renunciation is disabled so bonds always keep a slashing authority.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ Views ============ */

    /// @inheritdoc IStakeBondController
    /// @dev Scoped to this controller, so no other controller's lock id can collide with a bond.
    function bondId(address _stakeOwner, bytes32 _subject) public view override returns (bytes32) {
        return keccak256(abi.encode(address(this), _stakeOwner, _subject));
    }

    /// @inheritdoc IStakeBondController
    function getBond(address _stakeOwner, bytes32 _subject) external view override returns (Bond memory) {
        bytes32 id = bondId(_stakeOwner, _subject);
        return Bond({posted: _isPosted(id), exitableAt: exitableAt[id]});
    }

    /* ============ Internal ============ */

    function _isPosted(bytes32 _bondId) internal view returns (bool) {
        return stakeVault.lockController(_bondId) == address(this);
    }
}
