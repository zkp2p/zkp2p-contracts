// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {TakerRegistrationSigner} from "../helpers/TakerRegistrationSigner.sol";
import {SanctionsListMock} from "../../mocks/SanctionsListMock.sol";
import {RegistryIntentSignalPolicy} from "contracts/hooks/RegistryIntentSignalPolicy.sol";
import {IAddressGroupRegistry} from "contracts/interfaces/IAddressGroupRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {ISanctionsList} from "contracts/interfaces/ISanctionsList.sol";
import {ITakerRegistry} from "contracts/interfaces/ITakerRegistry.sol";
import {IWhitelistPolicyV2} from "contracts/interfaces/IWhitelistPolicyV2.sol";
import {TakerRegistry} from "contracts/registries/TakerRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

contract RegistryIntentSignalPolicyTest is OrchestratorV4Fixture, TakerRegistrationSigner {
    bytes32 internal constant OTHER_METHOD = keccak256("revolut");
    bytes32 internal constant IDENTITY = keccak256("identity");
    bytes32 internal constant OTHER_IDENTITY = keccak256("other identity");
    uint256 internal constant DEFAULT_FEE = 295e14;
    uint256 internal constant VENMO_FEE = 395e14;
    uint256 internal constant VENMO_FEE_BELOW_THRESHOLD = 495e14;
    uint256 internal constant VENMO_THRESHOLD_RATE = 95e16;
    uint256 internal constant MAX_REFERRAL_SHARE = 5e15;
    uint256 internal constant MAX_OPEN_INTENTS = 2;
    uint256 internal constant MAX_DAILY_INTENTS = 4;
    uint64 internal constant START = 30 days;

    uint256 internal attestorKey;
    address internal attestor;
    address internal revoker;
    address internal guardian;
    address internal feeRecipient;
    address internal integrator;
    bytes32 internal integratorGroupId;
    IAddressGroupRegistry internal groupRegistry;
    SanctionsListMock internal sanctionsList;
    TakerRegistry internal takerRegistry;
    RegistryIntentSignalPolicy internal policy;

    event NewIntentsStopped(bytes32 indexed paymentMethod, uint256 until);

    function setUp() public override {
        super.setUp();
        (attestor, attestorKey) = makeAddrAndKey("attestor");
        revoker = makeAddr("revoker");
        guardian = makeAddr("guardian");
        feeRecipient = makeAddr("feeRecipient");
        integrator = makeAddr("integrator");
        vm.warp(START);

        groupRegistry = whitelist.groupRegistry();
        integratorGroupId = groupRegistry.createGroup("Integrators");
        groupRegistry.addMembers(integratorGroupId, _addresses(integrator));
        sanctionsList = new SanctionsListMock();
        takerRegistry = new TakerRegistry(address(this), revoker);
        takerRegistry.setAttestor(attestor, true);

        policy = new RegistryIntentSignalPolicy(_config());
        orchestrator.setSignalPolicy(policy);
        _register(taker, METHOD, IDENTITY);
    }

    /* ============ Registration ============ */

    function test_AdmitsRegisteredTakerWithoutSignature() public {
        IOrchestratorV4.SignalIntentParams memory params = _feeParams();
        params.gatingServiceSignature = hex"deadbeef";
        params.signatureExpiration = 0;
        bytes32 intentHash = _intentHash(orchestrator.intentCounter());

        _signalRaw(taker, params);

        IOrchestratorV4.Intent memory intent = orchestrator.getIntent(intentHash);
        assertEq(intent.owner, taker);
        assertFalse(intent.takerWhitelisted);
        assertEq(intent.arbitrator, address(0));
    }

    function test_RecordsTheHashTheOrchestratorAssigns() public {
        vm.recordLogs();
        _signalRaw(taker, _feeParams());
        Vm.Log memory signal = vm.getRecordedLogs()[0];
        assertEq(
            signal.topics[0],
            keccak256(
                "IntentSignaled(bytes32,address,uint256,bytes32,address,address,uint256,bytes32,uint256,uint256,bytes32,address)"
            )
        );
        bytes32 signaled = signal.topics[1];

        bytes32[] memory open = policy.getOpenIntents(IDENTITY);
        assertEq(open.length, 1);
        assertEq(open[0], signaled);
        assertEq(orchestrator.getIntent(signaled).owner, taker);
    }

    function test_RejectsDirectCalls() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.UnauthorizedCaller.selector, taker, address(orchestrator)
            )
        );
        vm.prank(taker);
        policy.validateSignalIntent(taker, _feeParams());
        assertEq(policy.getOpenIntents(IDENTITY).length, 0);
    }

    function test_RejectsUnregisteredTaker() public {
        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.TakerNotRegistered.selector, other, METHOD)
        );
        _signalRaw(other, _feeParams());
    }

    function test_RejectsRegistrationOnAnotherMethod() public {
        _register(other, OTHER_METHOD, OTHER_IDENTITY);

        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.TakerNotRegistered.selector, other, METHOD)
        );
        _signalRaw(other, _feeParams());
    }

    function test_RejectsUnregisteredWallet() public {
        vm.prank(taker);
        takerRegistry.unregister(METHOD);

        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.TakerNotRegistered.selector, taker, METHOD)
        );
        _signalRaw(taker, _feeParams());
    }

    function test_RejectsLapsedRegistration() public {
        uint256 validUntil = START + 30 days;
        vm.warp(validUntil - 1);
        _signalRaw(taker, _feeParams());

        vm.warp(validUntil);
        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.RegistrationExpired.selector, validUntil, validUntil)
        );
        _signalRaw(taker, _feeParams());
    }

    function test_RejectsRevokedIdentityUntilReinstated() public {
        bytes32[] memory identities = new bytes32[](1);
        identities[0] = IDENTITY;
        vm.prank(revoker);
        takerRegistry.revoke(identities);

        vm.expectRevert(abi.encodeWithSelector(RegistryIntentSignalPolicy.IdentityIsRevoked.selector, IDENTITY));
        _signalRaw(taker, _feeParams());

        takerRegistry.reinstate(IDENTITY);
        _signalRaw(taker, _feeParams());
    }

    function test_RejectsPayerCommitment() public {
        IOrchestratorV4.SignalIntentParams memory params = _feeParams();
        params.payerCommitment = "payer";

        vm.expectRevert(RegistryIntentSignalPolicy.PayerCommitmentNotSupported.selector);
        _signalRaw(taker, params);
    }

    function test_RejectsSanctionedTakerAndRecipient() public {
        sanctionsList.setSanctioned(taker, true);
        vm.expectRevert(abi.encodeWithSelector(RegistryIntentSignalPolicy.Sanctioned.selector, taker));
        _signalRaw(taker, _feeParams());

        sanctionsList.setSanctioned(taker, false);
        sanctionsList.setSanctioned(other, true);
        IOrchestratorV4.SignalIntentParams memory params = _feeParams();
        params.to = other;
        vm.expectRevert(abi.encodeWithSelector(RegistryIntentSignalPolicy.Sanctioned.selector, other));
        _signalRaw(taker, params);
    }

    /* ============ Open intent limit ============ */

    function test_LimitsOpenIntentsPerIdentityAcrossWallets() public {
        _register(other, METHOD, IDENTITY);
        _signalRaw(taker, _feeParams());
        _signalRaw(other, _feeParams());

        bytes memory limitReached = abi.encodeWithSelector(
            RegistryIntentSignalPolicy.OpenIntentLimitReached.selector, IDENTITY, MAX_OPEN_INTENTS
        );
        vm.expectRevert(limitReached);
        _signalRaw(taker, _feeParams());
        vm.expectRevert(limitReached);
        _signalRaw(other, _feeParams());
    }

    function test_AnotherIdentityHasItsOwnLimit() public {
        _register(other, METHOD, OTHER_IDENTITY);
        _signalRaw(taker, _feeParams());
        _signalRaw(taker, _feeParams());

        _signalRaw(other, _feeParams());
        assertEq(policy.getOpenIntents(OTHER_IDENTITY).length, 1);
    }

    function test_CancelledIntentFreesASlot() public {
        bytes32 first = _signalFee(taker);
        _signalFee(taker);
        vm.prank(taker);
        orchestrator.cancelIntent(first);

        bytes32 third = _signalFee(taker);
        bytes32[] memory open = policy.getOpenIntents(IDENTITY);
        assertEq(open.length, 2);
        assertTrue(open[0] != first && open[1] != first);
        assertTrue(open[0] == third || open[1] == third);
    }

    function test_FulfilledIntentFreesASlot() public {
        bytes32 first = _signalFee(taker);
        _signalFee(taker);
        _fulfill(first, INTENT_AMOUNT, CONVERSION_RATE);

        _signalFee(taker);
        assertEq(policy.getOpenIntents(IDENTITY).length, 2);
    }

    function test_ReleasedIntentFreesASlot() public {
        bytes32 first = _signalFee(taker);
        _signalFee(taker);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(first, INTENT_AMOUNT);

        _signalFee(taker);
        assertEq(policy.getOpenIntents(IDENTITY).length, 2);
    }

    function test_ExpiredIntentFreesASlotWithoutPruning() public {
        bytes32 first = _signalFee(taker);
        vm.warp(START + 30 minutes);
        bytes32 second = _signalFee(taker);

        vm.warp(START + 1 hours - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.OpenIntentLimitReached.selector, IDENTITY, MAX_OPEN_INTENTS
            )
        );
        _signalRaw(taker, _feeParams());

        vm.warp(START + 1 hours);
        bytes32 third = _signalFee(taker);
        assertEq(orchestrator.getIntent(first).owner, taker);
        bytes32[] memory open = policy.getOpenIntents(IDENTITY);
        assertEq(open.length, 2);
        assertTrue(open[0] == second || open[1] == second);
        assertTrue(open[0] == third || open[1] == third);
    }

    /* ============ Daily limit ============ */

    function test_LimitsIntentsPerIdentityPerDay() public {
        vm.warp(40 days);
        for (uint256 i = 0; i < MAX_DAILY_INTENTS; i++) {
            bytes32 intentHash = _signalFee(taker);
            vm.prank(taker);
            orchestrator.cancelIntent(intentHash);
        }

        vm.warp(41 days - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.DailyIntentLimitReached.selector, IDENTITY, MAX_DAILY_INTENTS
            )
        );
        _signalRaw(taker, _feeParams());

        vm.warp(41 days);
        _signalRaw(taker, _feeParams());
    }

    /* ============ Service fee ============ */

    function test_RequiredServiceFeeFollowsMethodAndDepositRate() public {
        assertEq(policy.requiredServiceFee(address(escrow), depositId, METHOD, USD), VENMO_FEE);

        uint256 cheapDepositId = _createDepositAtRate(VENMO_THRESHOLD_RATE - 1);
        assertEq(policy.requiredServiceFee(address(escrow), cheapDepositId, METHOD, USD), VENMO_FEE_BELOW_THRESHOLD);

        uint256 thresholdDepositId = _createDepositAtRate(VENMO_THRESHOLD_RATE);
        assertEq(policy.requiredServiceFee(address(escrow), thresholdDepositId, METHOD, USD), VENMO_FEE);
    }

    function test_UnconfiguredMethodTakesDefaultFee() public {
        RegistryIntentSignalPolicy.Config memory config = _config();
        config.serviceFeeMethods = new bytes32[](0);
        config.serviceFees = new RegistryIntentSignalPolicy.ServiceFee[](0);
        RegistryIntentSignalPolicy defaultOnly = new RegistryIntentSignalPolicy(config);

        assertEq(defaultOnly.requiredServiceFee(address(escrow), depositId, METHOD, USD), DEFAULT_FEE);
    }

    function test_RejectsMissingOrShortServiceFee() public {
        vm.expectRevert(abi.encodeWithSelector(RegistryIntentSignalPolicy.ServiceFeeTooLow.selector, 0, VENMO_FEE));
        _signalRaw(taker, _defaultParams());

        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _fees(feeRecipient, VENMO_FEE - 1, address(0), 0);
        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.ServiceFeeTooLow.selector, VENMO_FEE - 1, VENMO_FEE)
        );
        _signalRaw(taker, params);
    }

    function test_ChargesBelowThresholdFeeOnCheapDeposit() public {
        IOrchestratorV4.SignalIntentParams memory params = _feeParams();
        params.depositId = _createDepositAtRate(VENMO_THRESHOLD_RATE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.ServiceFeeTooLow.selector, VENMO_FEE, VENMO_FEE_BELOW_THRESHOLD
            )
        );
        _signalRaw(taker, params);

        params.referralFees = _fees(feeRecipient, VENMO_FEE_BELOW_THRESHOLD, address(0), 0);
        _signalRaw(taker, params);
    }

    function test_ReferralShareIsCappedAndCannotReplaceTheFee() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _fees(feeRecipient, VENMO_FEE - MAX_REFERRAL_SHARE - 1, referrer, MAX_REFERRAL_SHARE + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.ServiceFeeTooLow.selector,
                VENMO_FEE - MAX_REFERRAL_SHARE - 1,
                VENMO_FEE - MAX_REFERRAL_SHARE
            )
        );
        _signalRaw(taker, params);

        params.referralFees = _fees(referrer, VENMO_FEE, address(0), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.ServiceFeeTooLow.selector, 0, VENMO_FEE - MAX_REFERRAL_SHARE
            )
        );
        _signalRaw(taker, params);

        params.referralFees = _fees(feeRecipient, VENMO_FEE - MAX_REFERRAL_SHARE, referrer, MAX_REFERRAL_SHARE);
        _signalRaw(taker, params);
    }

    /* ============ Integrator group ============ */

    function test_IntegratorSkipsRegistrationLimitsAndFee() public {
        for (uint256 i = 0; i < MAX_DAILY_INTENTS + 1; i++) {
            _signalRaw(integrator, _defaultParams());
        }
        assertEq(orchestrator.getAccountIntents(integrator).length, MAX_DAILY_INTENTS + 1);
    }

    function test_IntegratorStillStoppedSanctionedAndWhitelisted() public {
        _whitelist(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, integrator
            )
        );
        _signalRaw(integrator, _defaultParams());

        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, false);
        sanctionsList.setSanctioned(integrator, true);
        vm.expectRevert(abi.encodeWithSelector(RegistryIntentSignalPolicy.Sanctioned.selector, integrator));
        _signalRaw(integrator, _defaultParams());

        sanctionsList.setSanctioned(integrator, false);
        vm.prank(guardian);
        policy.stopNewIntents(METHOD, block.timestamp + 1 hours);
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.NewIntentsAreStopped.selector, METHOD, block.timestamp + 1 hours
            )
        );
        _signalRaw(integrator, _defaultParams());
    }

    function test_RemovedIntegratorNeedsRegistration() public {
        groupRegistry.removeMembers(integratorGroupId, _addresses(integrator));

        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.TakerNotRegistered.selector, integrator, METHOD)
        );
        _signalRaw(integrator, _defaultParams());
    }

    /* ============ Deposit whitelist ============ */

    function test_WhitelistAppliesOnTopOfRegistration() public {
        _register(other, METHOD, OTHER_IDENTITY);
        _whitelist(other);

        vm.expectRevert(
            abi.encodeWithSelector(
                RegistryIntentSignalPolicy.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, taker
            )
        );
        _signalRaw(taker, _feeParams());

        bytes32 intentHash = _signalFee(other);
        assertTrue(orchestrator.getIntent(intentHash).takerWhitelisted);
    }

    function test_WhitelistedTakerStillNeedsRegistration() public {
        _whitelist(other);

        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.TakerNotRegistered.selector, other, METHOD)
        );
        _signalRaw(other, _feeParams());
    }

    function test_GroupTakerGetsGroupArbitrator() public {
        address arbitrator = makeAddr("arbitrator");
        bytes32 groupId = groupRegistry.createGroup("Buyers");
        groupRegistry.addMembers(groupId, _addresses(taker));
        groupRegistry.setArbitrator(groupId, arbitrator);
        bytes32[] memory groupIds = new bytes32[](1);
        groupIds[0] = groupId;
        vm.startPrank(depositor);
        whitelist.setGroups(address(escrow), depositId, groupIds, true);
        whitelist.setEnabled(address(escrow), depositId, true);
        vm.stopPrank();

        IOrchestratorV4.SignalIntentParams memory params = _feeParams();
        params.groupId = groupId;
        bytes32 intentHash = _intentHash(orchestrator.intentCounter());
        _signalRaw(taker, params);

        assertEq(orchestrator.getIntent(intentHash).arbitrator, arbitrator);
        assertTrue(orchestrator.getIntent(intentHash).takerWhitelisted);
    }

    /* ============ Stop ============ */

    function test_GuardianStopsOneMethodUntilItLapses() public {
        uint256 until = block.timestamp + 1 hours;
        vm.expectEmit(address(policy));
        emit NewIntentsStopped(METHOD, until);
        vm.prank(guardian);
        policy.stopNewIntents(METHOD, until);

        vm.warp(until - 1);
        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.NewIntentsAreStopped.selector, METHOD, until)
        );
        _signalRaw(taker, _feeParams());

        vm.warp(until);
        _signalRaw(taker, _feeParams());
    }

    function test_GuardianStopsEveryMethodAndLiftsEarly() public {
        bytes32 all = policy.ALL_PAYMENT_METHODS();
        uint256 until = block.timestamp + policy.MAX_STOP_DURATION();
        vm.prank(guardian);
        policy.stopNewIntents(all, until);

        vm.expectRevert(abi.encodeWithSelector(RegistryIntentSignalPolicy.NewIntentsAreStopped.selector, all, until));
        _signalRaw(taker, _feeParams());

        vm.prank(guardian);
        policy.stopNewIntents(all, 0);
        _signalRaw(taker, _feeParams());
    }

    function test_StopLeavesOpenIntentsSettleable() public {
        bytes32 intentHash = _signalFee(taker);
        bytes32 all = policy.ALL_PAYMENT_METHODS();
        vm.prank(guardian);
        policy.stopNewIntents(all, block.timestamp + 1 hours);

        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_RejectsStopFromOthersOrBeyondMaximum() public {
        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.UnauthorizedCaller.selector, address(this), guardian)
        );
        policy.stopNewIntents(METHOD, block.timestamp + 1 hours);

        uint256 maximum = block.timestamp + policy.MAX_STOP_DURATION();
        vm.expectRevert(
            abi.encodeWithSelector(RegistryIntentSignalPolicy.StopExceedsMaximum.selector, maximum + 1, maximum)
        );
        vm.prank(guardian);
        policy.stopNewIntents(METHOD, maximum + 1);
    }

    /* ============ Constructor ============ */

    function test_ConstructorRejectsMissingDependenciesAndMismatchedFees() public {
        RegistryIntentSignalPolicy.Config memory config = _config();
        config.orchestrator = address(0);
        vm.expectRevert(RegistryIntentSignalPolicy.ZeroAddress.selector);
        new RegistryIntentSignalPolicy(config);

        config = _config();
        config.registry = ITakerRegistry(address(0));
        vm.expectRevert(RegistryIntentSignalPolicy.ZeroAddress.selector);
        new RegistryIntentSignalPolicy(config);

        config = _config();
        config.whitelistPolicy = IWhitelistPolicyV2(address(0));
        vm.expectRevert(RegistryIntentSignalPolicy.ZeroAddress.selector);
        new RegistryIntentSignalPolicy(config);

        config = _config();
        config.sanctionsList = ISanctionsList(address(0));
        vm.expectRevert(RegistryIntentSignalPolicy.ZeroAddress.selector);
        new RegistryIntentSignalPolicy(config);

        config = _config();
        config.feeRecipient = address(0);
        vm.expectRevert(RegistryIntentSignalPolicy.ZeroAddress.selector);
        new RegistryIntentSignalPolicy(config);

        config = _config();
        config.serviceFeeMethods = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(RegistryIntentSignalPolicy.ArrayLengthMismatch.selector, 0, 1));
        new RegistryIntentSignalPolicy(config);
    }

    /* ============ Helpers ============ */

    function _config() internal view returns (RegistryIntentSignalPolicy.Config memory config) {
        config.orchestrator = address(orchestrator);
        config.registry = takerRegistry;
        config.whitelistPolicy = whitelist;
        config.sanctionsList = sanctionsList;
        config.integratorGroupId = integratorGroupId;
        config.guardian = guardian;
        config.feeRecipient = feeRecipient;
        config.maxReferralShare = MAX_REFERRAL_SHARE;
        config.maxOpenIntents = MAX_OPEN_INTENTS;
        config.maxDailyIntents = MAX_DAILY_INTENTS;
        config.defaultServiceFee = RegistryIntentSignalPolicy.ServiceFee({
            fee: uint64(DEFAULT_FEE), feeBelowThreshold: uint64(DEFAULT_FEE), thresholdRate: 0
        });
        config.serviceFeeMethods = new bytes32[](1);
        config.serviceFeeMethods[0] = METHOD;
        config.serviceFees = new RegistryIntentSignalPolicy.ServiceFee[](1);
        config.serviceFees[0] = RegistryIntentSignalPolicy.ServiceFee({
            fee: uint64(VENMO_FEE),
            feeBelowThreshold: uint64(VENMO_FEE_BELOW_THRESHOLD),
            thresholdRate: uint128(VENMO_THRESHOLD_RATE)
        });
    }

    function _register(address wallet, bytes32 method, bytes32 identityId) internal {
        ITakerRegistry.TakerRegistration memory statement = ITakerRegistry.TakerRegistration({
            wallet: wallet,
            method: method,
            identityId: identityId,
            issuedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 30 days)
        });
        takerRegistry.register(statement, _signRegistration(attestorKey, takerRegistry, statement));
    }

    function _feeParams() internal view returns (IOrchestratorV4.SignalIntentParams memory params) {
        params = _defaultParams();
        params.referralFees = _fees(feeRecipient, VENMO_FEE, address(0), 0);
    }

    function _signalFee(address caller) internal returns (bytes32 intentHash) {
        intentHash = _intentHash(orchestrator.intentCounter());
        _signalRaw(caller, _feeParams());
    }

    function _fees(address first, uint256 firstFee, address second, uint256 secondFee)
        internal
        pure
        returns (IReferralFee.ReferralFee[] memory fees)
    {
        fees = new IReferralFee.ReferralFee[](second == address(0) ? 1 : 2);
        fees[0] = IReferralFee.ReferralFee({recipient: first, fee: firstFee});
        if (second != address(0)) fees[1] = IReferralFee.ReferralFee({recipient: second, fee: secondFee});
    }

    function _addresses(address account) internal pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = account;
    }

    function _createDepositAtRate(uint256 rate) internal returns (uint256 id) {
        id = escrow.depositCounter();
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: rate, oracleRateConfig: _emptyOracle()});
        vm.prank(depositor);
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: 500e6,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: delegate,
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }
}
