import "module-alias/register";

import { deployments } from "hardhat";

import {
  UnifiedPaymentVerifier,
  PaymentVerifierRegistry,
} from "../../utils/contracts";
import {
  UnifiedPaymentVerifier__factory,
  PaymentVerifierRegistry__factory,
} from "../../typechain";

import {
  getAccounts,
  getWaffleExpect,
} from "../../utils/test";
import { Account } from "../../utils/test/types";

import { ZELLE_PROVIDER_CONFIG } from "../../deployments/verifiers/zelle";
import { LUXON_PROVIDER_CONFIG } from "../../deployments/verifiers/luxon";
import { N26_PROVIDER_CONFIG } from "../../deployments/verifiers/n26";

const expect = getWaffleExpect();

const REMOVED_PAYMENT_METHODS = [
  { name: "N26", config: N26_PROVIDER_CONFIG },
  { name: "Luxon", config: LUXON_PROVIDER_CONFIG },
];

const EXPECTED_ZELLE_PAYMENT_METHOD_HASH = "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3";

describe("Generic Zelle Payment Method Configuration", () => {
  let deployer: Account;

  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let legacyUnifiedPaymentVerifier: UnifiedPaymentVerifier;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;
  let v2VerifierAddress: string;
  let activeVerifierAddress: string;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();

    const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
    paymentVerifierRegistry = new PaymentVerifierRegistry__factory(deployer.wallet).attach(paymentVerifierRegistryAddress);

    const legacyVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
    legacyUnifiedPaymentVerifier = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(legacyVerifierAddress);

    v2VerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    activeVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifierV3");
    unifiedPaymentVerifierV2 = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(v2VerifierAddress);
  });

  it("uses keccak256 zelle as the generic payment method hash", async () => {
    expect(ZELLE_PROVIDER_CONFIG.paymentMethodHash).to.eq(EXPECTED_ZELLE_PAYMENT_METHOD_HASH);
  });

  it("registers generic Zelle in PaymentVerifierRegistry with the active V3 verifier", async () => {
    const isPaymentMethod = await paymentVerifierRegistry.isPaymentMethod(ZELLE_PROVIDER_CONFIG.paymentMethodHash);
    const verifier = await paymentVerifierRegistry.getVerifier(ZELLE_PROVIDER_CONFIG.paymentMethodHash);
    const currencies = await paymentVerifierRegistry.getCurrencies(ZELLE_PROVIDER_CONFIG.paymentMethodHash);

    expect(isPaymentMethod).to.be.true;
    expect(verifier).to.eq(activeVerifierAddress);
    expect(currencies).to.deep.eq(ZELLE_PROVIDER_CONFIG.currencies);
  });

  it("registers generic Zelle in UnifiedPaymentVerifierV2", async () => {
    const paymentMethods = await unifiedPaymentVerifierV2.getPaymentMethods();
    expect(paymentMethods).to.include(ZELLE_PROVIDER_CONFIG.paymentMethodHash);
  });

  for (const { name, config } of REMOVED_PAYMENT_METHODS) {
    it(`removes ${name} from payment method surfaces`, async () => {
      const isPaymentMethod = await paymentVerifierRegistry.isPaymentMethod(config.paymentMethodHash);
      const legacyPaymentMethods = await legacyUnifiedPaymentVerifier.getPaymentMethods();
      const paymentMethods = await unifiedPaymentVerifierV2.getPaymentMethods();

      expect(isPaymentMethod).to.be.false;
      expect(legacyPaymentMethods).to.not.include(config.paymentMethodHash);
      expect(paymentMethods).to.not.include(config.paymentMethodHash);
    });
  }
});
