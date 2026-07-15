import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";
import hre from "hardhat";

import { NullifierRegistry, ZelleBaseVerifier, ZelleBoAReclaimVerifier, USDCMock } from "@utils/contracts";
import { Account } from "@utils/test/types";
import { Address, ReclaimProof } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { Currency } from "@utils/protocolUtils";
import { getIdentifierFromClaimInfo, createSignDataForClaim, encodeProof, parseExtensionProof } from "@utils/reclaimUtils";
import { Blockchain, usdc, ether } from "@utils/common";
import { ZERO_BYTES32 } from "@utils/constants";

import {
  getWaffleExpect,
  getAccounts
} from "@utils/test/index";

const expect = getWaffleExpect();

const zelleBoAExtensionProof = {
  "claim": {
    "provider": "http",
    "parameters": "{\"body\":\"{\\\"filterV1\\\":{\\\"dateFilter\\\":{\\\"timeframeForHistory\\\":\\\"DEFAULTDAYS\\\"}},\\\"sortCriteriaV1\\\":{\\\"fieldName\\\":\\\"DATE\\\",\\\"order\\\":\\\"DESCENDING\\\"},\\\"pageInfo\\\":{\\\"pageNum\\\":1,\\\"pageSize\\\":\\\"\\\"}}\",\"headers\":{\"Accept\":\"application/json\",\"Accept-Language\":\"en-US\",\"Content-Type\":\"application/json\",\"Origin\":\"https://secure.bankofamerica.com\",\"Referer\":\"https://secure.bankofamerica.com/pay-transfer-pay-portal/?request_locale=en-us&returnSiteIndicator=GAIMW&target=paymentactivity\",\"Sec-Fetch-Dest\":\"empty\",\"Sec-Fetch-Mode\":\"cors\",\"Sec-Fetch-Site\":\"same-origin\",\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36\",\"X-Requested-With\":\"XMLHttpRequest\",\"sec-ch-ua\":\"\\\"Chromium\\\";v=\\\"136\\\", \\\"Google Chrome\\\";v=\\\"136\\\", \\\"Not.A/Brand\\\";v=\\\"99\\\"\",\"sec-ch-ua-mobile\":\"?0\",\"sec-ch-ua-platform\":\"\\\"macOS\\\"\"},\"method\":\"POST\",\"paramValues\":{},\"responseMatches\":[{\"type\":\"regex\",\"value\":\"\\\"confirmationNumber\\\":\\\"(?<confirmationNumber>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"status\\\":\\\"(?<status>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"transactionDate\\\":\\\"(?<transactionDate>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"amount\\\":(?<amount>[0-9\\\\.]+)\"},{\"hash\":true,\"type\":\"regex\",\"value\":\"\\\"aliasToken\\\":\\\"(?<aliasToken>[^\\\"]+)\\\"\"}],\"responseRedactions\":[{\"jsonPath\":\"$.completedTransactions[0].confirmationNumber\",\"xPath\":\"\"},{\"jsonPath\":\"$.completedTransactions[0].status\",\"xPath\":\"\"},{\"jsonPath\":\"$.completedTransactions[0].transactionDate\",\"xPath\":\"\"},{\"jsonPath\":\"$.completedTransactions[0].amount\",\"xPath\":\"\"},{\"jsonPath\":\"$.completedTransactions[0].targetAccount.aliasToken\",\"xPath\":\"\"}],\"url\":\"https://secure.bankofamerica.com/ogateway/payment-activity/api/v4/activity\"}",
    "owner": "0xf9f25d1b846625674901ace47d6313d1ac795265",
    "timestampS": 1747349461,
    "context": "{\"contextAddress\":\"0x0\",\"contextMessage\":\"8326399457664203853385587893474801619762725624996440086480664263627804731444\",\"extractedParameters\":{\"aliasToken\":\"0x3bcb39ffd57dd47e25c484c95ce7f7591305af0cfaaf7f18ab4ab548217fb303\",\"amount\":\"5.0\",\"confirmationNumber\":\"osmgnjz2u\",\"status\":\"COMPLETED\",\"transactionDate\":\"2025-05-15\"},\"providerHash\":\"0x05eecaa422b995a513376f7ae0b3a16fab2bdcb7fb1eff38891475b56869a1bd\"}",
    "identifier": "0x747ab3be259d0a33da0d6aeb2d8461454fa211f61ae6ffd1b8cbba54c015ad98",
    "epoch": 1
  },
  "signatures": {
    "attestorAddress": "0x0636c417755e3ae25c6c166d181c0607f4c572a3",
    "claimSignature": { "0": 96, "1": 255, "2": 156, "3": 150, "4": 193, "5": 224, "6": 225, "7": 232, "8": 232, "9": 69, "10": 1, "11": 251, "12": 41, "13": 194, "14": 57, "15": 247, "16": 0, "17": 66, "18": 134, "19": 96, "20": 195, "21": 205, "22": 152, "23": 117, "24": 103, "25": 42, "26": 77, "27": 139, "28": 147, "29": 55, "30": 223, "31": 141, "32": 63, "33": 67, "34": 12, "35": 188, "36": 10, "37": 200, "38": 28, "39": 145, "40": 127, "41": 113, "42": 108, "43": 166, "44": 198, "45": 109, "46": 123, "47": 11, "48": 151, "49": 87, "50": 107, "51": 114, "52": 141, "53": 190, "54": 232, "55": 150, "56": 86, "57": 254, "58": 22, "59": 165, "60": 217, "61": 173, "62": 194, "63": 161, "64": 28 },
    "resultSignature": { "0": 100, "1": 150, "2": 190, "3": 57, "4": 183, "5": 75, "6": 154, "7": 77, "8": 97, "9": 90, "10": 114, "11": 81, "12": 165, "13": 220, "14": 142, "15": 185, "16": 26, "17": 152, "18": 17, "19": 101, "20": 212, "21": 124, "22": 216, "23": 45, "24": 244, "25": 233, "26": 27, "27": 192, "28": 22, "29": 98, "30": 242, "31": 216, "32": 43, "33": 139, "34": 211, "35": 210, "36": 142, "37": 154, "38": 140, "39": 132, "40": 25, "41": 252, "42": 130, "43": 29, "44": 223, "45": 97, "46": 58, "47": 58, "48": 91, "49": 15, "50": 238, "51": 148, "52": 155, "53": 254, "54": 54, "55": 137, "56": 203, "57": 83, "58": 66, "59": 37, "60": 249, "61": 183, "62": 196, "63": 235, "64": 27 }
  }
};

