// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IEscrow } from "../interfaces/IEscrow.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";

/**
 * @title ReentrantReleaseEscrowMock
 * @notice Minimal escrow stub that attempts reentrant `releaseFundsToPayer` during unlock.
 */
contract ReentrantReleaseEscrowMock {
    IERC20 public immutable token;
    address public immutable orchestrator;
    address public immutable depositor;
    bytes32 public immutable payeeDetails;

    bool public paymentMethodActive = true;
    bool public shouldAttemptReentry;
    bytes32 public reentryIntentHash;

    event ReentryAttempted(bool success);

    constructor(address _token, address _orchestrator, address _depositor, bytes32 _payeeDetails) {
        token = IERC20(_token);
        orchestrator = _orchestrator;
        depositor = _depositor;
        payeeDetails = _payeeDetails;
    }

    function setPaymentMethodActive(bool _active) external {
        paymentMethodActive = _active;
    }

    function setReentryIntent(bytes32 _intentHash, bool _enabled) external {
        reentryIntentHash = _intentHash;
        shouldAttemptReentry = _enabled;
    }

    function lockFunds(uint256, bytes32, uint256) external {}

    function unlockFunds(uint256, bytes32) external {}

    function unlockAndTransferFunds(
        uint256,
        bytes32,
        uint256 _transferAmount,
        address _to
    ) external {
        if (shouldAttemptReentry) {
            shouldAttemptReentry = false;
            try IOrchestrator(orchestrator).releaseFundsToPayer(reentryIntentHash) {
                emit ReentryAttempted(true);
            } catch {
                emit ReentryAttempted(false);
            }
        }

        token.transfer(_to, _transferAmount);
    }

    function getDeposit(uint256) external view returns (IEscrow.Deposit memory) {
        return IEscrow.Deposit({
            depositor: depositor,
            delegate: address(0),
            token: token,
            intentAmountRange: IEscrow.Range({min: 1, max: type(uint256).max}),
            acceptingIntents: true,
            remainingDeposits: type(uint256).max,
            outstandingIntentAmount: 0,
            intentGuardian: address(0),
            retainOnEmpty: false
        });
    }

    function getDepositIntent(uint256, bytes32) external pure returns (IEscrow.Intent memory) {
        return IEscrow.Intent({intentHash: bytes32(0), amount: 0, timestamp: 0, expiryTime: 0});
    }

    function getDepositPaymentMethodData(
        uint256,
        bytes32
    ) external view returns (IEscrow.DepositPaymentMethodData memory) {
        return IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: payeeDetails,
            data: "0x"
        });
    }

    function getDepositPaymentMethodActive(uint256, bytes32) external view returns (bool) {
        return paymentMethodActive;
    }

    function getDepositGatingService(uint256, bytes32) external pure returns (address) {
        return address(0);
    }

    function getEffectiveRate(uint256, bytes32, bytes32) external pure returns (uint256) {
        return 1e18;
    }

    function getManagerFee(uint256) external pure returns (address, uint256) {
        return (address(0), 0);
    }
}
