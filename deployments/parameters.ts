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

export const ACROSS_SPOKE_POOL: any = {
  "base": "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  "base_staging": "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  "localhost": "", // Fake address for local testing
  "hardhat": "",
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

export const STAKE_VAULT_BASE_EXIT_DELAY = ONE_DAY_IN_SECONDS.mul(30);
export const STAKE_VAULT_CONTROLLER_CHANGE_DELAY = ONE_DAY_IN_SECONDS.mul(2);
export const RISK_CALLBACK_GAS_LIMIT = 2_000_000;

// Initial policy approved in STAKE_RISK_POLICY_SPEC.md for local validation and the
// Base staging E2E rollout. Production remains an explicit governance decision.
const INITIAL_STAKE_RISK_PLATFORM_POLICY = {
  reversible: {
    enabled: true,
    chargeback: {
      chargebackable: true,
      deferredPayoutEnabled: false,
      reserveBps: 10_000,
      riskWindow: ONE_DAY_IN_SECONDS.mul(30),
    },
    griefing: {
      griefingCliff: 15 * 60,
      griefingPenaltyBpsPerHour: 10,
      baseUnbondedAmount: 0,
    },
  },
  nonChargebackable: {
    enabled: true,
    chargeback: {
      chargebackable: false,
      deferredPayoutEnabled: false,
      reserveBps: 0,
      riskWindow: 0,
    },
    griefing: {
      griefingCliff: 15 * 60,
      griefingPenaltyBpsPerHour: 10,
      baseUnbondedAmount: usdc(500),
    },
  },
};

export const STAKE_RISK_PLATFORM_POLICY: any = {
  localhost: INITIAL_STAKE_RISK_PLATFORM_POLICY,
  hardhat: INITIAL_STAKE_RISK_PLATFORM_POLICY,
  base_staging: INITIAL_STAKE_RISK_PLATFORM_POLICY,
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
