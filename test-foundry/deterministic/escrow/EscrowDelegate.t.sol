// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowDelegateTest is EscrowLegacyFixture {
    event DepositDelegateSet(uint256 indexed depositId, address indexed depositor, address indexed delegate);
    event DepositDelegateRemoved(uint256 indexed depositId, address indexed depositor);

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.delegate = address(0);
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        _createAsOffRamper(params);
    }

    function _setDelegate(address caller, uint256 depositId, address delegate) internal {
        vm.prank(caller);
        escrow.setDelegate(depositId, delegate);
    }

    function _removeDelegate(address caller, uint256 depositId) internal {
        vm.prank(caller);
        escrow.removeDelegate(depositId);
    }

    function _setInitialDelegate() internal {
        _setDelegate(offRamper, 0, offRamperDelegate);
    }

    function test_SetDelegateStoresDelegate() public {
        _setDelegate(offRamper, 0, offRamperDelegate);
        assertEq(escrow.getDeposit(0).delegate, offRamperDelegate);
    }

    function test_SetDelegateEmitsDepositorAndDelegate() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositDelegateSet(0, offRamper, offRamperDelegate);
        _setDelegate(offRamper, 0, offRamperDelegate);
    }

    function test_SetDelegateRejectsNonDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, maliciousOnRamper, offRamper));
        _setDelegate(maliciousOnRamper, 0, offRamperDelegate);
    }

    function test_SetDelegateRejectsProspectiveDelegateCaller() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, offRamperDelegate, offRamper));
        _setDelegate(offRamperDelegate, 0, offRamperDelegate);
    }

    function test_SetDelegateRejectsZeroAddress() public {
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        _setDelegate(offRamper, 0, address(0));
    }

    function test_SetDelegateUpdatesExistingDelegate() public {
        _setInitialDelegate();
        _setDelegate(offRamper, 0, receiver);
        assertEq(escrow.getDeposit(0).delegate, receiver);
    }

    function test_SetDelegateUpdateEmitsNewDelegate() public {
        _setInitialDelegate();
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositDelegateSet(0, offRamper, receiver);
        _setDelegate(offRamper, 0, receiver);
    }

    function test_SetDelegateRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, offRamper, address(0)));
        _setDelegate(offRamper, 999, offRamperDelegate);
    }

    function test_SetDelegateRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _setDelegate(offRamper, 0, offRamperDelegate);
    }

    function test_RemoveDelegateClearsDelegate() public {
        _setInitialDelegate();
        _removeDelegate(offRamper, 0);
        assertEq(escrow.getDeposit(0).delegate, address(0));
    }

    function test_RemoveDelegateEmitsDepositor() public {
        _setInitialDelegate();
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositDelegateRemoved(0, offRamper);
        _removeDelegate(offRamper, 0);
    }

    function test_RemoveDelegateRejectsNonDepositor() public {
        _setInitialDelegate();
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, maliciousOnRamper, offRamper));
        _removeDelegate(maliciousOnRamper, 0);
    }

    function test_RemoveDelegateRejectsDelegateCaller() public {
        _setInitialDelegate();
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, offRamperDelegate, offRamper));
        _removeDelegate(offRamperDelegate, 0);
    }

    function test_RemoveDelegateRejectsWhenNoDelegateExists() public {
        _setInitialDelegate();
        _removeDelegate(offRamper, 0);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DelegateNotFound.selector, 0));
        _removeDelegate(offRamper, 0);
    }

    function test_RemoveDelegateRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, offRamper, address(0)));
        _removeDelegate(offRamper, 999);
    }

    function test_RemoveDelegateRejectsWhilePaused() public {
        _setInitialDelegate();
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _removeDelegate(offRamper, 0);
    }
}
