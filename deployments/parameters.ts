import "module-alias/register";
import { ONE_DAY_IN_SECONDS, THREE_MINUTES_IN_SECONDS, ZERO, ONE_HOUR_IN_SECONDS, SIX_HOURS_IN_SECONDS } from "../utils/constants";
import { ether, usdc } from "../utils/common/units";

export const INTENT_EXPIRATION_PERIOD: any = {
  "localhost": ONE_DAY_IN_SECONDS,
  "hardhat": ONE_DAY_IN_SECONDS,
  "base": SIX_HOURS_IN_SECONDS,
  "base_staging": ONE_HOUR_IN_SECONDS,
};

export const PROTOCOL_TAKER_FEE: any = {
  "localhost": ether(.001),
  "hardhat": ether(.001),
  "base": ZERO,
  "base_staging": ZERO,
};

export const PROTOCOL_TAKER_FEE_RECIPIENT: any = {
  "localhost": "",
  "hardhat": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
};

export const ESCROW_DUST_RECIPIENT: any = {
  "localhost": "",
  "hardhat": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
};

export const ESCROW_DUST_THRESHOLD: any = {
  "localhost": usdc(0.1),
  "hardhat": usdc(0.1),
  "base": usdc(0.1),
  "base_staging": usdc(0.1),
};

export const MAX_INTENTS_PER_DEPOSIT: any = {
  "localhost": 100,
  "hardhat": 100,
  "base": 200,
  "base_staging": 200,
};

export const MULTI_SIG: any = {
  "localhost": "",
  "hardhat": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
};

export const WITNESS_ADDRESS: any = {
  "localhost": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "hardhat": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "base": "0x5106A86819ED6Bb82c77CcBfC151250E1d369DbA",
  "base_staging": "0x4ab950AE1e3326578Bf7e643a2031E858aBa2927",
};

export const MULTI_WITNESS_ADDRESSES: Record<string, string[]> = {
  base: ["0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754"], // current AWS KMS signer
  base_staging: [
    "0x66649F896521b0fb487fE2077b4FBDA283d7f19a", // current AWS Nitro TEE signer
    "0x4ab950AE1e3326578Bf7e643a2031E858aBa2927", // current Railway staging signer (SIGNER_MODE=local)
  ],
  localhost: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
  hardhat: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
};

export const MULTI_WITNESS_THRESHOLD: Record<string, number> = {
  base: 1,
  base_staging: 1,
  localhost: 1,
  hardhat: 1,
};

export const USDC: any = {
  "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base_staging": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

// V2 Parameters
export const ESCROW_V2_INTENT_EXPIRATION_PERIOD: any = {
  "localhost": ONE_DAY_IN_SECONDS,
  "hardhat": ONE_DAY_IN_SECONDS,
  "base": SIX_HOURS_IN_SECONDS,
  "base_staging": ONE_HOUR_IN_SECONDS,
};

export const ESCROW_V2_MAX_INTENTS_PER_DEPOSIT: any = {
  "localhost": 100,
  "hardhat": 100,
  "base": 200,
  "base_staging": 200,
};

export const ESCROW_V2_DUST_THRESHOLD: any = {
  "localhost": usdc(0.1),
  "hardhat": usdc(0.1),
  "base": usdc(0.1),
  "base_staging": usdc(0.1),
};

export const ESCROW_V2_DUST_RECIPIENT: any = {
  "localhost": "",
  "hardhat": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
};

export const ORCHESTRATOR_V2_PROTOCOL_FEE: any = {
  "localhost": ether(.001),
  "hardhat": ether(.001),
  "base": ZERO,
  "base_staging": ZERO,
};

export const ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT: any = {
  "localhost": "",
  "hardhat": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
};

// V3 lifecycle stack parameters. Base staging and production use the ratified 14-day dispute protection policy.
export const STAKE_VAULT_CONTROLLER_CHANGE_DELAY = ONE_DAY_IN_SECONDS.mul(2);

export const DISPUTE_RISK_WINDOW: any = {
  "localhost": ONE_DAY_IN_SECONDS.mul(14),
  "hardhat": ONE_DAY_IN_SECONDS.mul(14),
  "base": ONE_DAY_IN_SECONDS.mul(14),
  "base_staging": ONE_DAY_IN_SECONDS.mul(14),
};

// Ratified policy: all five methods are disputable on Base staging and production.
export const DISPUTABLE_PAYMENT_METHODS: string[] = [
  "paypal",
  "venmo",
  "cashapp",
  "zelle",
  "chime",
];

export const ORCHESTRATOR_V3_PROTOCOL_FEE: any = {
  "localhost": ether(.001),
  "hardhat": ether(.001),
  "base": ZERO,
  "base_staging": ZERO,
};

export const ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT: any = {
  "localhost": "",
  "hardhat": "",
  "base": "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
  "base_staging": "",
};

// Initial hourly fee for the standalone IntentGuardian, denominated in basis points of the
// locked intent amount. Governance can update this value on the deployed guardian.
export const INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR: Record<string, number> = {
  localhost: 2,
  hardhat: 2,
  base_staging: 2,
  base: 2,
};

// Pyth Network contract addresses
export const PYTH_CONTRACT: any = {
  "localhost": "",
  "base": "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
  "base_staging": "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
};

// For Goerli and localhost
export const USDC_MINT_AMOUNT = usdc(1000000);
export const USDC_RECIPIENT = "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929";

export const DEPLOY_TX_DELAY_MS: any = {
  localhost: 0,
  hardhat: 0,
  base: 8000,
  base_staging: 5000,
};
