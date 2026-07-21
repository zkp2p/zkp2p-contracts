// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "./EscrowLegacyFixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";

abstract contract OrchestratorLegacyFixture is EscrowLegacyFixture {
    uint256 internal constant CIRCOM_PRIME_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    address internal relayerAccount;

    function setUp() public virtual override {
        super.setUp();
        relayerAccount = makeAddr("relayerAccount");
        postIntentHookRegistry.addPostIntentHook(address(postIntentHookMock));
        _createOrchestratorDeposit(gatingService, 100e6, 10e6, 200e6, 1.01e18);
    }

    function _createOrchestratorDeposit(
        address intentGatingService,
        uint256 amount,
        uint256 minimum,
        uint256 maximum,
        uint256 rate
    ) internal {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.amount = amount;
        params.intentAmountRange = IEscrow.Range({min: minimum, max: maximum});
        params.retainOnEmpty = false;
        params.paymentMethodData[0].intentGatingService = intentGatingService;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: rate});
        _createAsOffRamper(params);
    }

    function _baseSignalParams(address taker) internal view returns (IOrchestrator.SignalIntentParams memory params) {
        params = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: 0,
            amount: 50e6,
            to: receiver,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1.02e18,
            referrer: address(0),
            referrerFee: 0,
            gatingServiceSignature: "",
            signatureExpiration: block.timestamp + 1 days + 10,
            postIntentHook: IPostIntentHook(address(0)),
            data: ""
        });
        params.gatingServiceSignature = _gatingSignature(
            params.depositId,
            params.amount,
            params.to,
            params.paymentMethod,
            params.fiatCurrency,
            params.conversionRate,
            params.signatureExpiration
        );
        taker;
    }

    function _resign(IOrchestrator.SignalIntentParams memory params) internal view returns (bytes memory) {
        return _gatingSignature(
            params.depositId,
            params.amount,
            params.to,
            params.paymentMethod,
            params.fiatCurrency,
            params.conversionRate,
            params.signatureExpiration
        );
    }

    function _callSignal(address caller, IOrchestrator.SignalIntentParams memory params) internal {
        vm.prank(caller);
        orchestrator.signalIntent(params);
    }

    function _signal(address caller, IOrchestrator.SignalIntentParams memory params)
        internal
        returns (bytes32 intentHash)
    {
        intentHash = _nextIntentHash();
        _callSignal(caller, params);
    }

    function _nextIntentHash() internal view returns (bytes32) {
        uint256 intermediateHash =
            uint256(keccak256(abi.encodePacked(address(orchestrator), orchestrator.intentCounter())));
        return bytes32(intermediateHash % CIRCOM_PRIME_FIELD);
    }
}
