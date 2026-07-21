// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowIntentExpiryParityTest is EscrowLegacyFixture {
    event IntentExpiryExtended(uint256 indexed depositId, bytes32 indexed intentHash, uint256 newExpiryTime);

    bytes32 internal subjectIntent;

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.intentAmountRange = IEscrow.Range({min: 10e6, max: 100e6});
        params.delegate = address(0);
        params.intentGuardian = intentGuardian;
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1e18});
        _createAsOffRamper(params);
        subjectIntent = _signalIntent(0, 50e6, 1e18);
    }

    function _extend(address caller, uint256 depositId, bytes32 intentHash, uint256 additionalTime) internal {
        vm.prank(caller);
        escrow.extendIntentExpiry(depositId, intentHash, additionalTime);
    }

    function test_ExtendIntentExpiryAddsRequestedTime() public {
        uint256 oldExpiry = escrow.getDepositIntent(0, subjectIntent).expiryTime;
        _extend(intentGuardian, 0, subjectIntent, 1 hours);
        assertEq(escrow.getDepositIntent(0, subjectIntent).expiryTime, oldExpiry + 1 hours);
    }

    function test_ExtendIntentExpiryEmitsNewExpiry() public {
        uint256 newExpiry = escrow.getDepositIntent(0, subjectIntent).expiryTime + 1 hours;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IntentExpiryExtended(0, subjectIntent, newExpiry);
        _extend(intentGuardian, 0, subjectIntent, 1 hours);
    }

    function test_ExtendIntentExpiryRejectsNonGuardian() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, onRamper, intentGuardian));
        _extend(onRamper, 0, subjectIntent, 1 hours);
    }

    function test_ExtendIntentExpiryRejectsMissingIntent() public {
        bytes32 missingIntent = keccak256("nonexistent");
        vm.expectRevert(abi.encodeWithSelector(IEscrow.IntentNotFound.selector, missingIntent));
        _extend(intentGuardian, 0, missingIntent, 1 hours);
    }

    function test_ExtendIntentExpiryRejectsDepositWithoutGuardian() public {
        vm.prank(onRamper);
        orchestrator.cancelIntent(subjectIntent);

        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.intentAmountRange = IEscrow.Range({min: 10e6, max: 100e6});
        params.delegate = address(0);
        params.intentGuardian = address(0);
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1e18});
        _createAsOffRamper(params);
        bytes32 unguardedIntent = _signalIntent(1, 50e6, 1e18);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, intentGuardian, address(0)));
        _extend(intentGuardian, 1, unguardedIntent, 1 hours);
    }

    function test_ExtendIntentExpiryRejectsExtensionBeyondMaximumTotalPeriod() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountAboveMax.selector, 6 days, 5 days));
        _extend(intentGuardian, 0, subjectIntent, 6 days);
    }

    function test_ExtendIntentExpiryAllowsMultipleExtensionsWithinAggregateCap() public {
        uint256 initialExpiry = escrow.getDepositIntent(0, subjectIntent).expiryTime;
        _extend(intentGuardian, 0, subjectIntent, 1 days);
        assertEq(escrow.getDepositIntent(0, subjectIntent).expiryTime, initialExpiry + 1 days);
        _extend(intentGuardian, 0, subjectIntent, 1 days);
        assertEq(escrow.getDepositIntent(0, subjectIntent).expiryTime, initialExpiry + 2 days);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountAboveMax.selector, 2 days + 1, 5 days));
        _extend(intentGuardian, 0, subjectIntent, 2 days + 1);
    }

    function test_ExtendIntentExpiryRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, 999));
        _extend(intentGuardian, 999, subjectIntent, 1 hours);
    }

    function test_ExtendIntentExpiryRejectsZeroAdditionalTime() public {
        vm.expectRevert(IEscrow.ZeroValue.selector);
        _extend(intentGuardian, 0, subjectIntent, 0);
    }
}
