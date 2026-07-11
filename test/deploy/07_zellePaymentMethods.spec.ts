import "module-alias/register";

import { deployments, ethers } from "hardhat";

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
import {
  ZELLE_CITI_PAYMENT_METHOD_HASH,
  ZELLE_CHASE_PAYMENT_METHOD_HASH,
  ZELLE_BOFA_PAYMENT_METHOD_HASH,
} from "../../deployments/verifiers/zelle";

const expect = getWaffleExpect();

describe("Legacy Zelle Payment Methods Retirement", () => {
  let deployer: Account;

  let unifiedPaymentVerifier: UnifiedPaymentVerifier;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;
  let paymentVerifierRegistry: PaymentVerifierRegistry;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();

    const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
    paymentVerifierRegistry = new PaymentVerifierRegistry__factory(deployer.wallet).attach(paymentVerifierRegistryAddress);

    const unifiedPaymentVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
    unifiedPaymentVerifier = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(unifiedPaymentVerifierAddress);

    const unifiedPaymentVerifierV2Address = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    unifiedPaymentVerifierV2 = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(unifiedPaymentVerifierV2Address);
  });

  for (const [name, paymentMethodHash] of [
    ["Zelle Citi", ZELLE_CITI_PAYMENT_METHOD_HASH],
    ["Zelle Chase", ZELLE_CHASE_PAYMENT_METHOD_HASH],
    ["Zelle BofA", ZELLE_BOFA_PAYMENT_METHOD_HASH],
  ] as const) {
    it(`removes ${name} from every active payment method surface`, async () => {
      expect(await paymentVerifierRegistry.isPaymentMethod(paymentMethodHash)).to.be.false;
      expect(await unifiedPaymentVerifier.getPaymentMethods()).to.not.include(paymentMethodHash);
      expect(await unifiedPaymentVerifierV2.getPaymentMethods()).to.not.include(paymentMethodHash);
    });
  }
});
