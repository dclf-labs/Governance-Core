# veNOON Token System

## Overview

The veNOON system is a vote-escrowed token system that allows users to lock NOON tokens to receive voting power and additional benefits. The system consists of two main contracts:

1. `veNOON.sol`: The main contract that handles token locking, voting power calculation, and VIP lock management
2. `VeNOONVesting.sol`: A contract that manages vesting schedules for VIP locks

## Key Features

### Token Locking

- Users can lock NOON tokens for a duration between 1 week and 4 years
- Lock duration determines the voting power multiplier (up to 4x)
- Maximum of 3 normal locks per user
- Locks are represented as NFTs (ERC721 tokens)

### Voting Power

- Voting power is calculated based on:
  - Locked amount
  - Lock duration (multiplier)
  - Time remaining in lock
- For VIP locks, voting power includes both locked amount and vested amount
- For permanent locks, voting power is constant (amount \* multiplier)

### VIP Locks

- Special locks with additional benefits
- Maximum of 1 VIP lock per user
- Includes a vesting schedule for additional tokens
- Vesting follows an exponential curve over 1 year
- VIP locks are non-transferable
- Requires a 7-day unlocking period before withdrawal

### Vesting System

- VIP locks receive a 9x vesting allocation
- Vesting follows an exponential curve:
  - 25% vested after 1 month
  - 50% vested after 3 months
  - 75% vested after 6 months
  - 100% vested after 12 months
- Vested tokens can be claimed at any time
- Vesting continues during the VIP unlock period
