// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";

contract OrchestratorV4StructLayoutTest is Test {
    function test_SignalSelectorOmitsPostIntentHook() public pure {
        bytes4 expected = bytes4(keccak256(
            "signalIntent((address,uint256,uint256,address,bytes32,bytes32,uint256,(address,uint256)[],bytes,uint256,bytes,bytes))"
        ));
        assertEq(IOrchestratorV4.signalIntent.selector, expected);
    }

    function test_IntentEncodingMatchesV3() public pure {
        IReferralFee.ReferralFee[] memory fees = _fees();
        IOrchestratorV3.Intent memory v3 = IOrchestratorV3.Intent({
            owner: address(1),
            to: address(2),
            escrow: address(3),
            depositId: 4,
            amount: 5,
            timestamp: 6,
            paymentMethod: bytes32(uint256(7)),
            fiatCurrency: bytes32(uint256(8)),
            conversionRate: 9,
            payeeId: bytes32(uint256(10)),
            referralFees: fees,
            postIntentHook: IPostIntentHookV2(address(11)),
            data: hex"aabbcc"
        });
        IOrchestratorV4.Intent memory v4 = IOrchestratorV4.Intent({
            owner: address(1),
            to: address(2),
            escrow: address(3),
            depositId: 4,
            amount: 5,
            timestamp: 6,
            paymentMethod: bytes32(uint256(7)),
            fiatCurrency: bytes32(uint256(8)),
            conversionRate: 9,
            payeeId: bytes32(uint256(10)),
            referralFees: fees,
            postIntentHook: address(11),
            data: hex"aabbcc"
        });
        assertEq(abi.encode(v3), abi.encode(v4));
    }

    function test_SignalIntentParamsMatchesV3MinusPostIntentHook() public pure {
        IReferralFee.ReferralFee[] memory fees = _fees();
        IOrchestratorV3.SignalIntentParams memory v3 = IOrchestratorV3.SignalIntentParams({
            escrow: address(1),
            depositId: 2,
            amount: 3,
            to: address(4),
            paymentMethod: bytes32(uint256(5)),
            fiatCurrency: bytes32(uint256(6)),
            conversionRate: 7,
            referralFees: fees,
            gatingServiceSignature: hex"112233",
            signatureExpiration: 8,
            postIntentHook: IPostIntentHookV2(address(9)),
            preIntentHookData: hex"44556677",
            data: hex"8899"
        });
        // Positional construction locks V3's field order with only postIntentHook removed.
        IOrchestratorV4.SignalIntentParams memory v4 = IOrchestratorV4.SignalIntentParams(
            v3.escrow,
            v3.depositId,
            v3.amount,
            v3.to,
            v3.paymentMethod,
            v3.fiatCurrency,
            v3.conversionRate,
            v3.referralFees,
            v3.gatingServiceSignature,
            v3.signatureExpiration,
            v3.preIntentHookData,
            v3.data
        );
        assertEq(v4.escrow, v3.escrow);
        assertEq(v4.depositId, v3.depositId);
        assertEq(v4.amount, v3.amount);
        assertEq(v4.to, v3.to);
        assertEq(v4.paymentMethod, v3.paymentMethod);
        assertEq(v4.fiatCurrency, v3.fiatCurrency);
        assertEq(v4.conversionRate, v3.conversionRate);
        assertEq(abi.encode(v4.referralFees), abi.encode(v3.referralFees));
        assertEq(v4.gatingServiceSignature, v3.gatingServiceSignature);
        assertEq(v4.signatureExpiration, v3.signatureExpiration);
        assertEq(v4.preIntentHookData, v3.preIntentHookData);
        assertEq(v4.data, v3.data);
    }

    function test_FulfillIntentParamsMatchesV3MinusPostIntentHookData() public pure {
        IOrchestratorV3.FulfillIntentParams memory v3 = IOrchestratorV3.FulfillIntentParams({
            paymentProof: hex"010203",
            intentHash: bytes32(uint256(4)),
            verificationData: hex"05060708",
            postIntentHookData: hex"090a"
        });
        // Positional construction pins V3's remaining fields, including the two distinct byte arrays.
        IOrchestratorV4.FulfillIntentParams memory v4 = IOrchestratorV4.FulfillIntentParams(
            v3.paymentProof, v3.intentHash, v3.verificationData
        );
        assertEq(v4.paymentProof, v3.paymentProof);
        assertEq(v4.intentHash, v3.intentHash);
        assertEq(v4.verificationData, v3.verificationData);
        assertEq(IOrchestratorV4.fulfillIntent.selector, bytes4(keccak256("fulfillIntent((bytes,bytes32,bytes))")));
    }

    function _fees() private pure returns (IReferralFee.ReferralFee[] memory fees) {
        fees = new IReferralFee.ReferralFee[](2);
        fees[0] = IReferralFee.ReferralFee(address(12), 13);
        fees[1] = IReferralFee.ReferralFee(address(14), 15);
    }
}
