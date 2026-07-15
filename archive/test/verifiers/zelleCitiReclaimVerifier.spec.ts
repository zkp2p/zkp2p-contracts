import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";
import hre from "hardhat";

import { NullifierRegistry, ZelleCitiReclaimVerifier, USDCMock, ZelleBaseVerifier } from "@utils/contracts";
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

const zelleCitiExtensionProof = {
  "claim": {
    "provider": "http",
    "parameters": "{\"body\":\"\",\"headers\":{\"Accept\":\"application/json\",\"Accept-language\":\"en_US\",\"Content-Type\":\"application/json\",\"Referer\":\"https://online.citi.com/US/nga/zelle/transfer\",\"Sec-Fetch-Dest\":\"empty\",\"Sec-Fetch-Mode\":\"cors\",\"Sec-Fetch-Site\":\"same-origin\",\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36\",\"appVersion\":\"CBOL-ANG-2025-04-01\",\"businessCode\":\"GCB\",\"channelId\":\"CBOL\",\"client_id\":\"4a51fb19-a1a7-4247-bc7e-18aa56dd1c40\",\"countryCode\":\"US\",\"sec-ch-ua\":\"\\\"Chromium\\\";v=\\\"136\\\", \\\"Google Chrome\\\";v=\\\"136\\\", \\\"Not.A/Brand\\\";v=\\\"99\\\"\",\"sec-ch-ua-mobile\":\"?0\",\"sec-ch-ua-platform\":\"\\\"macOS\\\"\"},\"method\":\"GET\",\"paramValues\":{},\"responseMatches\":[{\"type\":\"regex\",\"value\":\"\\\"paymentID\\\":\\\"(?<paymentID>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"paymentStatus\\\":\\\"(?<paymentStatus>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"updatedTimeStamp\\\":\\\"(?<updatedTimeStamp>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"amount\\\":\\\"(?<amount>[^\\\"]+)\\\"\"},{\"hash\":true,\"type\":\"regex\",\"value\":\"\\\"partyToken\\\":\\\"(?<partyToken>[^\\\"]+)\\\"\"}],\"responseRedactions\":[{\"jsonPath\":\"$.content.paymentTransactionsData[2].paymentID\",\"xPath\":\"\"},{\"jsonPath\":\"$.content.paymentTransactionsData[2].paymentStatus\",\"xPath\":\"\"},{\"jsonPath\":\"$.content.paymentTransactionsData[2].updatedTimeStamp\",\"xPath\":\"\"},{\"jsonPath\":\"$.content.paymentTransactionsData[2].amount\",\"xPath\":\"\"},{\"jsonPath\":\"$.content.paymentTransactionsData[2].partyToken\",\"xPath\":\"\"}],\"url\":\"https://online.citi.com/gcgapi/prod/public/v1/p2ppayments/pastActivityTransactions?transactionCount=20&pageId=0&tab=All\"}",
    "owner": "0xf9f25d1b846625674901ace47d6313d1ac795265",
    "timestampS": 1747334657,
    "context": "{\"contextAddress\":\"0x0\",\"contextMessage\":\"4948915460758196888156147053328476497446483899021706653248173960948416723660\",\"extractedParameters\":{\"amount\":\"10.00\",\"partyToken\":\"0x3bcb39ffd57dd47e25c484c95ce7f7591305af0cfaaf7f18ab4ab548217fb303\",\"paymentID\":\"CTIwjcKauxso\",\"paymentStatus\":\"DELIVERED\",\"updatedTimeStamp\":\"04/28/2025\"},\"providerHash\":\"0x2a20d5d1fc3ccfa7f3053949fb067cb56447eb46cb415a10a496c36c5f9992d7\"}",
    "identifier": "0x6eee8481892033bb43385634044cc0fb8b8e970790ad9f53d750996447c42064",
    "epoch": 1
  },
  "signatures": {
    "attestorAddress": "0x0636c417755e3ae25c6c166d181c0607f4c572a3",
    "claimSignature": {
      "0": 82,
      "1": 107,
      "2": 128,
      "3": 95,
      "4": 29,
      "5": 193,
      "6": 249,
      "7": 14,
      "8": 77,
      "9": 250,
      "10": 4,
      "11": 237,
      "12": 167,
      "13": 126,
      "14": 238,
      "15": 152,
      "16": 96,
      "17": 38,
      "18": 111,
      "19": 248,
      "20": 114,
      "21": 187,
      "22": 107,
      "23": 146,
      "24": 5,
      "25": 150,
      "26": 153,
      "27": 197,
      "28": 181,
      "29": 96,
      "30": 121,
      "31": 42,
      "32": 115,
      "33": 53,
      "34": 169,
      "35": 203,
      "36": 246,
      "37": 231,
      "38": 59,
      "39": 133,
      "40": 23,
      "41": 46,
      "42": 121,
      "43": 12,
      "44": 80,
      "45": 49,
      "46": 28,
      "47": 83,
      "48": 106,
      "49": 230,
      "50": 243,
      "51": 155,
      "52": 77,
      "53": 177,
      "54": 244,
      "55": 194,
      "56": 231,
      "57": 52,
      "58": 95,
      "59": 128,
      "60": 246,
      "61": 180,
      "62": 40,
      "63": 74,
      "64": 28
    },
    "resultSignature": {
      "0": 188,
      "1": 182,
      "2": 94,
      "3": 56,
      "4": 117,
      "5": 176,
      "6": 177,
      "7": 79,
      "8": 112,
      "9": 41,
      "10": 176,
      "11": 78,
      "12": 85,
      "13": 148,
      "14": 153,
      "15": 82,
      "16": 156,
      "17": 32,
      "18": 160,
      "19": 111,
      "20": 195,
      "21": 91,
      "22": 158,
      "23": 193,
      "24": 223,
      "25": 211,
      "26": 248,
      "27": 37,
      "28": 2,
      "29": 111,
      "30": 245,
      "31": 11,
      "32": 126,
      "33": 179,
      "34": 166,
      "35": 127,
      "36": 123,
      "37": 103,
      "38": 117,
      "39": 85,
      "40": 185,
      "41": 119,
      "42": 202,
      "43": 75,
      "44": 213,
      "45": 180,
      "46": 189,
      "47": 55,
      "48": 163,
      "49": 98,
      "50": 152,
      "51": 242,
      "52": 232,
      "53": 64,
      "54": 174,
      "55": 239,
      "56": 110,
      "57": 233,
      "58": 149,
      "59": 204,
      "60": 218,
      "61": 1,
      "62": 82,
      "63": 91,
      "64": 27
    }
  }
}

