# Governance Core - NOON Staking System

## Overview

The NOON Staking system allows users to stake NOON tokens in exchange for voting power and VIP rewards. Stakes are represented as ERC-721 NFTs (sNOON). The system consists of four contracts:

| Contract | Address | Description |
|---|---|---|
| `NOON` | `0xD3F58365428F9325d13787a405f846374a58A0fB` | ERC-20 token with transfer restrictions, blacklist/whitelist |
| `stakeNOON` | `0x5f9ee665830BE17b2073a9800Eb7bbbe51b471D7` | Core staking contract (ERC-721, "sNOON") |
| `stakeNOONVesting` | `0x56993afd8CdF9409ACf3b3AA96F0C10595a070D2` | Vesting schedules for VIP stakes |
| `stakeNOONRewarder` | - | Merkle-based reward distribution for stakers |

All contracts are upgradeable (OpenZeppelin UUPS pattern) and compiled with Solidity ^0.8.20.

## Contracts

### NOON Token (`NOON.sol`)

ERC-20 token with:
- **Blacklist/whitelist** - owner can restrict specific addresses or allow transfers before general transferability is enabled
- **Transfer gating** - `isTransferable` flag controls whether non-whitelisted addresses can transfer
- ERC-2612 permit support

### Staking (`stakeNOON.sol`)

Users lock NOON tokens to receive an sNOON NFT representing their stake.

**Normal stakes:**
- Lock duration: 1 week to 4 years
- Maximum 3 normal stakes per user
- Withdrawable at any time (`stake.end` is stored for offchain use only)
- NFT transfers are disabled by default; owner can enable

**VIP stakes:**
- Created via Merkle-proof claims (`claimAndStake`)
- Maximum 1 VIP per user
- Caller chooses a `stakePercentage` (0-100%); the rest is sent directly to wallet
- Requires a 7-day unlocking period (`startVIPUnstake` -> wait -> `withdrawVip`)
- When `vipUnlockingPeriod` is set to 0, one-step direct withdrawal is allowed
- Non-transferable

**Voting power:**
- Uses a smooth curve over 4 years (no cliffs): VP starts at 0 and reaches full `baseVP` at `stakeDate + 4 years`
- Non-VIP: `baseVP = stake.amount`
- VIP: `baseVP = sum per vesting schedule of (vested + totalAmount/9)`
- Curve formula: `(t/T)^3 * 0.73 + (t/T) * 0.27`

**Withdrawal rewards:**
- Merkle-based rewards for withdrawn stakes, claimable via `claimWithdrawalReward`
- Rewards can also be compounded into an existing stake via `updateStake`

### Vesting (`stakeNOONVesting.sol`)

Manages vesting schedules for VIP stakes:
- Each VIP claim creates a vesting schedule with `totalAmount = stakedAmount * 9` (the 90% vesting portion)
- The remaining 10% (`totalAmount / 9`) sits in `stake.amount` and is released when the schedule is claimed
- Vesting duration: 12 months with 90-day (quarterly) cliff periods
- Vesting curve: 27% linear + 73% cubic (`(t/T)^3 * 0.73 + (t/T) * 0.27`)
- Approximate milestones: ~27% at 3 months, ~41% at 6 months, ~63% at 9 months, 100% at 12 months
- Vesting is frozen at VIP unlock start time (snapshot)

### Rewards (`stakeNOONRewarder.sol`)

Merkle-based reward distribution:
- Owner creates a distribution by depositing NOON and setting a Merkle root
- Users with active sNOON NFTs can claim their allocated rewards
- Only one active distribution at a time

## Development

### Prerequisites

- Node.js >= 20.18.0
- Yarn

### Setup

```sh
cp .env.example .env   # configure RPC URLs and keys
yarn install
```

### Commands

```sh
yarn compile          # compile contracts
yarn test             # run test suite
yarn test:coverage    # run tests with coverage
yarn size             # report contract sizes
yarn format           # format all files
yarn lint             # lint all files
```

## Architecture

```
contracts/
  NOON.sol                  # ERC-20 token
  stakeNOON.sol             # Core staking + NFT
  stakeNOONVesting.sol      # VIP vesting logic
  stakeNOONRewarder.sol     # Merkle reward distribution
  interfaces/
    INOON.sol
    IStakeNOON.sol
    IStakeNOONVesting.sol
  mocks/
    MockUSN.sol
```

## License

MIT
