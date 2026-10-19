// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {Test} from "forge-std/Test.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";

contract OrchestratorV4StructLayoutTest is Test {
    function test_SignalSelectorOmitsIntentHooksAndAddsPayerCommitment() public pure {
        bytes4 expected = bytes4(keccak256(
            "signalIntent((address,uint256,uint256,address,bytes32,bytes32,uint256,(address,uint256)[],bytes,uint256,bytes))"
        ));
        assertEq(IOrchestratorV4.signalIntent.selector, expected);
    }

    function test_IntentEncodingAddsPayerCommitmentAndWhitelistFlag() public pure {
        IReferralFee.ReferralFee[] memory fees = _fees();
        IOrchestratorV4.Intent memory intent = IOrchestratorV4.Intent({
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
            payerCommitment: hex"0b",
            takerWhitelisted: true
        });
        // Top-level tuple offset, thirteen-word head ending in the two tails' offsets and the flag, two referrals,
        // then the commitment.
        bytes memory expected = bytes.concat(
            abi.encode(uint256(32), address(1), address(2), address(3), uint256(4), uint256(5), uint256(6)),
            abi.encode(bytes32(uint256(7)), bytes32(uint256(8)), uint256(9), bytes32(uint256(10)), uint256(416), uint256(576), true),
            abi.encode(uint256(2), address(12), uint256(13), address(14), uint256(15)),
            abi.encode(uint256(1), bytes32(bytes1(0x0b)))
        );
        assertEq(abi.encode(intent), expected);
    }

    function test_SignalIntentParamsMatchesV3MinusIntentHooksPlusPayerCommitment() public pure {
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
        // Positional construction locks V3's field order with both intent hooks and the hook data removed,
        // then the payer commitment appended.
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
            hex"0a"
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
        assertEq(v4.payerCommitment, hex"0a");
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

    function test_SettlementInterfaceAndContextLayout() public pure {
        assertEq(IIntentSettlementPolicy.settleIntent.selector, bytes4(keccak256(
            "settleIntent((bytes32,address,address,address,address,bytes32,uint256,uint256,bytes))"
        )));
        IIntentSettlementPolicy.SettlementContext memory context = IIntentSettlementPolicy.SettlementContext(
            bytes32(uint256(1)), address(2), address(3), address(4), address(5), bytes32(uint256(6)), 7, 8, hex"cc"
        );
        bytes memory expected = bytes.concat(
            abi.encode(uint256(32), bytes32(uint256(1)), address(2), address(3), address(4), address(5)),
            abi.encode(bytes32(uint256(6)), uint256(7), uint256(8), uint256(288)),
            abi.encode(uint256(1), bytes32(hex"cc"))
        );
        assertEq(abi.encode(context), expected);
        assertEq(context.taker, address(3));
        assertEq(context.recipient, address(4));
        assertEq(context.depositor, address(5));
    }

    function _fees() private pure returns (IReferralFee.ReferralFee[] memory fees) {
        fees = new IReferralFee.ReferralFee[](2);
        fees[0] = IReferralFee.ReferralFee(address(12), 13);
        fees[1] = IReferralFee.ReferralFee(address(14), 15);
    }
}
