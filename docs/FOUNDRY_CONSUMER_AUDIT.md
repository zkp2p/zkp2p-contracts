# Foundry Consumer Audit

**Status:** Initial inventory  
**Created:** 2026-03-12  
**Branch:** `codex/foundry-main`

This file tracks the remaining repo surfaces that still assume Hardhat artifacts, TypeChain outputs, or `hardhat-deploy`.

## Why this exists

Deleting Hardhat safely is not just a test migration problem. The repo still has TypeScript utilities, deploy tests, and package scripts that assume:

- `typechain/` exists
- Hardhat-generated artifacts exist
- `hardhat-deploy` owns deployment orchestration

This audit is the phase-6 control surface for removing those assumptions deliberately.

## Current high-signal consumers

### TypeChain-backed runtime helpers

- `utils/deploys.ts`
  - Hard blocker
  - Central deploy helper imports a large set of `typechain` factories and generated types
- `utils/contracts.ts`
  - Hard blocker
  - Re-exports generated contract types directly from `typechain`
- `packages/contracts/scripts/extractors/types.ts`
  - Hard blocker
  - Reads the root `typechain/` tree and warns if it is missing

### Config and package wiring

- `hardhat.config.ts`
  - Hard blocker
  - Still wires `@typechain/hardhat` and `hardhat-deploy`
- `package.json`
  - Hard blocker
  - `build:ts:latest`, `typechain`, `clean`, and dependency graph still assume Hardhat and TypeChain outputs
- `tsconfig.json`
  - Hard blocker
  - `@typechain/*` alias and explicit `./typechain/**/*.ts` include remain active
- `packages/contracts/tsconfig.json`
  - Hard blocker
  - `@typechain/*` alias points at `typechain-types/*`
- `packages/contracts/jest.config.js`
  - Hard blocker
  - Jest alias still points at generated TypeChain bindings

### Hardhat deploy flow

- `deploy/*.ts`
  - Hard blocker
  - The deploy tree still relies on `hardhat-deploy`
- `deployments/helpers.ts`
  - Hard blocker
  - Deployment ownership and registry mutation helpers are written around Hardhat runtime APIs

### Hardhat deploy verification tests

- `test/deploy/*.spec.ts`
  - Medium-term blocker
  - These tests still validate legacy deploy outputs via Hardhat deployments + TypeChain attachment

### Legacy test utilities

- `utils/test/*.ts`
  - Medium-term blocker
  - These helpers still import `ethers` from Hardhat and are only useful while Hardhat tests remain alive

## Migration categories

### Replace outright

- `utils/deploys.ts`
- `utils/contracts.ts`
- `deployments/helpers.ts`
- `deploy/*.ts`

These should be replaced by:

- Solidity fixtures and setup helpers for tests
- Forge scripts for deployment and ownership handoff
- ABI-first consumers for any downstream package that only needs contract interfaces

### Shrink until removable

- `test/deploy/*.spec.ts`
- `utils/test/*.ts`

These can disappear as Foundry deploy/integration suites replace them.

### Rewire without preserving behavior one-to-one

- `package.json`
- `tsconfig.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/jest.config.js`

These files need a new output model, not a TypeChain-in-Foundry clone.

## Recommended next cuts

1. Introduce ABI-first exports for downstream package consumers so `utils/contracts.ts` is no longer required.
2. Replace `utils/deploys.ts` usage in any remaining Hardhat tests with Solidity fixtures or local inline deployment.
3. Port `test/deploy/*.spec.ts` to Foundry integration suites that validate Forge scripts instead of Hardhat deployment JSON.
4. Remove `typechain` aliases from TS configs only after no runtime or test helper imports remain.
