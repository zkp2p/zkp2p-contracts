// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {WhitelistPreIntentHookV2} from "contracts/hooks/WhitelistPreIntentHookV2.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {WhitelistResolverMock} from "contracts/mocks/WhitelistResolverMock.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IPreIntentHook} from "contracts/interfaces/IPreIntentHook.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

// Benchmark protocol (from the design spec): deposit 0 attaches 10 groups, each with a
// DISTINCT malicious resolver instance (a reused address would be warm after the first call
// under EIP-2929 and understate worst-case gas). Deposit 1 is identically shaped with zero
// groups. Foundry keeps EIP-2929 warmth across an entire test function, so `vm.cool` is
// applied to every participating contract before EACH measurement — both measurements run
// with all account and storage accesses cold, matching the spec's acceptance criterion.
// Setup gas is excluded by measuring only the signalIntent call. Acceptance: delta of
// (ten-malicious-group rejection) - (zero-group rejection) <= 700_000. Tuning order if
// exceeded: RESOLVER_GAS_LIMIT first, MAX_GROUPS_PER_DEPOSIT second.
contract WhitelistPreIntentHookV2GasTest is Test {
    uint256 internal constant CHAIN_ID = 1;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant CONVERSION_RATE = 1.02e18;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payeeDetails");
    uint256 internal constant MAX_REJECTION_DELTA = 700_000;

    address internal depositor;
    address internal taker;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorV3 internal orchestrator;
    OrchestratorRegistry internal orchestratorRegistry;
    EscrowRegistry internal escrowRegistry;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    PaymentVerifierMock internal verifier;
    AddressGroupRegistry internal groupRegistry;
    WhitelistPreIntentHookV2 internal hook;
    address[] internal contractsToCool;

    function setUp() public {
        depositor = makeAddr("depositor");
        taker = makeAddr("taker");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 10_000e6);

        escrowRegistry = new EscrowRegistry();
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        verifier = new PaymentVerifierMock();
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(verifier), currencies);

        escrow = new EscrowV2(
            address(this),
            CHAIN_ID,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(0),
            0,
            10,
            1 hours
        );
        escrowRegistry.addEscrow(address(escrow));
        orchestrator = new OrchestratorV3(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            0,
            address(this),
            2_000_000 // risk callback gas limit (min 750k); no risk hooks are set in these tests
        );
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier.setVerificationContext(address(orchestrator), address(escrow));

        groupRegistry = new AddressGroupRegistry();
        hook = new WhitelistPreIntentHookV2(address(orchestratorRegistry), address(groupRegistry));

        vm.startPrank(depositor);
        token.approve(address(escrow), 10_000e6);
        _createDeposit(); // deposit 0
        _createDeposit(); // deposit 1 (identical shape)
        vm.stopPrank();

        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, IPreIntentHook(address(hook)));
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 1, IPreIntentHook(address(hook)));

        contractsToCool.push(address(token));
        contractsToCool.push(address(escrowRegistry));
        contractsToCool.push(address(paymentVerifierRegistry));
        contractsToCool.push(address(orchestratorRegistry));
        contractsToCool.push(address(verifier));
        contractsToCool.push(address(escrow));
        contractsToCool.push(address(orchestrator));
        contractsToCool.push(address(groupRegistry));
        contractsToCool.push(address(hook));
    }

    function _createDeposit() internal {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({
            code: USD,
            minConversionRate: 1.01e18,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0
            })
        });
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: 100e6,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: address(0),
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _signalParams(uint256 depositId) internal view returns (IOrchestratorV3.SignalIntentParams memory params) {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        params = IOrchestratorV3.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            amount: INTENT_AMOUNT,
            to: taker,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            conversionRate: CONVERSION_RATE,
            referralFees: referralFees,
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHookV2(address(0)),
            preIntentHookData: "",
            data: ""
        });
    }

    function _setupTenMaliciousGroups(WhitelistResolverMock.Mode mode, uint256 payloadSize) internal {
        uint256[] memory ids = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            WhitelistResolverMock malicious = new WhitelistResolverMock();
            malicious.setMode(mode);
            if (payloadSize > 0) malicious.setPayloadSize(payloadSize);
            vm.prank(depositor);
            ids[i] = groupRegistry.createGroup("malicious");
            vm.prank(depositor);
            groupRegistry.setResolver(ids[i], address(malicious));
            contractsToCool.push(address(malicious));
        }
        vm.prank(depositor);
        hook.attachGroups(address(escrow), 0, ids);
    }

    function _coolAll() internal {
        for (uint256 i = 0; i < contractsToCool.length; i++) {
            vm.cool(contractsToCool[i]);
        }
    }

    function _measureRejection(uint256 depositId) internal returns (uint256 gasUsed) {
        IOrchestratorV3.SignalIntentParams memory params = _signalParams(depositId);
        _coolAll();
        vm.prank(taker);
        uint256 gasBefore = gasleft();
        try orchestrator.signalIntent(params) {
            revert("signal should have been rejected");
        } catch (bytes memory reason) {
            gasUsed = gasBefore - gasleft();
            // Both measurements must be rejected by the whitelist hook specifically — a
            // setup failure (payment method, rate, liquidity, ...) would otherwise be
            // silently measured as if it were the path under test.
            assertEq(bytes4(reason), WhitelistPreIntentHookV2.TakerNotWhitelisted.selector);
        }
    }

    function _assertDeltaWithinBudget(string memory label) internal {
        uint256 tenGroupGas = _measureRejection(0);
        uint256 zeroGroupGas = _measureRejection(1);
        uint256 delta = tenGroupGas - zeroGroupGas;
        emit log_named_uint(label, delta);
        assertLe(delta, MAX_REJECTION_DELTA);
    }

    function test_TenStipendBurnerResolversRejectionDeltaWithinBudget() public {
        _setupTenMaliciousGroups(WhitelistResolverMock.Mode.BurnGas, 0);
        _assertDeltaWithinBudget("ten-burner delta");
    }

    function test_TenMaxPayloadResolversRejectionDeltaWithinBudget() public {
        // Max payload constructible under the 50k stipend; first word != 1 so the path rejects.
        _setupTenMaliciousGroups(WhitelistResolverMock.Mode.PayloadReturnNotOne, 96_000);
        _assertDeltaWithinBudget("ten-payload delta");
    }

    function test_TenPayloadRevertResolversRejectionDeltaWithinBudget() public {
        _setupTenMaliciousGroups(WhitelistResolverMock.Mode.PayloadRevert, 96_000);
        _assertDeltaWithinBudget("ten-revert delta");
    }
}
