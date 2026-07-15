import "module-alias/register";

import { deployments } from "hardhat";

import {
  PaymentVerifierRegistry,
  UnifiedPaymentVerifier,
} from "../../utils/contracts";
import {
  PaymentVerifierRegistry__factory,
  UnifiedPaymentVerifier__factory,
} from "../../typechain";
import { getAccounts, getWaffleExpect } from "../../utils/test";
import { Account } from "../../utils/test/types";
import { ZELLE_PROVIDER_CONFIG } from "../../deployments/verifiers/zelle";

const expect = getWaffleExpect();
const EXPECTED_ZELLE_PAYMENT_METHOD_HASH =
  "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3";

describe("Zelle Payment Method Configuration", () => {
  let deployer: Account;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;

  const network = deployments.getNetworkName();

  function getDeployedContractAddress(contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();

    paymentVerifierRegistry = new PaymentVerifierRegistry__factory(deployer.wallet).attach(
      getDeployedContractAddress("PaymentVerifierRegistry")
    );
    unifiedPaymentVerifierV2 = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(
      getDeployedContractAddress("UnifiedPaymentVerifierV2")
    );
  });

  it("uses the generic Zelle payment method hash", () => {
    expect(ZELLE_PROVIDER_CONFIG.paymentMethodHash).to.eq(EXPECTED_ZELLE_PAYMENT_METHOD_HASH);
  });

  it("registers generic Zelle with its currencies", async () => {
    const isPaymentMethod = await paymentVerifierRegistry.isPaymentMethod(
      ZELLE_PROVIDER_CONFIG.paymentMethodHash
    );
    const currencies = await paymentVerifierRegistry.getCurrencies(
      ZELLE_PROVIDER_CONFIG.paymentMethodHash
    );

    expect(isPaymentMethod).to.be.true;
    expect(currencies).to.deep.eq(ZELLE_PROVIDER_CONFIG.currencies);
  });

  it("registers generic Zelle in the unified verifier", async () => {
    const paymentMethods = await unifiedPaymentVerifierV2.getPaymentMethods();
    expect(paymentMethods).to.include(ZELLE_PROVIDER_CONFIG.paymentMethodHash);
  });
});
