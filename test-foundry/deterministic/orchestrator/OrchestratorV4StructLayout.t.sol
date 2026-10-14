// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";

contract OrchestratorV4StructLayoutTest is Test {
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
            postIntentHook: IPostIntentHookV2(address(11)),
            data: hex"aabbcc"
        });
        assertEq(abi.encode(v3), abi.encode(v4));
    }

    function test_SignalIntentParamsEncodingMatchesV3() public pure {
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
        IOrchestratorV4.SignalIntentParams memory v4 = IOrchestratorV4.SignalIntentParams({
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
        assertEq(abi.encode(v3), abi.encode(v4));
    }

    function test_FulfillIntentParamsEncodingMatchesV3() public pure {
        IOrchestratorV3.FulfillIntentParams memory v3 = IOrchestratorV3.FulfillIntentParams({
            paymentProof: hex"010203",
            intentHash: bytes32(uint256(4)),
            verificationData: hex"05060708",
            postIntentHookData: hex"090a"
        });
        IOrchestratorV4.FulfillIntentParams memory v4 = IOrchestratorV4.FulfillIntentParams({
            paymentProof: hex"010203",
            intentHash: bytes32(uint256(4)),
            verificationData: hex"05060708",
            postIntentHookData: hex"090a"
        });
        assertEq(abi.encode(v3), abi.encode(v4));
    }

    function _fees() private pure returns (IReferralFee.ReferralFee[] memory fees) {
        fees = new IReferralFee.ReferralFee[](2);
        fees[0] = IReferralFee.ReferralFee(address(12), 13);
        fees[1] = IReferralFee.ReferralFee(address(14), 15);
    }
}
