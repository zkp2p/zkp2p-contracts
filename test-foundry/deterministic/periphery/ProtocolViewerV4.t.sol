// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {ProtocolViewerV2} from "contracts/ProtocolViewerV2.sol";
import {ProtocolViewerV4} from "contracts/ProtocolViewerV4.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IProtocolViewerV4} from "contracts/interfaces/IProtocolViewerV4.sol";

contract ProtocolViewerV4Test is OrchestratorV4Fixture {
    ProtocolViewerV4 internal viewer;

    function setUp() public override {
        super.setUp();
        viewer = new ProtocolViewerV4();
    }

    function test_GetIntentV4ReturnsTheFullO4IntentAndItsDeposit() public {
        vm.startPrank(depositor);
        uint256 gatedDepositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
        IOrchestratorV4.SignalIntentParams memory params =
            _params(gatedDepositId, taker, INTENT_AMOUNT, CONVERSION_RATE, _emptyReferralFees());
        params.payerCommitment = abi.encode(uint8(1), keccak256("salt"), keccak256("payer"));
        params.gatingServiceSignature = _gatingSignature(gatingServiceKey, taker, params, params.signatureExpiration);
        bytes32 id = _signal(taker, params);

        IProtocolViewerV4.IntentViewV4 memory intentView = viewer.getIntentV4(address(orchestrator), id);
        assertEq(intentView.intentHash, id);
        assertEq(abi.encode(intentView.intent), abi.encode(orchestrator.getIntent(id)));
        assertEq(intentView.intent.payerCommitment, params.payerCommitment);
        assertEq(intentView.deposit.depositId, gatedDepositId);
        // The inherited deposit reads are ProtocolViewerV2's, unchanged.
        assertEq(
            abi.encode(intentView.deposit),
            abi.encode(new ProtocolViewerV2().getDeposit(address(escrow), gatedDepositId))
        );
    }

    function test_GetIntentsV4AndAccountIntentsV4ReturnTheSameViews() public {
        bytes32 id = _signalDefault();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;

        IProtocolViewerV4.IntentViewV4[] memory byHash = viewer.getIntentsV4(address(orchestrator), ids);
        IProtocolViewerV4.IntentViewV4[] memory byAccount = viewer.getAccountIntentsV4(address(orchestrator), taker);
        assertEq(byHash.length, 1);
        assertEq(byHash[0].intent.owner, taker);
        assertEq(abi.encode(byAccount), abi.encode(byHash));
        assertEq(viewer.getAccountIntentsV4(address(orchestrator), other).length, 0);
    }

    function test_V2IntentReadsCannotDecodeO4Intents() public {
        bytes32 id = _signalDefault();
        vm.expectRevert();
        viewer.getIntent(address(orchestrator), id);
    }

    function test_V4IntentReadsRejectOrchestratorsThatAreNotV4() public {
        vm.expectRevert(abi.encodeWithSelector(ProtocolViewerV2.InvalidOrchestrator.selector, address(escrow)));
        viewer.getIntentV4(address(escrow), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(ProtocolViewerV2.InvalidOrchestrator.selector, address(0)));
        viewer.getAccountIntentsV4(address(0), taker);
    }
}
