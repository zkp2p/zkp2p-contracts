// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {DepositCreationGuard, IDepositCreationEscrow} from "contracts/DepositCreationGuard.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract DepositCreationEscrowMock is IDepositCreationEscrow {
    uint256 public depositCounter;
    mapping(uint256 => IEscrowV2.Deposit) private deposits;

    function setDepositCounter(uint256 _depositCounter) external {
        depositCounter = _depositCounter;
    }

    function setDepositor(uint256 _depositId, address _depositor) external {
        deposits[_depositId].depositor = _depositor;
    }

    function getDeposit(uint256 _depositId) external view returns (IEscrowV2.Deposit memory) {
        return deposits[_depositId];
    }
}

contract DepositCreationGuardTest is Test {
    DepositCreationGuard internal guard;
    DepositCreationEscrowMock internal escrow;
    address internal maker;

    function setUp() public {
        guard = new DepositCreationGuard();
        escrow = new DepositCreationEscrowMock();
        maker = makeAddr("maker");
    }

    function test_ValidateBeforeCreateAcceptsExpectedCounter() public view {
        guard.validateBeforeCreate(escrow, 0);
    }

    function test_ValidateBeforeCreateRejectsStaleCounter() public {
        escrow.setDepositCounter(8);

        vm.expectRevert(abi.encodeWithSelector(DepositCreationGuard.UnexpectedDepositCounter.selector, 7, 8));
        guard.validateBeforeCreate(escrow, 7);
    }

    function test_ValidateAfterCreateAcceptsSingleIncrementAndExpectedDepositor() public {
        escrow.setDepositCounter(8);
        escrow.setDepositor(7, maker);

        guard.validateAfterCreate(escrow, 7, maker);
    }

    function test_ValidateAfterCreateRejectsCounterThatDidNotIncrement() public {
        escrow.setDepositCounter(7);

        vm.expectRevert(abi.encodeWithSelector(DepositCreationGuard.DepositCounterDidNotIncrement.selector, 7, 7));
        guard.validateAfterCreate(escrow, 7, maker);
    }

    function test_ValidateAfterCreateRejectsCounterThatAdvancedMoreThanOnce() public {
        escrow.setDepositCounter(9);

        vm.expectRevert(abi.encodeWithSelector(DepositCreationGuard.DepositCounterDidNotIncrement.selector, 7, 9));
        guard.validateAfterCreate(escrow, 7, maker);
    }

    function test_ValidateAfterCreateRejectsUnexpectedDepositor() public {
        address otherDepositor = makeAddr("otherDepositor");
        escrow.setDepositCounter(8);
        escrow.setDepositor(7, otherDepositor);

        vm.expectRevert(
            abi.encodeWithSelector(DepositCreationGuard.UnexpectedDepositor.selector, 7, maker, otherDepositor)
        );
        guard.validateAfterCreate(escrow, 7, maker);
    }
}
