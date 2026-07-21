// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerIntegrationFixture} from "./RiskManagerIntegrationFixture.sol";
import {RateManagerMock} from "contracts/mocks/RateManagerMock.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";

abstract contract RiskManagerBoundaryFixture is RiskManagerIntegrationFixture {
    uint256 internal constant ONE_PERCENT = 1e16;

    function _enableDeferred() internal {
        manager.setPlatformRiskConfig(PAYPAL, _platformConfig(true, true, 10_000, DAY, EXTENSION_SLOPE));
    }

    function _depositAsTaker(uint256 amount) internal {
        vm.prank(taker);
        vault.depositStake(amount);
    }

    function _configureManagerFee(address feeRecipient) internal returns (RateManagerMock rateManager) {
        rateManager = new RateManagerMock();
        bytes32 rateManagerId = keccak256("risk-settlement-manager");
        rateManager.setManager(rateManagerId, true);
        rateManager.setFee(rateManagerId, feeRecipient, ONE_PERCENT);
        rateManager.setRate(rateManagerId, address(escrow), 0, PAYPAL, USD, 1e18);
        vm.prank(maker);
        escrow.setRateManager(0, address(rateManager), rateManagerId);
    }

    function _signalCustom(
        address caller,
        address payoutRecipient,
        uint256 amount,
        bytes32 paymentMethod,
        IReferralFee.ReferralFee[] memory referralFees,
        IPostIntentHookV2 hook,
        bytes memory data
    ) internal returns (bytes32 intentHash) {
        IOrchestratorV3.SignalIntentParams memory params = _signalParams(payoutRecipient, amount, paymentMethod);
        params.referralFees = referralFees;
        params.postIntentHook = hook;
        params.data = data;
        intentHash = _nextIntentHash();
        vm.prank(caller);
        orchestrator.signalIntent(params);
    }

    function _oneReferral(address feeRecipient) internal pure returns (IReferralFee.ReferralFee[] memory referralFees) {
        referralFees = new IReferralFee.ReferralFee[](1);
        referralFees[0] = IReferralFee.ReferralFee({recipient: feeRecipient, fee: ONE_PERCENT});
    }

    function _chargebackClaim(bytes32 intentHash, uint256 amount, bool bindPayment)
        internal
        returns (IRiskManager.ChargebackAttestation memory attestation)
    {
        bytes32 paymentId = keccak256(abi.encodePacked("payment", intentHash));
        if (bindPayment) {
            bytes32 paymentNullifier = keccak256(abi.encodePacked(PAYPAL, paymentId));
            nullifierRegistry.addNullifier(paymentNullifier, intentHash);
        }
        bytes memory data = abi.encode(
            IRiskManager.ChargebackDetails({
                paymentMethod: PAYPAL,
                originalPaymentId: paymentId,
                disputeId: keccak256(abi.encodePacked("dispute", intentHash)),
                paymentAmount: amount,
                paymentCurrency: USD
            })
        );
        attestation = IRiskManager.ChargebackAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data, metadata: ""
        });
    }

    function _selectRiskHook(IIntentRiskHook hook) internal {
        vm.prank(maker);
        orchestrator.setDepositRiskHook(address(escrow), 0, hook);
    }
}
