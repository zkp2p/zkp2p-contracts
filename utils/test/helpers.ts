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
  preIntentHookData: string = "0x"
) => {
  // If no expiration provided, use current block timestamp + 1 day
  if (!signatureExpiration) {
    const currentBlock = await ethers.provider.getBlock("latest");
    const oneDayInSeconds = 86400; // 24 * 60 * 60
    signatureExpiration = BigNumber.from(currentBlock.timestamp + oneDayInSeconds);
  }

  let gatingServiceSignature = "0x";

  if (gatingService) {
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

  return {
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
    preIntentHookData,
    data
  };
}
