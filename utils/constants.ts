import { BigNumber, constants } from "ethers";

export const ADDRESS_ZERO = constants.AddressZero;
export const ZERO = constants.Zero;
export const ONE = constants.One;
export const ONE_DAY_IN_SECONDS = BigNumber.from(86400);
export const THREE_MINUTES_IN_SECONDS = BigNumber.from(180);
export const ONE_HOUR_IN_SECONDS = BigNumber.from(3600);
export const SIX_HOURS_IN_SECONDS = BigNumber.from(21600);
export const ZERO_BYTES32 = constants.HashZero;

export const EMPTY_ORACLE_RATE_CONFIG = {
  adapter: ADDRESS_ZERO,
  adapterConfig: "0x",
  spreadBps: 0,
  maxStaleness: 0,
};
