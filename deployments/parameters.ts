import "module-alias/register";
import { ONE_DAY_IN_SECONDS, THREE_MINUTES_IN_SECONDS, ZERO, ONE_HOUR_IN_SECONDS } from "../utils/constants";
import { ether, usdc } from "../utils/common/units";

export const INTENT_EXPIRATION_PERIOD: any = {
  "localhost": ONE_DAY_IN_SECONDS,
  "base": ONE_DAY_IN_SECONDS,
  "base_staging": ONE_HOUR_IN_SECONDS,
  "base_sepolia": ONE_HOUR_IN_SECONDS,
};

export const PROTOCOL_TAKER_FEE: any = {
  "localhost": ether(.001),
  "base": ZERO,
  "base_staging": ZERO,
  "base_sepolia": ZERO,
};

export const PROTOCOL_TAKER_FEE_RECIPIENT: any = {
  "localhost": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
  "base_sepolia": "",
};

export const ESCROW_DUST_RECIPIENT: any = {
  "localhost": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
  "base_sepolia": "",
};

export const ESCROW_DUST_THRESHOLD: any = {
  "localhost": usdc(0.1),
  "base": usdc(0.1),
  "base_staging": usdc(0.1),
  "base_sepolia": usdc(0.1),
};

export const MAX_INTENTS_PER_DEPOSIT: any = {
  "localhost": 100,
  "base": 200,
  "base_staging": 200,
  "base_sepolia": 200,
};

export const MULTI_SIG: any = {
  "localhost": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
  "base_sepolia": "",
};

export const WITNESS_ADDRESS: any = {
  "localhost": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "base": "0x5106A86819ED6Bb82c77CcBfC151250E1d369DbA",
  "base_staging": "0x4ab950AE1e3326578Bf7e643a2031E858aBa2927",
  "base_sepolia": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
};

export const USDC: any = {
  "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base_staging": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

export const ACROSS_SPOKE_POOL: any = {
  "base": "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  "base_staging": "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  "base_sepolia": "",
  "localhost": "",
  "hardhat": "",
};

// For Goerli and localhost
export const USDC_MINT_AMOUNT = usdc(1000000);
export const USDC_RECIPIENT = "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929";

export const DEPLOY_TX_DELAY_MS: any = {
  localhost: 0,
  base: 8000,
  base_staging: 5000,
  base_sepolia: 5000,
};