describe("ZelleCitiReclaimVerifier", () => {
  let owner: Account;
  let attacker: Account;
  let baseVerifier: ZelleBaseVerifier;
  let providerHashes: string[];
  let witnesses: Address[];
  let subjectCaller: Account;

  let nullifierRegistry: NullifierRegistry;
  let verifier: ZelleCitiReclaimVerifier;
  let usdcToken: USDCMock;

  let deployer: DeployHelper;

  beforeEach(async () => {
    [
      owner,
      attacker
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");

    witnesses = ["0x0636c417755e3ae25c6c166d181c0607f4c572a3"];
    providerHashes = ["0x2a20d5d1fc3ccfa7f3053949fb067cb56447eb46cb415a10a496c36c5f9992d7"];

    nullifierRegistry = await deployer.deployNullifierRegistry();

    baseVerifier = await deployer.deployZelleBaseVerifier(
      attacker.address,
      nullifierRegistry.address,
      BigNumber.from(30),
      [Currency.USD]
    );

    verifier = await deployer.deployZelleCitiReclaimVerifier(
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
      proof = parseExtensionProof(zelleCitiExtensionProof);
      subjectProof = encodeProof(proof);

      const paymentTime = new Date('2025-04-28');  // Convert to YYYY-MM-DD for JS Date
      paymentTimestamp = Math.ceil(paymentTime.getTime() / 1000);

      subjectDepositToken = usdcToken.address;
      subjectIntentAmount = usdc(11);  // 11 * 0.9 = 9.9 [less than payment amount of 10]
      subjectIntentTimestamp = BigNumber.from(paymentTimestamp - 86400); // 1 day before
      subjectConversionRate = ether(0.9);
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
        data: subjectData,
        depositData: subjectDepositData
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
        data: subjectData,
        depositData: subjectDepositData
      });
    }

    it("should verify the proof", async () => {
      const result = await subjectCallStatic();

      expect(result.success).to.be.true;
      expect(result.intentHash).to.eq(BigNumber.from('4948915460758196888156147053328476497446483899021706653248173960948416723660').toHexString());
      // Payment is $10, conversion rate is 0.9, intent amount is 11
      // Release amount = 10 / 0.9 = 11.111... but capped at intent amount 11
      expect(result.releaseAmount).to.eq(usdc(11));
      expect(result.paymentCurrency).to.eq(Currency.USD);
      expect(result.paymentId).to.eq('CTIwjcKauxso');
    });

    it("should nullify the payment id", async () => {
      await subject();

      const nullifier = ethers.utils.keccak256(ethers.utils.solidityPack(['string'], ['CTIwjcKauxso']));
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
        subjectIntentAmount = usdc(20); // Intent expects 20 * 0.9 = 18, but actual payment is 10
        subjectConversionRate = ether(0.9);
      });

      it("should succeed with partial payment", async () => {
        const result = await subjectCallStatic();

        expect(result.success).to.be.true;
        expect(result.intentHash).to.eq(BigNumber.from("4948915460758196888156147053328476497446483899021706653248173960948416723660").toHexString());
        // Payment is $10, conversion rate is 0.9, intent amount is 20
        // Release amount = 10 / 0.9 = 11.111... USDC
        expect(result.releaseAmount).to.eq(usdc(11.111111));  // 6 decimals rounded down
        expect(result.paymentCurrency).to.eq(Currency.USD);
        expect(result.paymentId).to.eq('CTIwjcKauxso');
      });
    });

    describe("when the payment amount is zero", async () => {
      beforeEach(async () => {
        // Mock a proof with zero payment amount
        proof.claimInfo.context = "{\"contextAddress\":\"0x0\",\"contextMessage\":\"4948915460758196888156147053328476497446483899021706653248173960948416723660\",\"extractedParameters\":{\"amount\":\"0.00\",\"partyToken\":\"0x3bcb39ffd57dd47e25c484c95ce7f7591305af0cfaaf7f18ab4ab548217fb303\",\"paymentID\":\"CTIwjcKauxso\",\"paymentStatus\":\"DELIVERED\",\"updatedTimeStamp\":\"04/28/2025\"},\"providerHash\":\"0x2a20d5d1fc3ccfa7f3053949fb067cb56447eb46cb415a10a496c36c5f9992d7\"}";
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
          "0x2a20d5d1fc3ccfa7f3053949fb067cb56447eb46cb415a10a496c36c5f9992d7",
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

    describe("when the payment status is not DELIVERED", async () => {
      beforeEach(async () => {
        proof.claimInfo.context = proof.claimInfo.context.replace("DELIVERED", "PENDING");
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
        await expect(subject()).to.be.revertedWith("Payment not delivered");
      });
    });

    describe("when the date format is invalid", async () => {
      beforeEach(async () => {
        // Replace the valid date "04/28/2025" with an invalid format "4/28/2025" (9 characters)
        proof.claimInfo.context = proof.claimInfo.context.replace(
          "\"updatedTimeStamp\":\"04/28/2025\"",
          "\"updatedTimeStamp\":\"4/28/2025\""
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
        await expect(subject()).to.be.revertedWith("Invalid date format");
      });
    });

    describe("when the caller is not the base verifier", async () => {
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