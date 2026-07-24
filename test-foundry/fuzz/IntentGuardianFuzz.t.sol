// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {IntentGuardian} from "../../contracts/IntentGuardian.sol";
import {IIntentGuardian} from "../../contracts/interfaces/IIntentGuardian.sol";
import {EscrowRegistry} from "../../contracts/registries/EscrowRegistry.sol";
import {GuardianEscrowMock, GuardianTokenMock} from "../deterministic/guardian/IntentGuardian.t.sol";

contract IntentGuardianFuzzTest is Test {
    uint256 internal constant DEPOSIT_ID = 1;
    bytes32 internal constant INTENT_HASH = keccak256("fuzz-intent");
    uint256 internal constant FEE_DENOMINATOR = 36_000_000;

    address internal depositor = makeAddr("depositor");
    address internal payer = makeAddr("payer");

    GuardianTokenMock internal token;
    GuardianEscrowMock internal escrow;
    EscrowRegistry internal escrowRegistry;

    function setUp() public {
        token = new GuardianTokenMock();
        escrow = new GuardianEscrowMock();
        escrowRegistry = new EscrowRegistry();
        escrowRegistry.addEscrow(address(escrow));
    }

    function testFuzz_QuoteMatchesChargedCostAndRoundsUp(uint96 rawAmount, uint32 rawAdditionalTime, uint8 rawFee)
        public
    {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint256 additionalTime = bound(uint256(rawAdditionalTime), 1, 5 days - 1 hours);
        uint256 fee = bound(uint256(rawFee), 1, 83);
        IntentGuardian guardian = _configureGuardian(amount, fee);
        uint256 quote = guardian.quoteExtensionCost(amount, additionalTime);

        vm.prank(payer);
        token.approve(address(guardian), quote);
        vm.prank(payer);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, additionalTime, quote);

        uint256 numerator = amount * fee * additionalTime;
        assertEq(token.balanceOf(depositor), quote);
        assertEq(token.balanceOf(payer), amount - quote);
        assertGe(quote * FEE_DENOMINATOR, numerator);
        assertLt((quote - 1) * FEE_DENOMINATOR, numerator);
    }

    function testFuzz_CostNeverExceedsIntentAmount(uint96 rawAmount, uint32 rawTime, uint8 rawFee) public {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint256 additionalTime = bound(uint256(rawTime), 1, 5 days);
        uint256 fee = bound(uint256(rawFee), 1, 83);
        IntentGuardian guardian = new IntentGuardian(escrowRegistry, fee);

        assertLe(guardian.quoteExtensionCost(amount, additionalTime), amount);
    }

    function testFuzz_MaxCostFailureLeavesExpiryAndBalancesUntouched(
        uint96 rawAmount,
        uint32 rawAdditionalTime,
        uint8 rawFee
    ) public {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint256 additionalTime = bound(uint256(rawAdditionalTime), 1, 5 days - 1 hours);
        uint256 fee = bound(uint256(rawFee), 1, 83);
        IntentGuardian guardian = _configureGuardian(amount, fee);
        uint256 quote = guardian.quoteExtensionCost(amount, additionalTime);
        uint256 expiryBefore = escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;

        vm.prank(payer);
        token.approve(address(guardian), quote);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IIntentGuardian.ExtensionCostExceedsMax.selector, quote, quote - 1));
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, additionalTime, quote - 1);

        assertEq(escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime, expiryBefore);
        assertEq(token.balanceOf(payer), amount);
        assertEq(token.balanceOf(depositor), 0);
    }

    function _configureGuardian(uint256 _amount, uint256 _fee) internal returns (IntentGuardian guardian) {
        guardian = new IntentGuardian(escrowRegistry, _fee);
        escrow.configureDeposit(depositor, token, address(guardian));
        escrow.setIntent(INTENT_HASH, _amount, block.timestamp, block.timestamp + 1 hours);
        token.mint(payer, _amount);
    }
}
