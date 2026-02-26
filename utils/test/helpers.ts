import { BigNumber, BytesLike } from "ethers";
import { ethers } from "hardhat";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";

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
    ["address", "address", "uint256", "uint256", "address", "address", "bytes32", "bytes32", "uint256", "uint256", "uint256"],
    [orchestrator, escrow, depositId, amount, caller, to, paymentMethod, fiatCurrency, conversionRate, signatureExpiration, chainId]
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
  caller?: Address
) => {
  // If no expiration provided, use current block timestamp + 1 day
  if (!signatureExpiration) {
    const currentBlock = await ethers.provider.getBlock("latest");
    const oneDayInSeconds = 86400; // 24 * 60 * 60
    signatureExpiration = BigNumber.from(currentBlock.timestamp + oneDayInSeconds);
  }

  let gatingServiceSignature = "0x";

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

  const params: any = {
    escrow,
    depositId,
    amount,
    to,
    paymentMethod,
    fiatCurrency,
    conversionRate,
    referrer,
    referrerFee,
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