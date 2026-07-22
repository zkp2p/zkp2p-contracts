// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIntentRiskHook} from "./IIntentRiskHook.sol";

/**
 * @dev Temporary compile-only surface for the pre-redesign RiskManager. Delete when RiskManager is rewritten.
 */
interface ILegacyStakeVault {
    function acceptController() external;
    function authorizeDeferredStake(bytes32 _intentHash, address _staker, uint64 _releaseTime) external;
    function freeStake(address _staker) external view returns (uint256);
    function increaseReservation(bytes32 _positionId, uint256 _amount, uint64 _releaseTime) external;
    function isExiting(address _staker) external view returns (bool);
    function recordDeferredStake(
        bytes32 _intentHash,
        address _staker,
        uint256 _grossAmount,
        uint64 _releaseTime,
        IIntentRiskHook.FeeAllocation[] calldata _feeAllocations
    ) external;
    function releaseDeferredStake(bytes32 _intentHash) external;
    function releaseDeferredStakeAuthorization(bytes32 _intentHash) external;
    function releaseReservation(bytes32 _intentHash) external;
    function reserveStake(address _staker, bytes32 _intentHash, uint256 _amount, uint64 _releaseTime) external;
    function reservedStake(address _staker) external view returns (uint256);
    function slashDeferredStake(bytes32 _intentHash, address _maker) external;
    function slashReservation(bytes32 _intentHash, address _maker, uint256 _amount) external;
    function stakeBalance(address _staker) external view returns (uint256);
    function stakeOwnerOf(address _taker) external view returns (address);
    function stakeToken() external view returns (IERC20);
    function updateReservation(bytes32 _intentHash, uint256 _newAmount, uint64 _releaseTime) external;
}
