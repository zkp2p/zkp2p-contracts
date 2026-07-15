import "module-alias/register";

import { deployments, ethers, } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import {
  BasePaymentVerifier,
  NullifierRegistry,
  Escrow,
  ZelleBaseVerifier,
  ZelleBoAReclaimVerifier,
  USDCMock
} from "@utils/contracts";
import { Address, ReclaimProof } from "@utils/types";
import { usdc, ether } from "@utils/common";

import {
  getAccounts,
  getWaffleExpect,
} from "@utils/test";
import {
  Account
} from "@utils/test/types";
import { Currency } from "@utils/protocolUtils";

import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO } from "@utils/constants";
import { ZERO_BYTES32 } from "@utils/constants";
import { encodeProofWithPaymentMethod, parseExtensionProof } from "@utils/reclaimUtils";
import { encodeProof } from "@utils/reclaimUtils";

const expect = getWaffleExpect();

const zelleBoAExtensionProof = {
  "claim": {
    "provider": "http",
    "parameters": "{\"body\":\"{\\\"filterV1\\\":{\\\"dateFilter\\\":{\\\"timeframeForHistory\\\":\\\"DEFAULTDAYS\\\"}},\\\"sortCriteriaV1\\\":{\\\"fieldName\\\":\\\"DATE\\\",\\\"order\\\":\\\"DESCENDING\\\"},\\\"pageInfo\\\":{\\\"pageNum\\\":1,\\\"pageSize\\\":\\\"\\\"}}\",\"headers\":{\"Accept\":\"application/json, text/javascript, */*; q=0.01\",\"Accept-Language\":\"en-US,en;q=0.9\",\"Content-Type\":\"application/json; charset=utf-8\",\"Referer\":\"https://secure.bankofamerica.com/myaccounts/signin/signIn.go?returnSiteIndicator=GAIMW&langPref=en-us&request_locale=en-us&capturemode=N&newuser=false&bcIP=F\",\"Sec-Fetch-Dest\":\"empty\",\"Sec-Fetch-Mode\":\"cors\",\"Sec-Fetch-Site\":\"same-origin\",\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36\",\"X-Requested-With\":\"XMLHttpRequest\",\"sec-ch-ua\":\"\\\"Chromium\\\";v=\\\"136\\\", \\\"Google Chrome\\\";v=\\\"136\\\", \\\"Not.A/Brand\\\";v=\\\"99\\\"\",\"sec-ch-ua-mobile\":\"?0\",\"sec-ch-ua-platform\":\"\\\"macOS\\\"\"},\"method\":\"POST\",\"paramValues\":{},\"responseMatches\":[{\"type\":\"regex\",\"value\":\"\\\"confirmationNumber\\\":\\\"(?<confirmationNumber>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"status\\\":\\\"(?<status>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"transactionDate\\\":\\\"(?<transactionDate>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"amount\\\":(?<amount>[0-9\\\\.]+)\"},{\"hash\":true,\"type\":\"regex\",\"value\":\"\\\"aliasToken\\\":\\\"(?<aliasToken>[^\\\"]+)\\\"\"}],\"responseRedactions\":[{\"jsonPath\":\"$.completedTransactions[0].confirmationNumber\",\"xPath\":\"\"},{\"jsonPath\":\"$.completedTransactions[0].status\",\"xPath\":\"\"},{\"jsonPath\":\"$.completedTransactions[0].transactionDate\",\"xPath\":\"\"},{\"jsonPath\":\"$.completedTransactions[0].amount\",\"xPath\":\"\"},{\"jsonPath\":\"$.completedTransactions[0].targetAccount.aliasToken\",\"xPath\":\"\"}],\"url\":\"https://secure.bankofamerica.com/ogateway/payment-activity/api/v4/activity\"}",
    "owner": "0xf9f25d1b846625674901ace47d6313d1ac795265",
    "timestampS": 1748429704,
    "context": "{\"contextAddress\":\"0x0\",\"contextMessage\":\"18385055337294286813491339477905244139745664491486943658289276301683553013461\",\"extractedParameters\":{\"aliasToken\":\"0x907677337cbb16e036508f13be415d848b3b8237d038189fa94825fe05f64614\",\"amount\":\"1.0\",\"confirmationNumber\":\"jqaa7v4iw\",\"status\":\"COMPLETED\",\"transactionDate\":\"2025-05-27\"},\"providerHash\":\"0x05eecaa422b995a513376f7ae0b3a16fab2bdcb7fb1eff38891475b56869a1bd\"}",
    "identifier": "0x51550fb9723574f45d83c9b375194a5ea7d1de9b1cdce2f533892bea1f86a828",
    "epoch": 1
  },
  "signatures": {
    "attestorAddress": "0x0636c417755e3ae25c6c166d181c0607f4c572a3",
    "claimSignature": { "0": 118, "1": 18, "2": 236, "3": 36, "4": 235, "5": 58, "6": 11, "7": 172, "8": 82, "9": 85, "10": 83, "11": 139, "12": 116, "13": 169, "14": 211, "15": 10, "16": 12, "17": 160, "18": 241, "19": 11, "20": 242, "21": 146, "22": 244, "23": 240, "24": 50, "25": 172, "26": 10, "27": 241, "28": 35, "29": 96, "30": 233, "31": 13, "32": 97, "33": 227, "34": 121, "35": 233, "36": 58, "37": 28, "38": 118, "39": 125, "40": 24, "41": 197, "42": 149, "43": 0, "44": 198, "45": 114, "46": 254, "47": 227, "48": 125, "49": 195, "50": 112, "51": 105, "52": 8, "53": 125, "54": 57, "55": 150, "56": 8, "57": 66, "58": 52, "59": 211, "60": 155, "61": 212, "62": 147, "63": 199, "64": 27 },
    "resultSignature": { "0": 4, "1": 32, "2": 17, "3": 89, "4": 221, "5": 176, "6": 48, "7": 12, "8": 85, "9": 23, "10": 125, "11": 218, "12": 113, "13": 73, "14": 202, "15": 117, "16": 18, "17": 37, "18": 135, "19": 32, "20": 150, "21": 6, "22": 18, "23": 172, "24": 254, "25": 86, "26": 161, "27": 27, "28": 247, "29": 239, "30": 201, "31": 198, "32": 23, "33": 109, "34": 93, "35": 116, "36": 149, "37": 214, "38": 144, "39": 234, "40": 239, "41": 199, "42": 135, "43": 111, "44": 58, "45": 125, "46": 112, "47": 106, "48": 78, "49": 136, "50": 199, "51": 62, "52": 17, "53": 162, "54": 5, "55": 16, "56": 175, "57": 33, "58": 17, "59": 91, "60": 243, "61": 122, "62": 148, "63": 4, "64": 28 }
  }
}

