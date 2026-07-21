// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {RiskManager} from "contracts/RiskManager.sol";
import {
    RiskManagerOrchestratorHarness,
    RiskManagerVaultHarness,
    RiskManagerEscrowHarness
} from "contracts/mocks/RiskManagerHarnessMocks.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";

abstract contract RiskManagerHarnessFixture is Test {
    uint64 internal constant HOUR = 1 hours;
    uint64 internal constant DAY = 1 days;
    uint64 internal constant PERIOD = 1 hours;
    bytes32 internal constant PAYPAL = keccak256("coverage-paypal");
    bytes32 internal constant ZELLE = keccak256("coverage-zelle");

    address internal taker;
    address internal maker;
    address internal beneficiary;
    address internal other;

    USDCMock internal token;
    RiskManagerOrchestratorHarness internal orchestrator;
    RiskManagerVaultHarness internal vault;
    RiskManagerEscrowHarness internal escrow;
    AttestationVerifierMock internal verifier;
    NullifierRegistry internal legacyRegistry;
    NullifierRegistryV2 internal nullifierRegistry;
    RiskManager internal manager;

    function setUp() public virtual {
        taker = makeAddr("riskTaker");
        maker = makeAddr("riskMaker");
        beneficiary = makeAddr("riskBeneficiary");
        other = makeAddr("riskOther");
        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        orchestrator = new RiskManagerOrchestratorHarness();
        vault = new RiskManagerVaultHarness();
        escrow = new RiskManagerEscrowHarness(PERIOD, maker);
        verifier = new AttestationVerifierMock();
        legacyRegistry = new NullifierRegistry();
        nullifierRegistry = new NullifierRegistryV2(legacyRegistry);
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            IAttestationVerifier(address(verifier)),
            INullifierRegistryV2(address(nullifierRegistry))
        );
        vault.setStakeToken(token);
        escrow.setToken(token);
        escrow.setIntentGuardian(address(manager));
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(false));
        manager.setPlatformRiskConfig(ZELLE, _nonChargebackConfig());
        vault.setTakerState(taker, taker, 100_000e6, 100_000e6, false);
        token.transfer(address(orchestrator), 10_000e6);
    }

    function _chargebackConfig(bool deferredPayoutEnabled)
        internal
        pure
        returns (IRiskManager.PlatformRiskConfig memory)
    {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: true, deferredPayoutEnabled: deferredPayoutEnabled, reserveBps: 10_000, riskWindow: DAY
            }),
            intentExtension: IRiskManager.IntentExtensionConfig({extensionPenaltyBpsPerHour: 10})
        });
    }

    function _nonChargebackConfig() internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: false, deferredPayoutEnabled: false, reserveBps: 0, riskWindow: 0
            }),
            intentExtension: IRiskManager.IntentExtensionConfig({extensionPenaltyBpsPerHour: 10})
        });
    }

    function _setRiskIntent(
        bytes32 intentHash,
        uint256 amount,
        bytes32 paymentMethod,
        uint64 createdAt,
        address owner,
        address payoutRecipient
    ) internal {
        orchestrator.setRiskIntent(
            intentHash,
            IOrchestratorV3.RiskIntentData({
                owner: owner,
                to: payoutRecipient,
                escrow: address(escrow),
                depositId: 0,
                amount: amount,
                paymentMethod: paymentMethod,
                createdAt: createdAt
            })
        );
        escrow.setIntent(intentHash, createdAt);
    }

    function _setDefaultRiskIntent(bytes32 intentHash) internal {
        _setRiskIntent(intentHash, 100e6, PAYPAL, uint64(block.timestamp), taker, beneficiary);
    }

    function _createPosition(bytes32 intentHash) internal {
        _setDefaultRiskIntent(intentHash);
        orchestrator.createPosition(manager, intentHash);
    }
}
