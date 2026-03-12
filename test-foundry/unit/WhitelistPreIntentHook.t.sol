// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IPreIntentHook } from "../../contracts/interfaces/IPreIntentHook.sol";
import { IOrchestratorV2 } from "../../contracts/interfaces/IOrchestratorV2.sol";
import { PreIntentHookMock } from "../../contracts/mocks/PreIntentHookMock.sol";
import { WhitelistPreIntentHook } from "../../contracts/hooks/WhitelistPreIntentHook.sol";
import { ProtocolV2TestBase } from "../helpers/ProtocolV2TestBase.sol";

contract WhitelistPreIntentHookTest is ProtocolV2TestBase {
    event TakerWhitelisted(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event TakerRemovedFromWhitelist(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event DepositWhitelistHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);

    WhitelistPreIntentHook internal whitelistHook;

    function setUp() public {
        _setUpV2Core();
        _createDeposit();

        vm.prank(owner);
        whitelistHook = new WhitelistPreIntentHook(address(orchestratorRegistry));
    }

    function test_constructorSetsOrchestratorRegistryAndRevertsOnZeroAddress() public {
        assertEq(address(whitelistHook.orchestratorRegistry()), address(orchestratorRegistry));

        vm.expectRevert(WhitelistPreIntentHook.ZeroAddress.selector);
        new WhitelistPreIntentHook(address(0));
    }

    function test_addToWhitelistWhitelistsTakersAndEmitsEvents() public {
        address[] memory takers = _twoTakers(takerA, takerB);

        vm.expectEmit(true, true, true, true, address(whitelistHook));
        emit TakerWhitelisted(address(escrow), 0, takerA);
        vm.expectEmit(true, true, true, true, address(whitelistHook));
        emit TakerWhitelisted(address(escrow), 0, takerB);

        vm.prank(depositor);
        whitelistHook.addToWhitelist(address(escrow), 0, takers);

        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, takerA));
        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, takerB));
        assertFalse(whitelistHook.isWhitelisted(address(escrow), 0, unauthorizedCaller));
    }

    function test_addToWhitelistAllowsDelegate() public {
        vm.prank(delegate);
        whitelistHook.addToWhitelist(address(escrow), 0, _singleTaker(takerA));

        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, takerA));
    }

    function test_addToWhitelistRevertsOnUnauthorizedCallerOrInvalidInputs() public {
        vm.prank(unauthorizedCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.UnauthorizedCallerOrDelegate.selector,
                unauthorizedCaller,
                depositor,
                delegate
            )
        );
        whitelistHook.addToWhitelist(address(escrow), 0, _singleTaker(takerA));

        vm.prank(depositor);
        vm.expectRevert(WhitelistPreIntentHook.ZeroAddress.selector);
        whitelistHook.addToWhitelist(address(0), 0, _singleTaker(takerA));

        vm.prank(depositor);
        vm.expectRevert(WhitelistPreIntentHook.EmptyArray.selector);
        whitelistHook.addToWhitelist(address(escrow), 0, new address[](0));

        address[] memory takersWithZero = new address[](2);
        takersWithZero[0] = takerA;
        takersWithZero[1] = address(0);

        vm.prank(depositor);
        vm.expectRevert(WhitelistPreIntentHook.ZeroAddress.selector);
        whitelistHook.addToWhitelist(address(escrow), 0, takersWithZero);
    }

    function test_removeFromWhitelistClearsStateAndEmitsEvent() public {
        vm.prank(depositor);
        whitelistHook.addToWhitelist(address(escrow), 0, _twoTakers(takerA, takerB));

        vm.expectEmit(true, true, true, true, address(whitelistHook));
        emit TakerRemovedFromWhitelist(address(escrow), 0, takerA);

        vm.prank(depositor);
        whitelistHook.removeFromWhitelist(address(escrow), 0, _singleTaker(takerA));

        assertFalse(whitelistHook.isWhitelisted(address(escrow), 0, takerA));
        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, takerB));
    }

    function test_removeFromWhitelistAllowsDelegate() public {
        vm.prank(depositor);
        whitelistHook.addToWhitelist(address(escrow), 0, _singleTaker(takerA));

        vm.prank(delegate);
        whitelistHook.removeFromWhitelist(address(escrow), 0, _singleTaker(takerA));

        assertFalse(whitelistHook.isWhitelisted(address(escrow), 0, takerA));
    }

    function test_removeFromWhitelistRevertsOnUnauthorizedCallerOrInvalidInputs() public {
        vm.prank(depositor);
        whitelistHook.addToWhitelist(address(escrow), 0, _singleTaker(takerA));

        vm.prank(unauthorizedCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.UnauthorizedCallerOrDelegate.selector,
                unauthorizedCaller,
                depositor,
                delegate
            )
        );
        whitelistHook.removeFromWhitelist(address(escrow), 0, _singleTaker(takerA));

        vm.prank(depositor);
        vm.expectRevert(WhitelistPreIntentHook.ZeroAddress.selector);
        whitelistHook.removeFromWhitelist(address(0), 0, _singleTaker(takerA));

        vm.prank(depositor);
        vm.expectRevert(WhitelistPreIntentHook.EmptyArray.selector);
        whitelistHook.removeFromWhitelist(address(escrow), 0, new address[](0));

        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.TakerNotInWhitelist.selector,
                takerB,
                address(escrow),
                uint256(0)
            )
        );
        whitelistHook.removeFromWhitelist(address(escrow), 0, _singleTaker(takerB));
    }

    function test_setDepositWhitelistHookStoresHookAndEmitsEvent() public {
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositWhitelistHookSet(address(escrow), 0, address(whitelistHook), depositor);

        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);

        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(whitelistHook));
    }

    function test_setDepositWhitelistHookAllowsDelegateAndZeroAddressRemoval() public {
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);

        vm.prank(delegate);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(whitelistHook));

        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, IPreIntentHook(address(0)));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(0));
    }

    function test_setDepositWhitelistHookRevertsOnUnauthorizedCallerOrInvalidHook() public {
        vm.prank(unauthorizedCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IOrchestratorV2.UnauthorizedCallerOrDelegate.selector,
                unauthorizedCaller,
                depositor,
                delegate
            )
        );
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);

        vm.prank(depositor);
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.setDepositWhitelistHook(address(0), 0, whitelistHook);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.InvalidPreIntentHook.selector, takerA));
        orchestrator.setDepositWhitelistHook(address(escrow), 0, IPreIntentHook(takerA));
    }

    function test_validateSignalIntentAllowsWhitelistedTakerThroughWhitelistSlot() public {
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);

        vm.prank(depositor);
        whitelistHook.addToWhitelist(address(escrow), 0, _singleTaker(takerA));

        vm.prank(takerA);
        orchestrator.signalIntent(_defaultSignalIntentParams(takerA));

        assertEq(orchestrator.getAccountIntents(takerA).length, 1);
    }

    function test_validateSignalIntentRevertsForNonWhitelistedOrRemovedTaker() public {
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);

        vm.prank(takerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.TakerNotWhitelisted.selector,
                takerA,
                address(escrow),
                uint256(0)
            )
        );
        orchestrator.signalIntent(_defaultSignalIntentParams(takerA));

        vm.prank(depositor);
        whitelistHook.addToWhitelist(address(escrow), 0, _singleTaker(takerA));
        vm.prank(depositor);
        whitelistHook.removeFromWhitelist(address(escrow), 0, _singleTaker(takerA));

        vm.prank(takerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.TakerNotWhitelisted.selector,
                takerA,
                address(escrow),
                uint256(0)
            )
        );
        orchestrator.signalIntent(_defaultSignalIntentParams(takerA));
    }

    function test_validateSignalIntentRevertsWhenCalledDirectly() public {
        IPreIntentHook.PreIntentContext memory context = IPreIntentHook.PreIntentContext({
            taker: takerA,
            escrow: address(escrow),
            depositId: 0,
            amount: 50e6,
            to: takerA,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1.02e18,
            referralFees: _emptyReferralFees(),
            preIntentHookData: ""
        });

        vm.prank(takerA);
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPreIntentHook.UnauthorizedOrchestratorCaller.selector, takerA)
        );
        whitelistHook.validateSignalIntent(context);
    }

    function test_genericAndWhitelistHooksAreStoredIndependently() public {
        PreIntentHookMock genericHook = new PreIntentHookMock();

        vm.startPrank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, genericHook);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);
        vm.stopPrank();

        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(genericHook));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(whitelistHook));
    }

    function test_signalIntentExecutesBothHooksWhenWhitelistPasses() public {
        PreIntentHookMock genericHook = new PreIntentHookMock();

        vm.startPrank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, genericHook);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);
        whitelistHook.addToWhitelist(address(escrow), 0, _singleTaker(takerA));
        vm.stopPrank();

        vm.prank(takerA);
        orchestrator.signalIntent(_defaultSignalIntentParams(takerA));

        assertEq(genericHook.callCount(), 1);
        assertEq(genericHook.lastTaker(), takerA);
        assertEq(orchestrator.getAccountIntents(takerA).length, 1);
    }

    function test_signalIntentRevertsWhenWhitelistHookRejectsEvenIfGenericHookExists() public {
        PreIntentHookMock genericHook = new PreIntentHookMock();

        vm.startPrank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, genericHook);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);
        vm.stopPrank();

        vm.prank(takerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.TakerNotWhitelisted.selector,
                takerA,
                address(escrow),
                uint256(0)
            )
        );
        orchestrator.signalIntent(_defaultSignalIntentParams(takerA));
    }

    function test_removingWhitelistHookLeavesGenericHookIntact() public {
        PreIntentHookMock genericHook = new PreIntentHookMock();

        vm.startPrank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, genericHook);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, IPreIntentHook(address(0)));
        vm.stopPrank();

        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(genericHook));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(0));
    }

    function test_removingGenericHookLeavesWhitelistHookIntact() public {
        PreIntentHookMock genericHook = new PreIntentHookMock();

        vm.startPrank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, genericHook);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, whitelistHook);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(0)));
        vm.stopPrank();

        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(0));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(whitelistHook));
    }

    function _singleTaker(address taker) internal pure returns (address[] memory takers) {
        takers = new address[](1);
        takers[0] = taker;
    }

    function _twoTakers(address takerOne, address takerTwo) internal pure returns (address[] memory takers) {
        takers = new address[](2);
        takers[0] = takerOne;
        takers[1] = takerTwo;
    }
}