describe("ZelleBoAReclaimVerifier", () => {
  let owner: Account;
  let attacker: Account;
  let escrow: Account;
  let providerHashes: string[];
  let witnesses: Address[];
  let subjectCaller: Account;

  let nullifierRegistry: NullifierRegistry;
  let baseVerifier: ZelleBaseVerifier;
  let verifier: ZelleBoAReclaimVerifier;
  let usdcToken: USDCMock;

  let deployer: DeployHelper;

  beforeEach(async () => {
    [
      owner,
      attacker,
      escrow
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");

    witnesses = ["0x0636c417755e3ae25c6c166d181c0607f4c572a3"];
    providerHashes = ["0x05eecaa422b995a513376f7ae0b3a16fab2bdcb7fb1eff38891475b56869a1bd"];

    nullifierRegistry = await deployer.deployNullifierRegistry();

    baseVerifier = await deployer.deployZelleBaseVerifier(
      escrow.address,
      nullifierRegistry.address,
      BigNumber.from(30),
      [Currency.USD]
    );

    verifier = await deployer.deployZelleBoAReclaimVerifier(
      baseVerifier.address,
      nullifierRegistry.address,
      providerHashes,
      BigNumber.from(60)
    );

    await nullifierRegistry.connect(owner.wallet).addWritePermission(verifier.address);

    // Set up impersonated signer for base verifier
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [baseVerifier.address],
    });

    const baseVerifierSigner = await ethers.getSigner(baseVerifier.address);

    // Set balance for base verifier for gas
    await hre.network.provider.send("hardhat_setBalance", [
      baseVerifier.address,
      "0x56BC75E2D63100000" // 100 ETH in hex
    ]);

    subjectCaller = {
      address: baseVerifier.address,
      wallet: baseVerifierSigner
    };
  });

  describe("#constructor", async () => {
    it("should set the correct state", async () => {
      const baseVerifierAddress = await verifier.baseVerifier();
      const nullifierRegistryAddress = await verifier.nullifierRegistry();
      const providerHashes = await verifier.getProviderHashes();

      expect(nullifierRegistryAddress).to.eq(nullifierRegistry.address);
      expect(providerHashes).to.deep.eq(providerHashes);
      expect(baseVerifierAddress).to.eq(baseVerifier.address);
    });
  });

  describe("#verifyPayment", async () => {
    let proof: ReclaimProof;

    let subjectProof: BytesLike;
    let subjectDepositToken: Address;
    let subjectIntentAmount: BigNumber;
    let subjectIntentTimestamp: BigNumber;
    let subjectConversionRate: BigNumber;
    let subjectPayeeDetailsHash: string;
    let subjectFiatCurrency: BytesLike;
    let subjectDepositData: BytesLike;
    let subjectData: BytesLike;

    let paymentTimestamp: number;

    beforeEach(async () => {
      proof = parseExtensionProof(zelleBoAExtensionProof);
      subjectProof = encodeProof(proof);

      const paymentTimeString = '2025-05-15';
      const paymentTime = new Date(paymentTimeString);
      paymentTimestamp = Math.ceil(paymentTime.getTime() / 1000);

      subjectDepositToken = usdcToken.address;
      subjectIntentAmount = usdc(5);
      subjectIntentTimestamp = BigNumber.from(paymentTimestamp);
      subjectConversionRate = ether(0.99);   // 5 * 0.99 = 4.95 [intent amount * conversion rate = payment amount]
      subjectPayeeDetailsHash = "0x3bcb39ffd57dd47e25c484c95ce7f7591305af0cfaaf7f18ab4ab548217fb303";
      subjectFiatCurrency = Currency.USD;
      subjectData = "0x";
      subjectDepositData = ethers.utils.defaultAbiCoder.encode(
        ['address[]'],
        [witnesses]
      );
    });

    async function subject(): Promise<any> {
      return await verifier.connect(subjectCaller.wallet).verifyPayment({
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

    async function subjectCallStatic(): Promise<any> {
      return await verifier.connect(subjectCaller.wallet).callStatic.verifyPayment({
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

    it("should verify the proof", async () => {
      const result = await subjectCallStatic();

      expect(result.success).to.be.true;
      expect(result.intentHash).to.eq(BigNumber.from('8326399457664203853385587893474801619762725624996440086480664263627804731444').toHexString());
      // Payment is $5, conversion rate is 0.99, intent amount is 5
      // Release amount = 5 / 0.99 = 5.05050505... but capped at intent amount 5
      expect(result.releaseAmount).to.eq(usdc(5));
      expect(result.paymentCurrency).to.eq(Currency.USD);
      expect(result.paymentId).to.eq('osmgnjz2u');
    });

    it("should nullify the payment id", async () => {
      await subject();

      const nullifier = ethers.utils.keccak256(ethers.utils.solidityPack(['string'], ['osmgnjz2u']));
      const isNullified = await nullifierRegistry.isNullified(nullifier);

      expect(isNullified).to.be.true;
    });

    describe("when the proof is invalid", async () => {
      beforeEach(async () => {
        proof.signedClaim.claim.identifier = ZERO_BYTES32;
        subjectProof = encodeProof(proof);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.reverted;
      });
    });

    describe("when the payment amount is less than the expected payment amount", async () => {
      beforeEach(async () => {
        subjectIntentAmount = usdc(20); // Intent expects 20 * 0.9 = 18, but actual payment is 5
        subjectConversionRate = ether(0.9);
      });

      it("should succeed with partial payment", async () => {
        const result = await subjectCallStatic();

        expect(result.success).to.be.true;
        expect(result.intentHash).to.eq(BigNumber.from("8326399457664203853385587893474801619762725624996440086480664263627804731444").toHexString());
        // Payment is $5, conversion rate is 0.9, intent amount is 20
        // Release amount = 5 / 0.9 = 5.55555555... USDC
        expect(result.releaseAmount).to.eq(usdc(5.555555));  // limited to 6 decimal places and rounded down
        expect(result.paymentCurrency).to.eq(Currency.USD);
        expect(result.paymentId).to.eq('osmgnjz2u');
      });
    });

    describe("when the payment amount is zero", async () => {
      beforeEach(async () => {
        // Mock a proof with zero payment amount
        proof.claimInfo.context = "{\"contextAddress\":\"0x0\",\"contextMessage\":\"8326399457664203853385587893474801619762725624996440086480664263627804731444\",\"extractedParameters\":{\"aliasToken\":\"0x3bcb39ffd57dd47e25c484c95ce7f7591305af0cfaaf7f18ab4ab548217fb303\",\"amount\":\"0.0\",\"confirmationNumber\":\"osmgnjz2u\",\"status\":\"COMPLETED\",\"transactionDate\":\"2025-05-15\"},\"providerHash\":\"0x05eecaa422b995a513376f7ae0b3a16fab2bdcb7fb1eff38891475b56869a1bd\"}";
        proof.signedClaim.claim.identifier = getIdentifierFromClaimInfo(proof.claimInfo);

        // Sign the updated claim with witness
        const digest = createSignDataForClaim(proof.signedClaim.claim);
        const witness = ethers.Wallet.createRandom();
        proof.signedClaim.signatures = [await witness.signMessage(digest)];

        subjectProof = encodeProof(proof);
        subjectDepositData = ethers.utils.defaultAbiCoder.encode(
          ['address[]'],
          [[witness.address]]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Payment amount must be greater than zero");
      });
    });

    describe("when the payment was made before the intent", async () => {
      beforeEach(async () => {
        subjectIntentTimestamp = BigNumber.from(paymentTimestamp).add(86400).add(BigNumber.from(60));   // 1 second after the payment timestamp + 23:59:59 + buffer of 60 seconds
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incorrect payment timestamp");
      });
    });

    describe("when the payment recipient is incorrect", async () => {
      beforeEach(async () => {
        subjectPayeeDetailsHash = "0x1234567890123456789012345678901234567890123456789012345678901234";
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incorrect payment recipient");
      });
    });

    describe("when the proof has already been verified", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Nullifier has already been used");
      });
    });

    describe("when the provider hash is invalid", async () => {
      beforeEach(async () => {
        proof.claimInfo.context = proof.claimInfo.context.replace(
          "0x05eecaa422b995a513376f7ae0b3a16fab2bdcb7fb1eff38891475b56869a1bd",
          "0xbbb4d6813c1ccac7253673094ce4c1e122fe358682392851cfa332fe8359b8fc"
        );
        proof.signedClaim.claim.identifier = getIdentifierFromClaimInfo(proof.claimInfo);

        const digest = createSignDataForClaim(proof.signedClaim.claim);
        const witness = ethers.Wallet.createRandom();
        proof.signedClaim.signatures = [await witness.signMessage(digest)];

        subjectProof = encodeProof(proof);
        subjectDepositData = ethers.utils.defaultAbiCoder.encode(
          ['address[]'],
          [[witness.address]]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("No valid providerHash");
      });
    });

    describe("when the payment status is not COMPLETED", async () => {
      beforeEach(async () => {
        proof.claimInfo.context = proof.claimInfo.context.replace("COMPLETED", "PENDING");
        proof.signedClaim.claim.identifier = getIdentifierFromClaimInfo(proof.claimInfo);

        const digest = createSignDataForClaim(proof.signedClaim.claim);
        const witness = ethers.Wallet.createRandom();
        proof.signedClaim.signatures = [await witness.signMessage(digest)];

        subjectProof = encodeProof(proof);
        subjectDepositData = ethers.utils.defaultAbiCoder.encode(
          ['address[]'],
          [[witness.address]]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Payment not completed");
      });
    });

    describe("when the caller is not the escrow", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only base verifier can call");
      });
    });
  });

  describe("#setTimestampBuffer", async () => {
    let subjectBuffer: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectBuffer = BigNumber.from(60);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await verifier.connect(subjectCaller.wallet).setTimestampBuffer(subjectBuffer);
    }

    it("should set the timestamp buffer correctly", async () => {
      await subject();
      expect(await verifier.timestampBuffer()).to.equal(subjectBuffer);
    });

    it("should emit the TimestampBufferSet event", async () => {
      await expect(subject()).to.emit(verifier, "TimestampBufferSet").withArgs(subjectBuffer);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});
