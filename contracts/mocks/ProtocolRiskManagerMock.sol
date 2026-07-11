// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IProtocolRiskManager } from "../interfaces/IProtocolRiskManager.sol";

contract ProtocolRiskManagerMock is IProtocolRiskManager {
    uint16 public feeDiscountBps;
    mapping(bytes32 => SignalContext) private signalContexts;
    mapping(bytes32 => uint256) public fulfilledAmounts;
    mapping(bytes32 => bool) public paymentProofVerified;
    mapping(bytes32 => bool) public abandoned;
    mapping(bytes32 => bool) public expired;
    bool public revertOnAbandon;

    function setFeeDiscountBps(uint16 feeDiscountBps_) external {
        feeDiscountBps = feeDiscountBps_;
    }

    function setRevertOnAbandon(bool revertOnAbandon_) external {
        revertOnAbandon = revertOnAbandon_;
    }

    function onIntentSignaled(SignalContext calldata context) external override returns (uint16) {
        signalContexts[context.intentHash] = context;
        return feeDiscountBps;
    }

    function onIntentFulfilled(bytes32 intentHash, uint256 releaseAmount, bool paymentProofVerified_) external override {
        fulfilledAmounts[intentHash] = releaseAmount;
        paymentProofVerified[intentHash] = paymentProofVerified_;
    }

    function onIntentAbandoned(bytes32 intentHash, bool expired_) external override {
        require(!revertOnAbandon, "ProtocolRiskManagerMock: abandon failed");
        abandoned[intentHash] = true;
        expired[intentHash] = expired_;
    }

    function syncReputation(bytes32) external pure override returns (bool) {
        return true;
    }

    function getSignalContext(bytes32 intentHash) external view returns (SignalContext memory) {
        return signalContexts[intentHash];
    }
}