describe("ZelleBaseVerifier", () => {
  let owner: Account;
  let user: Account;
  let escrow: Account;

  let zelleBaseVerifier: ZelleBaseVerifier;
  let zelleBoAReclaimVerifier: ZelleBoAReclaimVerifier;
  let nullifierRegistry: NullifierRegistry;
  let usdcToken: USDCMock;
  let mockVerifier: any;

  let deployer: DeployHelper;

  before(async () => {
    [
      owner,
      user,
      escrow
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    nullifierRegistry = await deployer.deployNullifierRegistry();
    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");


    zelleBaseVerifier = await deployer.deployZelleBaseVerifier(
      escrow.address,
      nullifierRegistry.address,
      BigNumber.from(86400),  // Not relevant as it's not used
      [Currency.USD]
    );

    const providerHashes = ["0x05eecaa422b995a513376f7ae0b3a16fab2bdcb7fb1eff38891475b56869a1bd"];


    zelleBoAReclaimVerifier = await deployer.deployZelleBoAReclaimVerifier(
      zelleBaseVerifier.address,
      nullifierRegistry.address,
      providerHashes,
      BigNumber.from(86400)
    );

    await nullifierRegistry.connect(owner.wallet).addWritePermission(zelleBoAReclaimVerifier.address);
  });

  describe("Constructor", async () => {
    it("should set the correct parameters", async () => {
      const actualOwner = await zelleBaseVerifier.owner();
      const actualEscrowAddress = await zelleBaseVerifier.escrow();
      const actualNullifierRegistryAddress = await zelleBaseVerifier.nullifierRegistry();
      const actualCurrencies = await zelleBaseVerifier.getCurrencies();

      expect(actualOwner).to.eq(owner.address);
      expect(actualEscrowAddress).to.eq(escrow.address);
      expect(actualNullifierRegistryAddress).to.eq(nullifierRegistry.address);
      expect(actualCurrencies).to.include(Currency.USD);
    });
  });


  describe("#setPaymentMethodVerifier", async () => {
    let subjectCaller: Account;
    let subjectVerifier: Address;
    let subjectPaymentMethod: number;

    beforeEach(async () => {
      subjectCaller = owner;
      subjectVerifier = zelleBoAReclaimVerifier.address;
      subjectPaymentMethod = 1;
    });

    async function subject(): Promise<any> {
      return await zelleBaseVerifier.connect(subjectCaller.wallet).setPaymentMethodVerifier(
        subjectPaymentMethod,
        subjectVerifier
      );
    }

    it("should add the payment method verifier", async () => {
      await subject();

      const verifierAddress = await zelleBaseVerifier.paymentMethodToVerifier(subjectPaymentMethod);
      expect(verifierAddress).to.eq(subjectVerifier);
    });

    it("should emit a PaymentMethodVerifierSet event", async () => {
      await expect(subject()).to.emit(
        zelleBaseVerifier,
        "PaymentMethodVerifierSet"
      ).withArgs(
        subjectPaymentMethod,
        subjectVerifier
      );
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = user;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the verifier address is zero", async () => {
      beforeEach(async () => {
        subjectVerifier = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid verifier address");
      });
    });
  });

  describe("#removePaymentMethodVerifier", async () => {
    let subjectCaller: Account;
    let subjectPaymentMethod: number;

    beforeEach(async () => {
      subjectCaller = owner;
      subjectPaymentMethod = 1;

      // First set up a payment method verifier so we can remove it
      await zelleBaseVerifier.connect(owner.wallet).setPaymentMethodVerifier(
        subjectPaymentMethod,
        zelleBoAReclaimVerifier.address
      );
    });

    async function subject(): Promise<any> {
      return await zelleBaseVerifier.connect(subjectCaller.wallet).removePaymentMethodVerifier(
        subjectPaymentMethod
      );
    }

    it("should remove the payment method verifier", async () => {
      await subject();

      const verifierAddress = await zelleBaseVerifier.paymentMethodToVerifier(subjectPaymentMethod);
      expect(verifierAddress).to.eq(ethers.constants.AddressZero);
    });

    it("should emit a PaymentMethodVerifierRemoved event", async () => {
      await expect(subject()).to.emit(
        zelleBaseVerifier,
        "PaymentMethodVerifierRemoved"
      ).withArgs(
        subjectPaymentMethod
      );
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = user;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the verifier is not set", async () => {
      beforeEach(async () => {
        // First remove the verifier
        await zelleBaseVerifier.connect(owner.wallet).removePaymentMethodVerifier(subjectPaymentMethod);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Verifier not set");
      });
    });
  });

  describe("Payment Verification", async () => {
    let proof: ReclaimProof;

    let subjectCaller: Account;
    let subjectProof: BytesLike;
    let subjectDepositToken: Address;
    let subjectIntentAmount: BigNumber;
    let subjectIntentTimestamp: BigNumber;
    let subjectConversionRate: BigNumber;
    let subjectPayeeDetailsHash: string;
    let subjectFiatCurrency: BytesLike;
    let subjectDepositData: BytesLike;
    let subjectData: BytesLike;

    beforeEach(async () => {
      // Set up a payment method verifier for testing
      const paymentMethod = 1;
      await zelleBaseVerifier.connect(owner.wallet).setPaymentMethodVerifier(
        paymentMethod,
        zelleBoAReclaimVerifier.address
      );

      proof = parseExtensionProof(zelleBoAExtensionProof);
      const encodedProof = encodeProof(proof);
      subjectProof = encodeProofWithPaymentMethod(encodedProof, paymentMethod);

      subjectCaller = escrow;
      subjectDepositToken = usdcToken.address;
      subjectIntentAmount = usdc(1);
      subjectIntentTimestamp = BigNumber.from(1748393775); // Slightly after payment timestamp
      subjectConversionRate = ether(0.9);   // 110 * 0.9 = 99 [intent amount * conversion rate = payment amount]
      subjectPayeeDetailsHash = "0x907677337cbb16e036508f13be415d848b3b8237d038189fa94825fe05f64614";
      subjectFiatCurrency = Currency.USD;
      subjectData = "0x";
      subjectDepositData = ethers.utils.defaultAbiCoder.encode(
        ['address[]'],
        [["0x0636c417755e3ae25c6c166d181c0607f4c572a3"]]
      );
    });

    async function subjectCallStatic(): Promise<any> {
      return await zelleBaseVerifier.connect(subjectCaller.wallet).callStatic.verifyPayment({
        paymentProof: subjectProof,
        depositToken: subjectDepositToken,
        intentAmount: subjectIntentAmount,
        intentTimestamp: subjectIntentTimestamp,
        payeeDetails: subjectPayeeDetailsHash,
        fiatCurrency: subjectFiatCurrency,
        conversionRate: subjectConversionRate,
        depositData: subjectDepositData,
        data: subjectData
      });
    }

    it("should verify the bank of america proof", async () => {
      const result = await subjectCallStatic();

      expect(result.success).to.be.true;
      expect(result.intentHash).to.eq("0x28a5929360d217432e6db97002bf2a7670a92e82bc91fbc6b887188e41290ed5");
      expect(result.releaseAmount).to.eq(usdc(1));
      expect(result.paymentCurrency).to.eq(Currency.USD);
      expect(result.paymentId).to.eq('jqaa7v4iw');
    });

    describe("when caller is not escrow", async () => {
      beforeEach(async () => {
        subjectCaller = user; // Use a non-escrow account
      });

      it("should revert with 'Only escrow can call'", async () => {
        await expect(subjectCallStatic()).to.be.revertedWith("Only escrow can call");
      });
    });

    describe("when payment method verifier is not set", async () => {
      beforeEach(async () => {
        // Use an unregistered payment method
        const unregisteredPaymentMethod = 2;
        const encodedProof = encodeProof(proof);
        subjectProof = encodeProofWithPaymentMethod(encodedProof, unregisteredPaymentMethod);
      });

      it("should revert with 'Verifier not set'", async () => {
        await expect(subjectCallStatic()).to.be.revertedWith("Verifier not set");
      });
    });

    describe("when payment proof length is incorrrect", async () => {
      beforeEach(async () => {
        subjectProof = "0x01";
      });

      it("should revert with 'Invalid paymentProof length'", async () => {
        await expect(subjectCallStatic()).to.be.revertedWith("Invalid paymentProof length");
      });
    });
  });
});
