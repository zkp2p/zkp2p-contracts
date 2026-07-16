import { BigNumber, BytesLike } from "ethers";
import { ethers } from "hardhat";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";

export type ReferralFeeParam = {
  recipient: Address;
  fee: BigNumber;
};

export const hashReferralFees = (referralFees: ReferralFeeParam[]): string => {
  const feeHashes = referralFees.map(({ recipient, fee }) =>
    ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [recipient, fee])
    )
  );

  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32[]"], [feeHashes])
  );
};

const normalizeReferralFees = (
  referrer: Address,
  referrerFee: BigNumber,
  referralFees?: ReferralFeeParam[]
): ReferralFeeParam[] => {
  if (referralFees) {
    return referralFees;
  }

  if (referrer === ethers.constants.AddressZero && referrerFee.eq(0)) {
    return [];
  }

  if (referrer !== ethers.constants.AddressZero && referrerFee.eq(0)) {
    return [];
  }

  return [{ recipient: referrer, fee: referrerFee }];
};

export const generateGatingServiceSignature = async (
  gatingService: Account,
  orchestrator: Address,
  escrow: Address,
  depositId: BigNumber,
  amount: BigNumber,
  to: Address,
  paymentMethod: BytesLike,
  fiatCurrency: string,
  conversionRate: BigNumber,
  chainId: string,
  signatureExpiration?: BigNumber
) => {
  // If no expiration provided, use current block timestamp + 1 day
  if (!signatureExpiration) {
    const currentBlock = await ethers.provider.getBlock("latest");
    const oneDayInSeconds = 86400; // 24 * 60 * 60
    signatureExpiration = BigNumber.from(currentBlock.timestamp + oneDayInSeconds);
  }

  const messageHash = ethers.utils.solidityKeccak256(
    ["address", "address", "uint256", "uint256", "address", "bytes32", "bytes32", "uint256", "uint256", "uint256"],
    [orchestrator, escrow, depositId, amount, to, paymentMethod, fiatCurrency, conversionRate, signatureExpiration, chainId]
  );
  return await gatingService.wallet.signMessage(ethers.utils.arrayify(messageHash));
}

export const generateGatingServiceSignatureV2 = async (
  gatingService: Account,
  orchestrator: Address,
  escrow: Address,
  depositId: BigNumber,
  amount: BigNumber,
  caller: Address,
  to: Address,
  paymentMethod: BytesLike,
  fiatCurrency: string,
  conversionRate: BigNumber,
  referralFees: ReferralFeeParam[],
  chainId: string,
  signatureExpiration?: BigNumber
) => {
  // If no expiration provided, use current block timestamp + 1 day
  if (!signatureExpiration) {
    const currentBlock = await ethers.provider.getBlock("latest");
    const oneDayInSeconds = 86400; // 24 * 60 * 60
    signatureExpiration = BigNumber.from(currentBlock.timestamp + oneDayInSeconds);
  }

  const messageHash = ethers.utils.solidityKeccak256(
    ["address", "address", "uint256", "uint256", "address", "address", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256"],
    [
      orchestrator,
      escrow,
      depositId,
      amount,
      caller,
      to,
      paymentMethod,
      fiatCurrency,
      conversionRate,
      hashReferralFees(referralFees),
      signatureExpiration,
      chainId,
    ]
  );
  return await gatingService.wallet.signMessage(ethers.utils.arrayify(messageHash));
}

export const createSignalIntentParams = async (
  orchestrator: Address,
  escrow: Address,
  depositId: BigNumber,
  amount: BigNumber,
  to: Address,
  paymentMethod: BytesLike,
  fiatCurrency: string,
  conversionRate: BigNumber,
  referrer: Address = ethers.constants.AddressZero,
  referrerFee: BigNumber = BigNumber.from(0),
  gatingService: Account | null = null,
  chainId: string = "1",
  postIntentHook: Address = ethers.constants.AddressZero,
  data: string = "0x",
  signatureExpiration?: BigNumber,
  preIntentHookData?: string,
  caller?: Address,
  referralFees?: ReferralFeeParam[]
) => {
  // If no expiration provided, use current block timestamp + 1 day
  if (!signatureExpiration) {
    const currentBlock = await ethers.provider.getBlock("latest");
    const oneDayInSeconds = 86400; // 24 * 60 * 60
    signatureExpiration = BigNumber.from(currentBlock.timestamp + oneDayInSeconds);
  }

  let gatingServiceSignature = "0x";
  const normalizedReferralFees = normalizeReferralFees(referrer, referrerFee, referralFees);

  if (gatingService) {
    if (caller) {
      gatingServiceSignature = await generateGatingServiceSignatureV2(
        gatingService,
        orchestrator,
        escrow,
        depositId,
        amount,
        caller,
        to,
        paymentMethod,
        fiatCurrency,
        conversionRate,
        normalizedReferralFees,
        chainId,
        signatureExpiration
      );
    } else {
      gatingServiceSignature = await generateGatingServiceSignature(
        gatingService,
        orchestrator,
        escrow,
        depositId,
        amount,
        to,
        paymentMethod,
        fiatCurrency,
        conversionRate,
        chainId,
        signatureExpiration
      );
    }
  }

  const legacyReferrer =
    referrer !== ethers.constants.AddressZero || !referrerFee.eq(0)
      ? referrer
      : normalizedReferralFees.length === 1
        ? normalizedReferralFees[0].recipient
        : ethers.constants.AddressZero;
  const legacyReferrerFee =
    referrer !== ethers.constants.AddressZero || !referrerFee.eq(0)
      ? referrerFee
      : normalizedReferralFees.length === 1
        ? normalizedReferralFees[0].fee
        : BigNumber.from(0);

  const params: any = {
    escrow,
    depositId,
    amount,
    to,
    paymentMethod,
    fiatCurrency,
    conversionRate,
    referrer: legacyReferrer,
    referrerFee: legacyReferrerFee,
    referralFees: normalizedReferralFees,
    gatingServiceSignature,
    signatureExpiration,
    postIntentHook,
    data
  };

  if (preIntentHookData !== undefined) {
    params.preIntentHookData = preIntentHookData;
  }

  return params;
}

export const createSignalIntentParamsV2 = async (
  orchestrator: Address,
  escrow: Address,
  depositId: BigNumber,
  amount: BigNumber,
  to: Address,
  paymentMethod: BytesLike,
  fiatCurrency: string,
  conversionRate: BigNumber,
  referrer: Address = ethers.constants.AddressZero,
  referrerFee: BigNumber = BigNumber.from(0),
  gatingService: Account | null = null,
  chainId: string = "1",
  settlementHook: Address = ethers.constants.AddressZero,
  data: string = "0x",
  signatureExpiration?: BigNumber,
  preIntentHookData?: string,
  caller?: Address,
  referralFees?: ReferralFeeParam[]
) => {
  const legacyParams = await createSignalIntentParams(
    orchestrator,
    escrow,
    depositId,
    amount,
    to,
    paymentMethod,
    fiatCurrency,
    conversionRate,
    referrer,
    referrerFee,
    gatingService,
    chainId,
    settlementHook,
    data,
    signatureExpiration,
    preIntentHookData,
    caller,
    referralFees
  );
  const { postIntentHook, ...params } = legacyParams;

  return { ...params, settlementHook: postIntentHook };
}
