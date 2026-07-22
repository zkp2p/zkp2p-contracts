// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowAcceptingRetainTest is EscrowLegacyFixture {
    event DepositAcceptingIntentsUpdated(uint256 indexed depositId, bool accepting);
    event DepositRetainOnEmptyUpdated(uint256 indexed depositId, bool retainOnEmpty);

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        _createAsOffRamper(params);
    }

    function _setAccepting(address caller, uint256 depositId, bool accepting) internal {
        vm.prank(caller);
        escrow.setAcceptingIntents(depositId, accepting);
    }

    function _setRetain(address caller, uint256 depositId, bool retain) internal {
        vm.prank(caller);
        escrow.setRetainOnEmpty(depositId, retain);
    }

    function _lockWithMock(bytes32 intentHash, uint256 amount) internal {
        escrow.setOrchestrator(address(orchestratorMock));
        orchestratorMock.lockFunds(0, intentHash, amount);
    }

    function test_SetAcceptingIntentsUpdatesState() public {
        assertTrue(escrow.getDeposit(0).acceptingIntents);
        _setAccepting(offRamper, 0, false);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_SetAcceptingIntentsEmitsUpdate() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositAcceptingIntentsUpdated(0, false);
        _setAccepting(offRamper, 0, false);
    }

    function test_SetAcceptingIntentsReenablesDeposit() public {
        _setAccepting(offRamper, 0, false);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
        _setAccepting(offRamper, 0, true);
        assertTrue(escrow.getDeposit(0).acceptingIntents);
    }

    function test_SetAcceptingIntentsEmitsReenabledState() public {
        _setAccepting(offRamper, 0, false);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositAcceptingIntentsUpdated(0, true);
        _setAccepting(offRamper, 0, true);
    }

    function test_SetAcceptingIntentsAllowsDelegate() public {
        _setAccepting(offRamperDelegate, 0, false);
    }

    function test_SetAcceptingIntentsDelegateUpdatesState() public {
        _setAccepting(offRamperDelegate, 0, false);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_SetAcceptingIntentsRejectsMissingDeposit() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCallerOrDelegate.selector, offRamper, address(0), address(0))
        );
        _setAccepting(offRamper, 999, false);
    }

    function test_SetAcceptingIntentsRejectsUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.UnauthorizedCallerOrDelegate.selector, maliciousOnRamper, offRamper, offRamperDelegate
            )
        );
        _setAccepting(maliciousOnRamper, 0, false);
    }

    function test_SetAcceptingIntentsRejectsExistingState() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositAlreadyInState.selector, 0, true));
        _setAccepting(offRamper, 0, true);
    }

    function test_SetAcceptingIntentsRejectsZeroRemainingLiquidity() public {
        _lockWithMock(keccak256("intent"), 10e6);
        vm.prank(offRamper);
        escrow.removeFunds(0, 90e6);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.InsufficientDepositLiquidity.selector, 0, 0, 10e6));
        _setAccepting(offRamper, 0, true);
    }

    function test_SetAcceptingIntentsRejectsLiquidityBelowMinimum() public {
        _lockWithMock(keccak256("intent"), 10e6);
        vm.prank(offRamper);
        escrow.removeFunds(0, 81e6);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.InsufficientDepositLiquidity.selector, 0, 9e6, 10e6));
        _setAccepting(offRamper, 0, true);
    }

    function test_SetAcceptingIntentsAllowsDisableWithOutstandingIntent() public {
        _lockWithMock(keccak256("intent"), 40e6);
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        assertEq(beforeDeposit.remainingDeposits, 60e6);
        assertEq(beforeDeposit.outstandingIntentAmount, 40e6);

        _setAccepting(offRamper, 0, false);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_SetAcceptingIntentsRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _setAccepting(offRamper, 0, false);
    }

    function test_SetRetainOnEmptyUpdatesFlag() public {
        _setRetain(offRamper, 0, true);
        assertTrue(escrow.getDeposit(0).retainOnEmpty);
    }

    function test_SetRetainOnEmptyEmitsUpdate() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositRetainOnEmptyUpdated(0, true);
        _setRetain(offRamper, 0, true);
    }

    function test_SetRetainOnEmptyAllowsDelegate() public {
        _setRetain(offRamperDelegate, 0, true);
    }

    function test_SetRetainOnEmptyDelegateUpdatesFlag() public {
        _setRetain(offRamperDelegate, 0, true);
        assertTrue(escrow.getDeposit(0).retainOnEmpty);
    }

    function test_SetRetainOnEmptyRejectsUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.UnauthorizedCallerOrDelegate.selector, maliciousOnRamper, offRamper, offRamperDelegate
            )
        );
        _setRetain(maliciousOnRamper, 0, true);
    }

    function test_SetRetainOnEmptyRejectsMissingDeposit() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCallerOrDelegate.selector, offRamper, address(0), address(0))
        );
        _setRetain(offRamper, 999, true);
    }

    function test_SetRetainOnEmptyRejectsExistingState() public {
        _setRetain(offRamper, 0, true);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositAlreadyInState.selector, 0, true));
        _setRetain(offRamper, 0, true);
    }

    function test_SetRetainOnEmptyRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _setRetain(offRamper, 0, true);
    }
}
