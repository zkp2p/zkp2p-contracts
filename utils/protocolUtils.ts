import { ethers } from "ethers";
import { BigNumber } from "ethers";

const CIRCOM_FIELD = BigNumber.from("21888242871839275222246405745257275088548364400416034343698204186575808495617");

export const getKeccak256Hash = (value: string): string => {
  // Convert the string to UTF-8 bytes
  const bytes = ethers.utils.toUtf8Bytes(value);

  // Compute keccak256 hash of the packed bytes
  return ethers.utils.keccak256(bytes);
}

export const DEPOSIT_ATTESTORS_TAG = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("zkp2p.depositAttestors.v1")
);

export const MAX_DEPOSIT_ATTESTORS = 3;

// Encodes additional attestors appended to the default witness set.
export const encodeDepositAttestors = (
  attestors: string[],
  threshold: BigNumber | number | string,
): string => {
  return ethers.utils.defaultAbiCoder.encode(
    ["bytes32", "address[]", "uint256"],
    [DEPOSIT_ATTESTORS_TAG, attestors, threshold]
  );
}

export const Currency = {
  AED: getKeccak256Hash("AED"),
  ARS: getKeccak256Hash("ARS"),
  AUD: getKeccak256Hash("AUD"),
  CAD: getKeccak256Hash("CAD"),
  CHF: getKeccak256Hash("CHF"),
  CNY: getKeccak256Hash("CNY"),
  CZK: getKeccak256Hash("CZK"),
  DKK: getKeccak256Hash("DKK"),
  EUR: getKeccak256Hash("EUR"),
  GBP: getKeccak256Hash("GBP"),
  HKD: getKeccak256Hash("HKD"),
  HUF: getKeccak256Hash("HUF"),
  IDR: getKeccak256Hash("IDR"),
  ILS: getKeccak256Hash("ILS"),
  INR: getKeccak256Hash("INR"),
  JPY: getKeccak256Hash("JPY"),
  KES: getKeccak256Hash("KES"),
  MXN: getKeccak256Hash("MXN"),
  MYR: getKeccak256Hash("MYR"),
  NOK: getKeccak256Hash("NOK"),
  NZD: getKeccak256Hash("NZD"),
  PHP: getKeccak256Hash("PHP"),
  PLN: getKeccak256Hash("PLN"),
  RON: getKeccak256Hash("RON"),
  SAR: getKeccak256Hash("SAR"),
  SEK: getKeccak256Hash("SEK"),
  SGD: getKeccak256Hash("SGD"),
  THB: getKeccak256Hash("THB"),
  TRY: getKeccak256Hash("TRY"),
  USD: getKeccak256Hash("USD"),
  UGX: getKeccak256Hash("UGX"),
  VND: getKeccak256Hash("VND"),
  ZAR: getKeccak256Hash("ZAR"),
} as const;


export const getCurrencyCodeFromHash = (hash: string): string => {
  return Object.keys(Currency).find(key => Currency[key as keyof typeof Currency] === hash) || "";
}

export const calculateIntentHash = (
  orchestrator: string,
  intentCounter: BigNumber | number,
): string => {

  const intermediateHash = ethers.utils.solidityKeccak256(
    ["address", "uint256"],
    [orchestrator, intentCounter]
  );

  return ethers.utils.hexZeroPad(BigNumber.from(intermediateHash).mod(CIRCOM_FIELD).toHexString(), 32);
};


export const calculatePaymentMethodHash = (paymentMethod: string): string => {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(paymentMethod));
}
