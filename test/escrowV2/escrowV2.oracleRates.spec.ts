import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  EscrowV2,
  OrchestratorRegistry,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RevertingOracleAdapterMock,
  StaticOracleAdapterMock,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("EscrowV2", () => {
  let owner: any;
  let depositor: any;
  let delegate: any;
  let other: any;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let staticOracleAdapter: StaticOracleAdapterMock;
  let revertingOracleAdapter: RevertingOracleAdapterMock;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;

  beforeEach(async () => {
    [owner, depositor, delegate, other] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    verifier = await deployer.deployPaymentVerifierMock();
    staticOracleAdapter = (await (
      await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
    ).deploy()) as StaticOracleAdapterMock;
    revertingOracleAdapter = (await (
      await ethers.getContractFactory("RevertingOracleAdapterMock", owner.wallet)
    ).deploy()) as RevertingOracleAdapterMock;

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

    await paymentVerifierRegistry
      .connect(owner.wallet)
      .addPaymentMethod(paymentMethod, verifier.address, [Currency.USD, Currency.EUR]);

    escrow = await deployer.deployEscrowV2(
      owner.address,
      ONE,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      ZERO,
      BigNumber.from(20),
      BigNumber.from(60 * 60)
    );

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(100_000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(500),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails,
          data: "0x",
        },
      ],
      currencies: [
        [
          { code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG },
          { code: Currency.EUR, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG },
        ],
      ],
      delegate: delegate.address,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  });

  describe("#createDeposit with inline oracleRateConfig", () => {
    it("sets oracle config during createDeposit and emits DepositOracleRateConfigSet", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.05), BigNumber.from(currentTimestamp)]
      );

      const tx = await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(200),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [paymentMethod],
        paymentMethodData: [
          {
            intentGatingService: ADDRESS_ZERO,
            payeeDetails,
            data: "0x",
          },
        ],
        currencies: [
          [
            {
              code: Currency.USD,
              minConversionRate: ether(1),
              oracleRateConfig: {
                adapter: staticOracleAdapter.address,
                adapterConfig,
                spreadBps: 50,
                maxStaleness: 3600,
              },
            },
          ],
        ],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });

      await expect(tx).to.emit(escrow, "DepositOracleRateConfigSet");

      const depositId = ONE; // second deposit (first created in beforeEach)
      const config = await escrow.getDepositOracleRateConfig(depositId, paymentMethod, Currency.USD);
      expect(config.adapter).to.eq(staticOracleAdapter.address);
      expect(config.spreadBps).to.eq(50);
      expect(config.maxStaleness).to.eq(3600);

      // Verify oracle-based min rate is applied (spread applied to oracle rate)
      const expectedSpread = ether(1.05).mul(10_050).add(9_999).div(10_000);
      expect(await escrow.getDepositCurrencyMinRate(depositId, paymentMethod, Currency.USD)).to.eq(expectedSpread);
    });

    it("skips oracle config when adapter is zero address", async () => {
      const tx = await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(200),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [paymentMethod],
        paymentMethodData: [
          {
            intentGatingService: ADDRESS_ZERO,
            payeeDetails,
            data: "0x",
          },
        ],
        currencies: [
          [
            {
              code: Currency.USD,
              minConversionRate: ether(1),
              oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG,
            },
          ],
        ],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });

      await expect(tx).to.not.emit(escrow, "DepositOracleRateConfigSet");

      const depositId = ONE;
      const config = await escrow.getDepositOracleRateConfig(depositId, paymentMethod, Currency.USD);
      expect(config.adapter).to.eq(ADDRESS_ZERO);
    });
  });

  describe("#setOracleRateConfig", () => {
    let subjectCaller: any;
    let subjectCurrencyCode: BytesLike;
    let subjectSpreadBps: number;
    let subjectMaxStaleness: number;
    let subjectRate: BigNumber;
    let subjectUpdatedAt: BigNumber;

    async function subject() {
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, subjectRate, subjectUpdatedAt]
      );

      return escrow.connect(subjectCaller.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        subjectCurrencyCode,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig,
          spreadBps: subjectSpreadBps,
          maxStaleness: subjectMaxStaleness,
        }
      );
    }

    beforeEach(async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      subjectCaller = depositor;
      subjectCurrencyCode = Currency.USD;
      subjectSpreadBps = 50;
      subjectMaxStaleness = 3600;
      subjectRate = ether(1);
      subjectUpdatedAt = BigNumber.from(currentTimestamp);
    });

    it("sets oracle config and computes spread floor", async () => {
      await expect(subject()).to.emit(escrow, "DepositOracleRateConfigSet");

      const expectedSpread = ether(1).mul(10_000 + subjectSpreadBps).add(9_999).div(10_000);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(expectedSpread);
    });

    it("returns max(fixed, spread)", async () => {
      await escrow.connect(depositor.wallet).setCurrencyMinRate(ZERO, paymentMethod, Currency.USD, ether(1.02));
      await subject();

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.02));
    });

    it("returns zero when oracle is stale (oracle halt)", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      subjectUpdatedAt = BigNumber.from(currentTimestamp - 10_000);
      subjectMaxStaleness = 10;

      await subject();

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("returns zero when oracle quote is invalid (oracle halt)", async () => {
      subjectRate = ZERO;
      await subject();

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("returns zero when oracle timestamp is in the future (oracle halt)", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      subjectUpdatedAt = BigNumber.from(currentTimestamp + 300);
      await subject();

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("returns zero when oracle adapter reverts (oracle halt)", async () => {
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), subjectUpdatedAt]
      );

      await escrow.connect(subjectCaller.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        subjectCurrencyCode,
        {
          adapter: revertingOracleAdapter.address,
          adapterConfig,
          spreadBps: subjectSpreadBps,
          maxStaleness: subjectMaxStaleness,
        }
      );

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("allows delegate to set config", async () => {
      subjectCaller = delegate;

      await expect(subject()).to.emit(escrow, "DepositOracleRateConfigSet");
    });

    describe("when caller is not depositor or delegate", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when normalized adapter config is too long", () => {
      it("reverts", async () => {
        const oversizedConfig = `0x${"11".repeat(257)}`;
        await expect(
          escrow.connect(subjectCaller.wallet).setOracleRateConfig(
            ZERO,
            paymentMethod,
            subjectCurrencyCode,
            {
              adapter: staticOracleAdapter.address,
              adapterConfig: oversizedConfig,
              spreadBps: subjectSpreadBps,
              maxStaleness: subjectMaxStaleness,
            }
          )
        ).to.be.revertedWithCustomError(escrow, "AdapterConfigTooLong");
      });
    });
  });

  describe("#removeOracleRateConfig", () => {
    let subjectCaller: any;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).removeOracleRateConfig(ZERO, paymentMethod, Currency.USD);
    }

    beforeEach(async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      subjectCaller = depositor;

      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.2), BigNumber.from(currentTimestamp)]
      );

      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig,
          spreadBps: 0,
          maxStaleness: 3600,
        }
      );
    });

    it("removes config and falls back to fixed rate", async () => {
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.2));

      await expect(subject())
        .to.emit(escrow, "DepositOracleRateConfigRemoved")
        .withArgs(ZERO, paymentMethod, Currency.USD);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("reverts when tuple is not listed", async () => {
      const unsupported = ethers.utils.formatBytes32String("JPY");
      await expect(
        escrow.connect(subjectCaller.wallet).removeOracleRateConfig(ZERO, paymentMethod, unsupported)
      ).to.be.revertedWithCustomError(escrow, "CurrencyNotSupported");
    });
  });

  describe("#setOracleRateConfigBatch", () => {
    let subjectCaller: any;

    async function subject() {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );
      const eurAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.2), currentTimestamp]
      );

      return escrow.connect(subjectCaller.wallet).setOracleRateConfigBatch(
        ZERO,
        [paymentMethod],
        [[Currency.USD, Currency.EUR]],
        [[
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: usdAdapterConfig,
            spreadBps: 100,
            maxStaleness: 3600,
          },
          {
            adapter: staticOracleAdapter.address,
            adapterConfig: eurAdapterConfig,
            spreadBps: 50,
            maxStaleness: 3600,
          },
        ]]
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
    });

    it("sets multiple configs in one call", async () => {
      await subject();

      const usdExpected = ether(1).mul(10_100).add(9_999).div(10_000);
      const eurExpected = ether(1.2).mul(10_050).add(9_999).div(10_000);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(usdExpected);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.EUR)).to.eq(eurExpected);
    });

    it("reverts when paymentMethods and currencyCodes length mismatch", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );

      await expect(
        escrow.connect(subjectCaller.wallet).setOracleRateConfigBatch(
          ZERO,
          [paymentMethod],
          [],
          [[{
            adapter: staticOracleAdapter.address,
            adapterConfig: usdAdapterConfig,
            spreadBps: 100,
            maxStaleness: 3600,
          }]]
        )
      ).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
    });

    it("reverts when paymentMethods and configs length mismatch", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );

      await expect(
        escrow.connect(subjectCaller.wallet).setOracleRateConfigBatch(
          ZERO,
          [paymentMethod],
          [[Currency.USD]],
          []
        )
      ).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
    });

    it("reverts when nested currencyCodes and configs length mismatch", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );

      await expect(
        escrow.connect(subjectCaller.wallet).setOracleRateConfigBatch(
          ZERO,
          [paymentMethod],
          [[Currency.USD, Currency.EUR]],
          [[{
            adapter: staticOracleAdapter.address,
            adapterConfig: usdAdapterConfig,
            spreadBps: 100,
            maxStaleness: 3600,
          }]]
        )
      ).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
    });
  });

  describe("#updateCurrencyConfigBatch", () => {
    let subjectCaller: any;

    beforeEach(async () => {
      subjectCaller = depositor;
    });

    it("updates fixed floors and optionally applies oracle config changes", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const usdAdapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.04), currentTimestamp]
      );

      await expect(
        escrow.connect(subjectCaller.wallet).updateCurrencyConfigBatch(
          ZERO,
          [paymentMethod],
          [[
            {
              code: Currency.USD,
              minConversionRate: ether(1.01),
              updateOracle: true,
              oracleRateConfig: {
                adapter: staticOracleAdapter.address,
                adapterConfig: usdAdapterConfig,
                spreadBps: 50,
                maxStaleness: 3600,
              },
            },
            {
              code: Currency.EUR,
              minConversionRate: ether(0.97),
              updateOracle: false,
              oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG,
            },
          ]]
        )
      )
        .to.emit(escrow, "DepositMinConversionRateUpdated")
        .withArgs(ZERO, paymentMethod, Currency.USD, ether(1.01))
        .and.to.emit(escrow, "DepositOracleRateConfigSet")
        .withArgs(
          ZERO,
          paymentMethod,
          Currency.USD,
          staticOracleAdapter.address,
          usdAdapterConfig,
          50,
          3600
        )
        .and.to.emit(escrow, "DepositMinConversionRateUpdated")
        .withArgs(ZERO, paymentMethod, Currency.EUR, ether(0.97));

      const usdExpected = ether(1.04).mul(10_050).add(9_999).div(10_000);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(usdExpected);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.EUR)).to.eq(ether(0.97));
    });

    it("removes oracle config when updateOracle is true and adapter is zero", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.2), BigNumber.from(currentTimestamp)]
      );

      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig,
          spreadBps: 0,
          maxStaleness: 3600,
        }
      );

      await expect(
        escrow.connect(subjectCaller.wallet).updateCurrencyConfigBatch(
          ZERO,
          [paymentMethod],
          [[
            {
              code: Currency.USD,
              minConversionRate: ether(1.15),
              updateOracle: true,
              oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG,
            },
          ]]
        )
      )
        .to.emit(escrow, "DepositMinConversionRateUpdated")
        .withArgs(ZERO, paymentMethod, Currency.USD, ether(1.15))
        .and.to.emit(escrow, "DepositOracleRateConfigRemoved")
        .withArgs(ZERO, paymentMethod, Currency.USD);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.15));
      expect((await escrow.getDepositOracleRateConfig(ZERO, paymentMethod, Currency.USD)).adapter).to.eq(ADDRESS_ZERO);
    });

    it("reverts when paymentMethods and updates length mismatch", async () => {
      await expect(
        escrow.connect(subjectCaller.wallet).updateCurrencyConfigBatch(
          ZERO,
          [paymentMethod],
          []
        )
      ).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
    });
  });

  describe("#deactivateCurrenciesBatch", () => {
    let subjectCaller: any;

    beforeEach(async () => {
      subjectCaller = depositor;
    });

    it("deactivates multiple currencies and removes oracle config when present", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.2), BigNumber.from(currentTimestamp)]
      );

      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig,
          spreadBps: 0,
          maxStaleness: 3600,
        }
      );

      const tx = await escrow.connect(subjectCaller.wallet).deactivateCurrenciesBatch(
        ZERO,
        [paymentMethod],
        [[Currency.USD, Currency.EUR]]
      );

      await expect(tx)
        .to.emit(escrow, "DepositMinConversionRateUpdated")
        .withArgs(ZERO, paymentMethod, Currency.USD, ZERO)
        .and.to.emit(escrow, "DepositMinConversionRateUpdated")
        .withArgs(ZERO, paymentMethod, Currency.EUR, ZERO);

      const receipt = await tx.wait();
      const removedEvents = (receipt.events || []).filter((event) => event.event === "DepositOracleRateConfigRemoved");
      expect(removedEvents).to.have.length(1);
      expect(removedEvents[0].args?.currencyCode).to.eq(Currency.USD);

      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
      expect(await escrow.getDepositCurrencyMinRate(ZERO, paymentMethod, Currency.EUR)).to.eq(ZERO);
      expect((await escrow.getDepositOracleRateConfig(ZERO, paymentMethod, Currency.USD)).adapter).to.eq(ADDRESS_ZERO);
    });

    it("reverts when payment method is not active", async () => {
      await escrow.connect(depositor.wallet).setPaymentMethodActive(ZERO, paymentMethod, false);

      await expect(
        escrow.connect(subjectCaller.wallet).deactivateCurrenciesBatch(
          ZERO,
          [paymentMethod],
          [[Currency.USD]]
        )
      ).to.be.revertedWithCustomError(escrow, "PaymentMethodNotActive");
    });

    it("reverts when paymentMethods and currencyCodes length mismatch", async () => {
      await expect(
        escrow.connect(subjectCaller.wallet).deactivateCurrenciesBatch(
          ZERO,
          [paymentMethod],
          []
        )
      ).to.be.revertedWithCustomError(escrow, "ArrayLengthMismatch");
    });
  });

  describe("#setOracleRateConfig unsupported tuple", () => {
    it("reverts when currency is not listed for the payment method", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const unsupported = ethers.utils.formatBytes32String("JPY");
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1), currentTimestamp]
      );

      await expect(
        escrow.connect(depositor.wallet).setOracleRateConfig(
          ZERO,
          paymentMethod,
          unsupported,
          {
            adapter: staticOracleAdapter.address,
            adapterConfig,
            spreadBps: 50,
            maxStaleness: 3600,
          }
        )
      ).to.be.revertedWithCustomError(escrow, "CurrencyNotSupported");
    });
  });
});
