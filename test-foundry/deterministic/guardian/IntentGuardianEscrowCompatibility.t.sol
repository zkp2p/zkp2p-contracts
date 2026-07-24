// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {Escrow} from "../../../contracts/Escrow.sol";
import {EscrowV2} from "../../../contracts/EscrowV2.sol";
import {IntentGuardian} from "../../../contracts/IntentGuardian.sol";
import {IEscrow} from "../../../contracts/interfaces/IEscrow.sol";
import {IEscrowV2} from "../../../contracts/interfaces/IEscrowV2.sol";
import {EscrowRegistry} from "../../../contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "../../../contracts/registries/OrchestratorRegistry.sol";
import {GuardianTokenMock} from "./IntentGuardian.t.sol";

abstract contract IntentGuardianCompatibilityTestBase is Test {
    uint256 internal constant INTENT_AMOUNT = 1_000e6;
    bytes32 internal constant INTENT_HASH = keccak256("compatibility-intent");

    address internal depositor = makeAddr("depositor");
    address internal payer = makeAddr("payer");

    GuardianTokenMock internal token;
    EscrowRegistry internal escrowRegistry;
    IntentGuardian internal guardian;

    function setUp() public virtual {
        token = new GuardianTokenMock();
        escrowRegistry = new EscrowRegistry();
        guardian = new IntentGuardian(address(this), escrowRegistry, 10);
        token.mint(payer, INTENT_AMOUNT);
    }

    function _extend(address _escrow) internal {
        uint256 cost = guardian.quoteExtensionCost(INTENT_AMOUNT, 1 hours);
        vm.prank(payer);
        token.approve(address(guardian), cost);
        vm.prank(payer);
        guardian.extendIntent(_escrow, 0, INTENT_HASH, 1 hours, cost);
    }
}

contract IntentGuardianEscrowCompatibilityTest is IntentGuardianCompatibilityTestBase {
    function test_CompatibleWithFrozenEscrow() public {
        Escrow frozenEscrow = new Escrow(address(this), block.chainid, address(1), depositor, 0, 10, 1 days);
        frozenEscrow.setOrchestrator(address(this));
        escrowRegistry.addEscrow(address(frozenEscrow));

        token.mint(depositor, INTENT_AMOUNT * 2);
        vm.startPrank(depositor);
        token.approve(address(frozenEscrow), INTENT_AMOUNT * 2);
        frozenEscrow.createDeposit(
            IEscrow.CreateDepositParams({
                token: token,
                amount: INTENT_AMOUNT * 2,
                intentAmountRange: IEscrow.Range({min: INTENT_AMOUNT, max: INTENT_AMOUNT}),
                paymentMethods: new bytes32[](0),
                paymentMethodData: new IEscrow.DepositPaymentMethodData[](0),
                currencies: new IEscrow.Currency[][](0),
                delegate: address(0),
                intentGuardian: address(guardian),
                retainOnEmpty: true
            })
        );
        vm.stopPrank();
        frozenEscrow.lockFunds(0, INTENT_HASH, INTENT_AMOUNT);

        uint256 expiryBefore = frozenEscrow.getDepositIntent(0, INTENT_HASH).expiryTime;
        _extend(address(frozenEscrow));

        assertEq(frozenEscrow.getDepositIntent(0, INTENT_HASH).expiryTime, expiryBefore + 1 hours);
    }
}

contract IntentGuardianEscrowV2CompatibilityTest is IntentGuardianCompatibilityTestBase {
    function test_CompatibleWithFrozenEscrowV2AndCurrentOrchestratorAuthorization() public {
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        orchestratorRegistry.addOrchestrator(address(this));
        EscrowV2 frozenEscrowV2 = new EscrowV2(
            address(this), block.chainid, address(orchestratorRegistry), address(1), depositor, 0, 10, 1 days
        );
        escrowRegistry.addEscrow(address(frozenEscrowV2));

        token.mint(depositor, INTENT_AMOUNT * 2);
        vm.startPrank(depositor);
        token.approve(address(frozenEscrowV2), INTENT_AMOUNT * 2);
        frozenEscrowV2.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: token,
                amount: INTENT_AMOUNT * 2,
                intentAmountRange: IEscrowV2.Range({min: INTENT_AMOUNT, max: INTENT_AMOUNT}),
                paymentMethods: new bytes32[](0),
                paymentMethodData: new IEscrowV2.DepositPaymentMethodData[](0),
                currencies: new IEscrowV2.Currency[][](0),
                delegate: address(0),
                intentGuardian: address(guardian),
                retainOnEmpty: true
            })
        );
        vm.stopPrank();
        frozenEscrowV2.lockFunds(0, INTENT_HASH, INTENT_AMOUNT);

        uint256 expiryBefore = frozenEscrowV2.getDepositIntent(0, INTENT_HASH).expiryTime;
        _extend(address(frozenEscrowV2));

        assertEq(frozenEscrowV2.getDepositIntent(0, INTENT_HASH).expiryTime, expiryBefore + 1 hours);
    }
}
