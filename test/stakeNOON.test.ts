import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { EventLog } from 'ethers';
import { ethers, upgrades } from 'hardhat';
import { MerkleTree } from 'merkletreejs';
import { NOON } from '../typechain-types/contracts/NOON';
import { StakeNOON } from '../typechain-types/contracts/StakeNOON';
import { StakeNOONVesting } from '../typechain-types/contracts/StakeNOONVesting';

describe('stakeNOON', function () {
  let noon: NOON;
  let stakeNoon: StakeNOON;
  let owner: HardhatEthersSigner;
  let addr1: HardhatEthersSigner;
  let addr2: HardhatEthersSigner;
  let addrs: HardhatEthersSigner[];
  let merkleTree: MerkleTree;
  let VIP_MULTIPLIER = 1n;

  const ONE_YEAR = 365 * 24 * 60 * 60;
  const FOUR_YEARS = 4 * ONE_YEAR;
  const ONE_WEEK = 7 * 24 * 60 * 60;
  const TWO_YEARS = 2 * ONE_YEAR;
  const initialSupply = ethers.parseEther('1000000'); // 1 million tokens

  // Helper function to create a stake
  async function createStake(
    user: HardhatEthersSigner,
    amount: bigint,
    stakeDuration: number
  ): Promise<bigint> {
    await noon.connect(user).approve(await stakeNoon.getAddress(), amount);
    const tx = await stakeNoon.connect(user).createStake(amount, stakeDuration);
    const receipt = await tx.wait();
    const transferEvent = receipt?.logs.find(
      (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
    ) as EventLog;
    return transferEvent?.args[2];
  }

  // Helper function to create withdrawal reward merkle tree
  function createWithdrawalRewardTree(
    rewards: Array<{ tokenId: bigint; amount: bigint }>
  ) {
    const leaves = rewards.map((reward) =>
      ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [reward.tokenId, reward.amount, 'WITHDRAWAL']
      )
    );
    // Add a node to ensure non-empty proofs (prevents empty proof arrays)
    // Use a high tokenId that won't conflict (e.g., max uint256 - 1)
    const dummyLeaf = ethers.solidityPackedKeccak256(
      ['uint256', 'uint256', 'string'],
      [ethers.MaxUint256 - 1n, ethers.parseEther('1'), 'WITHDRAWAL']
    );
    return new MerkleTree([...leaves, dummyLeaf], ethers.keccak256, {
      sortPairs: true,
    });
  }

  beforeEach(async function () {
    [owner, addr1, addr2, ...addrs] = await ethers.getSigners();

    // Deploy NOON token using upgradeable pattern
    const NOON = await ethers.getContractFactory('NOON');
    noon = (await upgrades.deployProxy(
      NOON,
      [await owner.getAddress(), initialSupply],
      {
        initializer: 'initialize',
      }
    )) as unknown as NOON;
    await noon.setTransferable(true);

    // Deploy stakeNOON using upgradeable pattern
    const stakeNOON = await ethers.getContractFactory('stakeNOON');
    stakeNoon = (await upgrades.deployProxy(
      stakeNOON,
      [await noon.getAddress(), await owner.getAddress()],
      {
        initializer: 'initialize',
      }
    )) as unknown as StakeNOON;

    // Transfer some NOON tokens for testing
    await noon.transfer(await addr1.getAddress(), ethers.parseEther('1000'));
    await noon.transfer(await addr2.getAddress(), ethers.parseEther('1000'));

    // Create merkle tree for VIP stakes
    const leaves = [
      ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr1.address, ethers.parseEther('100')]
        )
      ),
      ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr2.address, ethers.parseEther('100')]
        )
      ),
    ];
    merkleTree = new MerkleTree(leaves, ethers.keccak256, { sortPairs: true });
  });

  describe('Deployment', function () {
    it('Should set the right owner', async function () {
      expect(await stakeNoon.owner()).to.equal(await owner.getAddress());
    });

    it('Should set the correct NOON token address', async function () {
      expect(await stakeNoon.noon()).to.equal(await noon.getAddress());
    });

    it('Should have correct constants', async function () {
      expect(await stakeNoon.MAX_STAKE_TIME()).to.equal(FOUR_YEARS);
      expect(await stakeNoon.MIN_STAKE_TIME()).to.equal(ONE_WEEK);
      expect(await stakeNoon.MAX_MULTIPLIER()).to.equal(ethers.parseEther('4'));
    });
  });

  describe('Staking', function () {
    it('Should allow users to create stakes', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.connect(addr1).createStake(amount, stakeDuration);

      const stakes = await stakeNoon.getUserStakes(await addr1.getAddress());
      expect(stakes.length).to.equal(1);
      expect(stakes[0].amount).to.equal(amount);
      expect(stakes[0].end).to.equal((await time.latest()) + stakeDuration);
    });

    it('Should calculate correct multiplier based on stake duration', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;
      const expectedMultiplier = ethers.parseEther('1'); // 1x for 1 year

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.connect(addr1).createStake(amount, stakeDuration);

      const stakes = await stakeNoon.getUserStakes(await addr1.getAddress());
      expect(stakes[0].multiplier).to.equal(expectedMultiplier);
    });

    it('Should revert if stake duration is too short', async function () {
      await expect(
        stakeNoon
          .connect(addr1)
          .createStake(ethers.parseEther('100'), 6 * 24 * 60 * 60) // 6 days
      ).to.be.revertedWithCustomError(stakeNoon, 'StakeDurationTooShort');
    });

    it('Should revert if stake duration is too long', async function () {
      await expect(
        stakeNoon
          .connect(addr1)
          .createStake(ethers.parseEther('100'), 5 * 365 * 24 * 60 * 60) // 5 years
      ).to.be.revertedWithCustomError(stakeNoon, 'StakeDurationTooLong');
    });
  });

  describe('Voting Power', function () {
    it('Should calculate correct voting power for a single stake', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.connect(addr1).createStake(amount, stakeDuration);

      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      // VP = amount / 10 (immediatePortion, no vesting contract)
      expect(votingPower).to.equal(amount / 10n);
    });

    it('Should maintain constant voting power over time (no decay)', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.connect(addr1).createStake(amount, stakeDuration);

      const initialVotingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(initialVotingPower).to.equal(amount / 10n); // VP = amount / 10 (no vesting contract)

      // Check at different time points - voting power should remain constant
      await time.increase(ONE_YEAR / 4);
      let votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPower).to.equal(amount / 10n); // Still constant (no decay)

      await time.increase(ONE_YEAR / 4);
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(votingPower).to.equal(amount / 10n); // Still constant (no decay)

      await time.increase(ONE_YEAR / 4);
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(votingPower).to.equal(amount / 10n); // Still constant (no decay)

      // Move forward past stake.end - VP unchanged (stake.end is offchain only)
      await time.increase(ONE_YEAR / 4 + 1);
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(votingPower).to.equal(amount / 10n); // Still constant
    });

    it('Should handle voting power for different stake durations', async function () {
      // Update max stakes to allow multiple stakes for this test
      await stakeNoon.updateMaxStakes(10, 1);

      const amount = ethers.parseEther('100');
      const durations = [
        ONE_WEEK, // 1 week
        ONE_YEAR, // 1 year
        TWO_YEARS, // 2 years
        FOUR_YEARS, // 4 years
      ];

      let cumulativeVotingPower = 0n;
      for (const duration of durations) {
        await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
        await stakeNoon.connect(addr1).createStake(amount, duration);

        // VP = amount / 10 for each stake (no vesting contract)
        cumulativeVotingPower += amount / 10n;

        let votingPower = await stakeNoon.getVotingPower(
          await addr1.getAddress()
        );
        // Voting power = amount / 10 per stake (constant, no decay)
        expect(votingPower).to.equal(cumulativeVotingPower);

        // Check at 50% of duration - voting power should remain constant
        await time.increase(duration / 2);
        votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
        expect(votingPower).to.equal(cumulativeVotingPower);

        // Move past stake.end - VP unchanged (stake.end is offchain only)
        await time.increase(duration / 2);
        votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
        expect(votingPower).to.equal(cumulativeVotingPower);
      }
    });

    it('Should calculate correct voting power for multiple stakes', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const stakeDuration1 = ONE_YEAR;
      const stakeDuration2 = TWO_YEARS;

      // First stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.connect(addr1).createStake(amount1, stakeDuration1);

      // Second stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);
      await stakeNoon.connect(addr1).createStake(amount2, stakeDuration2);

      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      // VP = amount / 10 for each stake (no vesting contract)
      const expectedVotingPower = amount1 / 10n + amount2 / 10n;
      expect(votingPower).to.equal(expectedVotingPower);
    });

    it('Should handle multiple stakes with different durations', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const stakeDuration1 = ONE_YEAR;
      const stakeDuration2 = TWO_YEARS;

      // First stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.connect(addr1).createStake(amount1, stakeDuration1);

      await time.increase(ONE_YEAR / 2 - 2);
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);

      await stakeNoon.connect(addr1).createStake(amount2, stakeDuration2);

      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      // VP = amount / 10 for each stake (no vesting contract)
      const expectedVotingPower = amount1 / 10n + amount2 / 10n;
      expect(votingPower).to.equal(expectedVotingPower);
    });

    it('Should maintain voting power after stake.end (stake.end is offchain only)', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.connect(addr1).createStake(amount, stakeDuration);

      // Move forward past stake.end
      await time.increase(ONE_YEAR + 1);

      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPower).to.equal(amount / 10n); // VP unchanged - stake.end has no on-chain effect
    });

    it('Should verify normal (non-VIP) stakers have voting power', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create a normal stake (not VIP)
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Verify stake is not VIP
      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.isVip).to.be.false;
      expect(stake.isPermanent).to.be.false;

      // Verify normal staker has voting power
      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPower).to.be.gt(0);
      expect(votingPower).to.equal(amount / 10n); // VP = amount / 10 (no vesting contract)

      // Verify token voting power
      const tokenVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(tokenVotingPower).to.be.gt(0);
      expect(tokenVotingPower).to.equal(amount / 10n);
    });

    it('Should verify normal stakers have constant voting power over time (no decay)', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create a normal stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.connect(addr1).createStake(amount, stakeDuration);

      // Get initial voting power
      const initialVotingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(initialVotingPower).to.be.gt(0);
      expect(initialVotingPower).to.equal(amount / 10n); // VP = amount / 10 (no vesting contract)

      // Move forward 25% of duration
      await time.increase(ONE_YEAR / 4);
      let votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPower).to.be.gt(0);
      // Voting power should remain constant (no decay)
      expect(votingPower).to.equal(initialVotingPower);

      // Move forward to 50% of duration
      await time.increase(ONE_YEAR / 4);
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(votingPower).to.be.gt(0);
      // Voting power should remain constant (no decay)
      expect(votingPower).to.equal(initialVotingPower);

      // Move forward to 75% of duration
      await time.increase(ONE_YEAR / 4);
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(votingPower).to.be.gt(0);
      // Voting power should remain constant (no decay)
      expect(votingPower).to.equal(initialVotingPower);

      // Move forward past stake.end - VP unchanged (stake.end is offchain only)
      await time.increase(ONE_YEAR / 4 + 1);
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(votingPower).to.equal(initialVotingPower);
    });

    it('Should verify normal stakers have voting power based on duration multiplier', async function () {
      // Update max stakes to allow multiple stakes
      await stakeNoon.updateMaxStakes(10, 1);

      const amount = ethers.parseEther('100');

      // Test different durations for normal stakes
      const testDurations = [ONE_WEEK, ONE_YEAR, TWO_YEARS, FOUR_YEARS];

      let cumulativeVotingPower = 0n;
      for (const duration of testDurations) {
        await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
        const tx = await stakeNoon.connect(addr1).createStake(amount, duration);
        const receipt = await tx.wait();
        const transferEvent = receipt?.logs.find(
          (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
        ) as EventLog;
        const tokenId = transferEvent?.args[2];

        // Verify stake is not VIP
        const stake = await stakeNoon.stakes(tokenId);
        expect(stake.isVip).to.be.false;

        // Multiplier is now 1e18 for all durations (no longer used for VP)
        expect(stake.multiplier).to.equal(ethers.parseEther('1'));

        // Verify token voting power is correct (amount / 10, no vesting contract)
        const tokenVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
        expect(tokenVotingPower).to.be.gt(0);
        expect(tokenVotingPower).to.equal(amount / 10n);

        // Update cumulative voting power (since we're creating multiple stakes)
        cumulativeVotingPower += amount / 10n;

        // Verify total voting power is cumulative
        const totalVotingPower = await stakeNoon.getVotingPower(
          await addr1.getAddress()
        );
        expect(totalVotingPower).to.equal(cumulativeVotingPower);
      }
    });

    it('Should verify multiple normal stakers have independent voting power', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const stakeDuration = ONE_YEAR;

      // User 1 creates normal stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.connect(addr1).createStake(amount1, stakeDuration);

      // User 2 creates normal stake
      await noon.connect(addr2).approve(await stakeNoon.getAddress(), amount2);
      await stakeNoon.connect(addr2).createStake(amount2, stakeDuration);

      // Verify both users have voting power
      const votingPower1 = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      const votingPower2 = await stakeNoon.getVotingPower(
        await addr2.getAddress()
      );

      expect(votingPower1).to.be.gt(0);
      expect(votingPower2).to.be.gt(0);
      expect(votingPower1).to.equal(amount1 / 10n);
      expect(votingPower2).to.equal(amount2 / 10n);

      // Verify they are independent (user 1's power doesn't affect user 2)
      expect(votingPower1).to.not.equal(votingPower2);
    });

    it('Should correctly aggregate voting power from multiple stakes', async function () {
      // Update max stakes to allow 3 stakes
      await stakeNoon.updateMaxStakes(10, 1);

      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('150');
      const amount3 = ethers.parseEther('200');
      const duration1 = ONE_YEAR;
      const duration2 = TWO_YEARS;
      const duration3 = FOUR_YEARS;

      // Create first stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      const tokenId1 = await createStake(addr1, amount1, duration1);

      // Verify voting power after first stake
      let votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      const expectedPower1 = amount1 / 10n; // VP = amount / 10 (no vesting contract)
      expect(votingPower).to.equal(expectedPower1);

      // Create second stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);
      const tokenId2 = await createStake(addr1, amount2, duration2);

      // Verify voting power aggregates correctly
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      const expectedPower2 = amount1 / 10n + amount2 / 10n;
      expect(votingPower).to.equal(expectedPower2);

      // Create third stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount3);
      const tokenId3 = await createStake(addr1, amount3, duration3);

      // Verify voting power aggregates all three stakes
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      const expectedPower3 = amount1 / 10n + amount2 / 10n + amount3 / 10n;
      expect(votingPower).to.equal(expectedPower3);

      // Verify individual token voting powers
      const tokenPower1 = await stakeNoon.getTokenVotingPower(tokenId1);
      const tokenPower2 = await stakeNoon.getTokenVotingPower(tokenId2);
      const tokenPower3 = await stakeNoon.getTokenVotingPower(tokenId3);

      expect(tokenPower1).to.equal(amount1 / 10n);
      expect(tokenPower2).to.equal(amount2 / 10n);
      expect(tokenPower3).to.equal(amount3 / 10n);
    });

    it('Should maintain voting power regardless of stake.end (stake.end is offchain only)', async function () {
      // Update max stakes to allow multiple stakes
      await stakeNoon.updateMaxStakes(10, 1);

      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const amount3 = ethers.parseEther('300');
      const shortDuration = ONE_YEAR / 2; // 6 months
      const longDuration = TWO_YEARS;

      // Create first stake with short duration
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.connect(addr1).createStake(amount1, shortDuration);

      // Create second stake with long duration
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);
      await stakeNoon.connect(addr1).createStake(amount2, longDuration);

      // Create third stake with long duration
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount3);
      await stakeNoon.connect(addr1).createStake(amount3, longDuration);

      // Initial voting power - VP = amount / 10 for each stake
      const expectedPower = amount1 / 10n + amount2 / 10n + amount3 / 10n;
      let votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPower).to.equal(expectedPower);

      // Move forward past first stake.end - VP unchanged (stake.end is offchain only)
      await time.increase(shortDuration + 1);
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(votingPower).to.equal(expectedPower);

      // Move forward past all stake.end times - VP still unchanged
      await time.increase(longDuration + 1);
      votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(votingPower).to.equal(expectedPower);
    });

    it('Should handle voting power with maximum number of stakes', async function () {
      const maxStakes = 3;
      await stakeNoon.updateMaxStakes(maxStakes, 1);

      const baseAmount = ethers.parseEther('100');
      const duration = ONE_YEAR;

      let totalExpectedPower = 0n;

      // Create maximum number of stakes
      for (let i = 0; i < maxStakes; i++) {
        const amount = baseAmount * BigInt(i + 1);
        await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
        await stakeNoon.connect(addr1).createStake(amount, duration);

        // Voting power should accumulate
        totalExpectedPower += amount / 10n; // VP = amount / 10 (no vesting contract)

        const votingPower = await stakeNoon.getVotingPower(
          await addr1.getAddress()
        );
        expect(votingPower).to.equal(totalExpectedPower);
      }

      // Verify final voting power is sum of all stakes
      const finalVotingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(finalVotingPower).to.equal(totalExpectedPower);

      // Verify user has maximum number of stakes
      const stakes = await stakeNoon.getUserStakes(await addr1.getAddress());
      expect(stakes.length).to.equal(maxStakes);
    });

    it('Should maintain voting power when stake.end times pass (stake.end is offchain only)', async function () {
      // Update max stakes to allow multiple stakes
      await stakeNoon.updateMaxStakes(10, 1);

      const amount = ethers.parseEther('100');
      const durations = [
        ONE_YEAR / 4, // 3 months
        ONE_YEAR / 2, // 6 months
        ONE_YEAR, // 1 year
        TWO_YEARS, // 2 years
      ];

      const tokenIds: bigint[] = [];
      let totalExpectedPower = 0n;

      // Create stakes with different durations
      for (const duration of durations) {
        await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
        const tokenId = await createStake(addr1, amount, duration);
        tokenIds.push(tokenId);

        totalExpectedPower += amount / 10n; // VP = amount / 10 (no vesting contract)

        const votingPower = await stakeNoon.getVotingPower(
          await addr1.getAddress()
        );
        expect(votingPower).to.equal(totalExpectedPower);
      }

      // Move forward past all stake.end times - VP unchanged (stake.end is offchain only)
      await time.increase(TWO_YEARS + 1);
      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPower).to.equal(totalExpectedPower);
    });

    it('Should maintain constant voting power for multiple stakes over time', async function () {
      // Update max stakes to allow multiple stakes
      await stakeNoon.updateMaxStakes(10, 1);

      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const amount3 = ethers.parseEther('300');
      const duration1 = ONE_YEAR;
      const duration2 = TWO_YEARS;
      const duration3 = FOUR_YEARS;

      // Create multiple stakes
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.connect(addr1).createStake(amount1, duration1);

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);
      await stakeNoon.connect(addr1).createStake(amount2, duration2);

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount3);
      await stakeNoon.connect(addr1).createStake(amount3, duration3);

      // Calculate expected total voting power - VP = amount / 10 for each
      const expectedPower = amount1 / 10n + amount2 / 10n + amount3 / 10n;

      // Get initial voting power
      let votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPower).to.equal(expectedPower);

      // Move forward multiple times - voting power should remain constant
      const timePoints = [
        ONE_YEAR / 4, // 3 months
        ONE_YEAR / 2, // 6 months
        ONE_YEAR, // 1 year
        ONE_YEAR + ONE_YEAR / 2, // 1.5 years
      ];

      for (const elapsed of timePoints) {
        await time.increase(elapsed);
        votingPower = await stakeNoon.getVotingPower(await addr1.getAddress());
        // Voting power remains constant (stake.end is offchain only, no expiry effect)
        expect(votingPower).to.equal(expectedPower);
      }
    });

    it('Should correctly calculate voting power for mixed stake types (different multipliers)', async function () {
      // Update max stakes to allow multiple stakes
      await stakeNoon.updateMaxStakes(10, 1);

      const amounts = [
        ethers.parseEther('50'), // Small amount
        ethers.parseEther('100'), // Medium amount
        ethers.parseEther('200'), // Large amount
      ];
      const durations = [
        ONE_WEEK, // Short duration (low multiplier)
        ONE_YEAR, // Medium duration (1x multiplier)
        FOUR_YEARS, // Long duration (4x multiplier)
      ];

      let totalExpectedPower = 0n;
      const tokenIds: bigint[] = [];

      // Create stakes with different amounts and durations
      for (let i = 0; i < amounts.length; i++) {
        await noon
          .connect(addr1)
          .approve(await stakeNoon.getAddress(), amounts[i]);
        const tokenId = await createStake(addr1, amounts[i], durations[i]);
        tokenIds.push(tokenId);

        const stakePower = amounts[i] / 10n; // VP = amount / 10 (no vesting contract)
        totalExpectedPower += stakePower;

        // Verify voting power accumulates correctly
        const votingPower = await stakeNoon.getVotingPower(
          await addr1.getAddress()
        );
        expect(votingPower).to.equal(totalExpectedPower);

        // Verify individual token voting power
        const tokenPower = await stakeNoon.getTokenVotingPower(tokenId);
        expect(tokenPower).to.equal(stakePower);
      }

      // Verify final total voting power
      const finalVotingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(finalVotingPower).to.equal(totalExpectedPower);
    });
  });

  describe('Voting Power Edge Cases', function () {
    it('Should maintain voting power past stake.end (stake.end is offchain only)', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Get stake end time
      const stake = await stakeNoon.stakes(tokenId);
      const stakeEndTime = stake.end;

      // Move to exactly 1 second before stake.end
      await time.increaseTo(stakeEndTime - 1n);
      let votingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(votingPower).to.equal(amount / 10n); // VP = amount / 10 (no vesting contract)

      // Move past stake.end - VP unchanged (stake.end is offchain only)
      await time.increaseTo(stakeEndTime + 1n);
      votingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(votingPower).to.equal(amount / 10n);

      const totalVotingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(totalVotingPower).to.equal(amount / 10n);
    });

    it('Should handle voting power with minimum stake duration', async function () {
      const amount = ethers.parseEther('100');
      const minDuration = ONE_WEEK;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, minDuration);

      const votingPower = await stakeNoon.getTokenVotingPower(tokenId);
      // VP = amount / 10 regardless of duration (no vesting contract)
      expect(votingPower).to.equal(amount / 10n);
    });

    it('Should handle voting power with maximum stake duration', async function () {
      const amount = ethers.parseEther('100');
      const maxDuration = FOUR_YEARS;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, maxDuration);

      const votingPower = await stakeNoon.getTokenVotingPower(tokenId);
      // VP = amount / 10 regardless of duration (no vesting contract)
      expect(votingPower).to.equal(amount / 10n);
    });

    it('Should calculate voting power correctly after increasing stake amount', async function () {
      const initialAmount = ethers.parseEther('100');
      const additionalAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), initialAmount);
      const tokenId = await createStake(addr1, initialAmount, stakeDuration);

      // Get initial voting power
      const initialVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(initialVotingPower).to.equal(initialAmount / 10n);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Increase stake amount and extend duration
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), additionalAmount);
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, additionalAmount, stakeDuration, 0, []);

      // Get new voting power - VP = total amount / 10 (no vesting contract)
      const newVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      const expectedVotingPower = (initialAmount + additionalAmount) / 10n;
      expect(newVotingPower).to.equal(expectedVotingPower);
    });

    it('Should calculate voting power correctly after extending stake duration', async function () {
      const amount = ethers.parseEther('100');
      const initialDuration = ONE_YEAR;
      const extendedDuration = TWO_YEARS;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, initialDuration);

      // Get initial voting power - VP = amount / 10 (no vesting contract)
      const initialVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(initialVotingPower).to.equal(amount / 10n);

      // Wait for stake to expire
      await time.increase(initialDuration + 1);

      // Extend stake duration
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, extendedDuration, 0, []);

      // Get new voting power - VP = amount / 10 regardless of duration
      const newVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(newVotingPower).to.equal(amount / 10n);
    });

    it('Should calculate voting power correctly after compounding rewards', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const extendedDuration = TWO_YEARS;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Get initial voting power - VP = amount / 10 (no vesting contract)
      const initialVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(initialVotingPower).to.equal(amount / 10n);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Compound reward and extend duration
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, extendedDuration, rewardAmount, proof);

      // Get new voting power - VP = (amount + reward) / 10 (no vesting contract)
      const newVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      const expectedVotingPower = (amount + rewardAmount) / 10n;
      expect(newVotingPower).to.equal(expectedVotingPower);
    });

    it('Should calculate voting power correctly with very small amounts', async function () {
      const smallAmount = ethers.parseEther('0.001');
      const stakeDuration = ONE_YEAR;

      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), smallAmount);
      const tokenId = await createStake(addr1, smallAmount, stakeDuration);

      const votingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(votingPower).to.equal(smallAmount / 10n); // VP = amount / 10
      expect(votingPower).to.be.gt(0);
    });

    it('Should calculate voting power correctly with very large amounts', async function () {
      const largeAmount = ethers.parseEther('500000'); // Use smaller amount to avoid balance issues
      const stakeDuration = ONE_YEAR;

      // Transfer large amount to addr1 (owner has 1M initially, 2K transferred in beforeEach)
      await noon.transfer(await addr1.getAddress(), largeAmount);
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), largeAmount);
      const tokenId = await createStake(addr1, largeAmount, stakeDuration);

      const votingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(votingPower).to.equal(largeAmount / 10n); // VP = amount / 10
    });

    it('Should aggregate voting power correctly with mixed stake types', async function () {
      // Update max stakes to allow multiple stakes
      await stakeNoon.updateMaxStakes(10, 1);

      const normalAmount = ethers.parseEther('100');
      const normalDuration = ONE_YEAR;

      // Create normal stake
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), normalAmount);
      const normalTokenId = await createStake(
        addr1,
        normalAmount,
        normalDuration
      );

      // Create VIP stake
      const vipAmount = ethers.parseEther('200');
      const leaf = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr1.address, vipAmount]
        )
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      await noon.transfer(await owner.getAddress(), vipAmount);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), vipAmount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), vipAmount);

      const vipTx = await stakeNoon
        .connect(addr1)
        .claimAndStake(vipAmount, 100, proof);
      const vipReceipt = await vipTx.wait();
      const vipTransferEvent = vipReceipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const vipTokenId = vipTransferEvent?.args[2];

      // Get total voting power
      const totalVotingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );

      // Normal stake: VP = normalAmount / 10
      // VIP stake: VP = vipAmount / 10 (immediatePortion, no vesting contract)
      const expectedNormalPower = normalAmount / 10n;
      const expectedVipPower = vipAmount / 10n;
      const expectedTotal = expectedNormalPower + expectedVipPower;

      expect(totalVotingPower).to.equal(expectedTotal);

      // Verify individual token voting powers
      const normalPower = await stakeNoon.getTokenVotingPower(normalTokenId);
      const vipPower = await stakeNoon.getTokenVotingPower(vipTokenId);

      expect(normalPower).to.equal(expectedNormalPower);
      expect(vipPower).to.equal(expectedVipPower);
    });

    it('Should calculate voting power correctly when one stake expires while others remain', async function () {
      // Update max stakes
      await stakeNoon.updateMaxStakes(10, 1);

      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const shortDuration = ONE_YEAR / 2;
      const longDuration = TWO_YEARS;

      // Create short duration stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      const tokenId1 = await createStake(addr1, amount1, shortDuration);

      // Create long duration stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);
      const tokenId2 = await createStake(addr1, amount2, longDuration);

      // Get initial total voting power - VP = amount / 10 for each
      const initialPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      const expectedInitial = amount1 / 10n + amount2 / 10n;
      expect(initialPower).to.equal(expectedInitial);

      // Move forward past first stake.end - VP unchanged (stake.end is offchain only)
      await time.increase(shortDuration + 1);

      const powerAfterStakeEnd = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      const expectedPower = amount1 / 10n + amount2 / 10n;
      expect(powerAfterStakeEnd).to.equal(expectedPower);

      // Both stakes still have voting power
      const power1 = await stakeNoon.getTokenVotingPower(tokenId1);
      const power2 = await stakeNoon.getTokenVotingPower(tokenId2);
      expect(power1).to.equal(amount1 / 10n);
      expect(power2).to.equal(amount2 / 10n);
    });

    it('Should handle voting power precision correctly with fractional multipliers', async function () {
      const amount = ethers.parseEther('100');
      // Use a duration that doesn't result in a whole number multiplier
      const stakeDuration = ONE_YEAR + ONE_YEAR / 2; // 1.5 years

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      const votingPower = await stakeNoon.getTokenVotingPower(tokenId);
      // VP = amount / 10 regardless of duration (no vesting contract)
      expect(votingPower).to.equal(amount / 10n);
    });

    it('Should maintain voting power consistency across multiple queries', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Query voting power multiple times
      const power1 = await stakeNoon.getTokenVotingPower(tokenId);
      const power2 = await stakeNoon.getTokenVotingPower(tokenId);
      const power3 = await stakeNoon.getTokenVotingPower(tokenId);

      // All should be the same
      expect(power1).to.equal(power2);
      expect(power2).to.equal(power3);
      expect(power1).to.equal(amount / 10n);
    });

    it('Should calculate voting power correctly after NFT transfer', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Get voting power before transfer
      const powerBefore = await stakeNoon.getTokenVotingPower(tokenId);
      expect(powerBefore).to.equal(amount / 10n);

      // Enable transfers
      await stakeNoon.setTransferable(true);

      // Transfer NFT
      await stakeNoon
        .connect(addr1)
        .transferFrom(
          await addr1.getAddress(),
          await addr2.getAddress(),
          tokenId
        );

      // Voting power should remain the same (just ownership changed)
      const powerAfter = await stakeNoon.getTokenVotingPower(tokenId);
      expect(powerAfter).to.equal(powerBefore);

      // Original owner should have 0 voting power
      const addr1Power = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(addr1Power).to.equal(0);

      // New owner should have the voting power
      const addr2Power = await stakeNoon.getVotingPower(
        await addr2.getAddress()
      );
      expect(addr2Power).to.equal(powerBefore);
    });
  });

  describe('Multiple Stakes', function () {
    it('Should allow users to create multiple stakes', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const stakeDuration1 = ONE_YEAR;
      const stakeDuration2 = TWO_YEARS;

      // First stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.connect(addr1).createStake(amount1, stakeDuration1);

      // Second stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);
      await stakeNoon.connect(addr1).createStake(amount2, stakeDuration2);

      const stakes = await stakeNoon.getUserStakes(await addr1.getAddress());
      expect(stakes.length).to.equal(2);
      expect(stakes[0].amount).to.equal(amount1);
      expect(stakes[1].amount).to.equal(amount2);
    });

    it('Should calculate correct voting power for multiple stakes', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const stakeDuration1 = ONE_YEAR;
      const stakeDuration2 = TWO_YEARS;

      // First stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.connect(addr1).createStake(amount1, stakeDuration1);

      // Second stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);
      await stakeNoon.connect(addr1).createStake(amount2, stakeDuration2);

      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      // VP = amount / 10 for each stake (no vesting contract)
      const expectedVotingPower = amount1 / 10n + amount2 / 10n;
      expect(votingPower).to.equal(expectedVotingPower);
    });

    it('Should handle multiple stakes with different durations', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const stakeDuration1 = ONE_YEAR;
      const stakeDuration2 = TWO_YEARS;

      // First stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.connect(addr1).createStake(amount1, stakeDuration1);

      await time.increase(ONE_YEAR / 2 - 2);
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount2);

      await stakeNoon.connect(addr1).createStake(amount2, stakeDuration2);

      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      // VP = amount / 10 for each stake (no vesting contract)
      const expectedVotingPower = amount1 / 10n + amount2 / 10n;
      expect(votingPower).to.equal(expectedVotingPower);
    });
  });

  describe('Stake Management', function () {
    it('Should allow extending a stake without rewards', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Get initial stake end time
      const initialStake = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      const initialEndTime = initialStake[0].end;

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Extend stake without rewards (rewardAmount = 0, empty proof)
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, additionalDuration, 0, []);

      // Get updated stake
      const updatedStake = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      const newEndTime = updatedStake[0].end;

      // Verify the stake was extended
      expect(newEndTime).to.be.gt(initialEndTime);
      expect(newEndTime).to.equal((await time.latest()) + additionalDuration);

      // Verify stake amount remained the same
      expect(updatedStake[0].amount).to.equal(amount);
    });

    it('Should allow restakeing', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, additionalDuration, 0, []);

      const stakes = await stakeNoon.getUserStakes(await addr1.getAddress());
      const currentTime = await time.latest();
      expect(stakes[0].end).to.equal(currentTime + additionalDuration);
    });

    it('Should allow extending a stake and compounding unclaimed rewards', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Get initial stake data
      const initialStake = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      const initialAmount = initialStake[0].amount;
      const initialEndTime = initialStake[0].end;
      const initialVotingPower = await stakeNoon.getTokenVotingPower(tokenId);

      // Verify no reward claimed yet
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(0);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Extend stake and compound reward
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, additionalDuration, rewardAmount, proof);

      // Get updated stake
      const updatedStake = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      const newEndTime = updatedStake[0].end;
      const newAmount = updatedStake[0].amount;

      // Verify the stake was extended
      expect(newEndTime).to.be.gt(initialEndTime);
      expect(newEndTime).to.equal((await time.latest()) + additionalDuration);

      // Verify reward was compounded (stake amount increased)
      expect(newAmount).to.equal(initialAmount + rewardAmount);

      // Verify reward was marked as claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // Verify total staked increased
      expect(await stakeNoon.totalStaked()).to.equal(
        initialAmount + rewardAmount
      );

      // Verify voting power increased (due to compounded reward)
      const newVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(newVotingPower).to.be.gt(initialVotingPower);

      // Verify total claimable amount decreased
      expect(await stakeNoon.getTotalClaimableAmount()).to.equal(0);
    });

    it('Should revert if trying to compound already claimed rewards', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // First extend and compound reward
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, additionalDuration, rewardAmount, proof);

      // Verify reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // Wait for the extended stake to expire again
      await time.increase(additionalDuration + 1);

      // Try to compound again (should revert)
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(tokenId, 0, additionalDuration + 1, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should revert if merkle proof is invalid when compounding rewards', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create invalid merkle tree with wrong token ID
      const invalidRewards = [{ tokenId: tokenId + 1n, amount: rewardAmount }];
      const leaves = invalidRewards.map((reward) =>
        ethers.solidityPackedKeccak256(
          ['uint256', 'uint256', 'string'],
          [reward.tokenId, reward.amount, 'WITHDRAWAL']
        )
      );
      // Add dummy node to ensure non-empty proofs
      const dummyLeaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [ethers.MaxUint256 - 1n, ethers.parseEther('1'), 'WITHDRAWAL']
      );
      const invalidMerkleTree = new MerkleTree(
        [...leaves, dummyLeaf],
        ethers.keccak256,
        {
          sortPairs: true,
        }
      );
      const invalidMerkleRoot = invalidMerkleTree.getHexRoot();

      // Set invalid merkle root
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(invalidMerkleRoot, rewardAmount);

      // Create proof for correct token ID (but with wrong merkle root)
      const correctLeaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const invalidProof = invalidMerkleTree.getHexProof(correctLeaf);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Try to extend with invalid proof (should revert)
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(
            tokenId,
            0,
            additionalDuration,
            rewardAmount,
            invalidProof
          )
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if trying to compound rewards using empty proof array', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create multi-node merkle tree for withdrawal rewards (so empty proof is invalid)
      // For single-node trees, empty proofs are valid (root == leaf)
      const withdrawalRewards = [
        { tokenId, amount: rewardAmount },
        { tokenId: tokenId + 1n, amount: ethers.parseEther('30') }, // Add another node
      ];
      const leaves = withdrawalRewards.map((reward) =>
        ethers.solidityPackedKeccak256(
          ['uint256', 'uint256', 'string'],
          [reward.tokenId, reward.amount, 'WITHDRAWAL']
        )
      );
      const tree = new MerkleTree(leaves, ethers.keccak256, {
        sortPairs: true,
      });
      const merkleRoot = tree.getHexRoot();

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Try to compound with empty proof when rewardAmount > 0
      // This should revert because empty proof won't verify against multi-node merkle root
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(tokenId, 0, additionalDuration, rewardAmount, [])
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if trying to compound rewards using proof for wrong amount', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create multi-node merkle tree with correct reward amount
      const withdrawalRewards = [
        { tokenId, amount: rewardAmount },
        { tokenId: tokenId + 1n, amount: ethers.parseEther('30') }, // Add another node
      ];
      const leaves = withdrawalRewards.map((reward) =>
        ethers.solidityPackedKeccak256(
          ['uint256', 'uint256', 'string'],
          [reward.tokenId, reward.amount, 'WITHDRAWAL']
        )
      );
      const tree = new MerkleTree(leaves, ethers.keccak256, {
        sortPairs: true,
      });
      const merkleRoot = tree.getHexRoot();

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Create invalid proof (for wrong amount that doesn't exist in tree)
      // The contract will construct leaf as (tokenId, rewardAmount, "WITHDRAWAL") which is correct
      // So we need to use a completely invalid proof
      const invalidProof: string[] = [
        '0x1234567890123456789012345678901234567890123456789012345678901234',
      ];

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Try to compound with invalid proof for wrong amount
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(
            tokenId,
            0,
            additionalDuration,
            rewardAmount,
            invalidProof
          )
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if trying to compound rewards when no merkle root is set', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create merkle tree but don't set it
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Try to compound when merkle root is not set (should be zero)
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(tokenId, 0, additionalDuration, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if trying to compound rewards using proof from different merkle tree', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create first merkle tree (multi-node) and set it
      const withdrawalRewards1 = [
        { tokenId, amount: rewardAmount },
        { tokenId: tokenId + 2n, amount: ethers.parseEther('30') }, // Add another node
      ];
      const leaves1 = withdrawalRewards1.map((reward) =>
        ethers.solidityPackedKeccak256(
          ['uint256', 'uint256', 'string'],
          [reward.tokenId, reward.amount, 'WITHDRAWAL']
        )
      );
      const tree1 = new MerkleTree(leaves1, ethers.keccak256, {
        sortPairs: true,
      });
      const merkleRoot1 = tree1.getHexRoot();

      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot1, rewardAmount);

      // Create second merkle tree with different data (different tokenId)
      const withdrawalRewards2 = [
        { tokenId: tokenId + 1n, amount: rewardAmount },
        { tokenId: tokenId + 3n, amount: ethers.parseEther('30') }, // Add another node
      ];
      const leaves2 = withdrawalRewards2.map((reward) =>
        ethers.solidityPackedKeccak256(
          ['uint256', 'uint256', 'string'],
          [reward.tokenId, reward.amount, 'WITHDRAWAL']
        )
      );
      const tree2 = new MerkleTree(leaves2, ethers.keccak256, {
        sortPairs: true,
      });
      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId + 1n, rewardAmount, 'WITHDRAWAL']
      );
      const proofFromTree2 = tree2.getHexProof(leaf2);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Try to compound with proof from different tree
      // The contract constructs leaf as (tokenId, rewardAmount, "WITHDRAWAL")
      // which is for tokenId, but proofFromTree2 is for tokenId+1, so it should fail
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(
            tokenId,
            0,
            additionalDuration,
            rewardAmount,
            proofFromTree2
          )
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should update voting power correctly when compounding rewards', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = TWO_YEARS;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Get initial voting power - VP = amount / 10 (no vesting contract)
      const initialVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      expect(initialVotingPower).to.equal(amount / 10n);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Extend stake and compound reward
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, additionalDuration, rewardAmount, proof);

      // Get updated stake
      const updatedStake = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      const newAmount = updatedStake[0].amount;
      const newMultiplier = updatedStake[0].multiplier;

      // Verify new amount includes compounded reward
      expect(newAmount).to.equal(amount + rewardAmount);

      // Get new voting power - VP = newAmount / 10 (no vesting contract)
      const newVotingPower = await stakeNoon.getTokenVotingPower(tokenId);
      const expectedVotingPower = newAmount / 10n;
      expect(newVotingPower).to.equal(expectedVotingPower);

      // Verify voting power increased due to compounding
      expect(newVotingPower).to.be.gt(initialVotingPower);
    });

    it('Should allow extending stake without compounding if rewardAmount is 0', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = TWO_YEARS;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Get initial stake data
      const initialStake = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      const initialAmount = initialStake[0].amount;

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Extend stake without compounding (rewardAmount = 0)
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, additionalDuration, 0, []);

      // Get updated stake
      const updatedStake = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      const newAmount = updatedStake[0].amount;

      // Verify amount didn't change (no reward compounded)
      expect(newAmount).to.equal(initialAmount);

      // Verify stake was extended
      expect(updatedStake[0].end).to.be.gt(initialStake[0].end);
    });

    it('Should emit WithdrawalRewardClaimed event when compounding rewards', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Extend stake and verify event emission
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(tokenId, 0, additionalDuration, rewardAmount, proof)
      )
        .to.emit(stakeNoon, 'WithdrawalRewardClaimed')
        .withArgs(tokenId, rewardAmount);
    });

    it('Should allow withdrawing expired stakes', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Get initial balance
      const initialBalance = await noon.balanceOf(await addr1.getAddress());

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Get balance after stake
      const balanceAfterStake = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfterStake).to.equal(initialBalance - amount);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Withdraw the stake
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Get final balance
      const finalBalance = await noon.balanceOf(await addr1.getAddress());
      expect(finalBalance).to.equal(initialBalance);

      // Verify stake is removed
      const userStakes = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      expect(userStakes.length).to.equal(0);
    });

    it('Should allow withdrawing before stake expires (stake.end is offchain only)', async function () {
      const amount = ethers.parseEther('100');
      const tokenId = await createStake(addr1, amount, ONE_YEAR);
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfter).to.equal(balanceBefore + amount);
    });

    it('Should allow withdrawing with additional reward using merkle proof', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Debug: Check balance after stake creation
      const balanceAfterStakeCreation = await noon.balanceOf(
        await addr1.getAddress()
      );
      console.log(
        'Balance after stake creation:',
        balanceAfterStakeCreation.toString()
      );
      console.log(
        'Expected balance after stake:',
        (ethers.parseEther('1000') - amount).toString()
      );

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Get balance after stake (should be 1000 - 100 = 900)
      const balanceAfterStake = await noon.balanceOf(await addr1.getAddress());

      // Withdraw with reward
      const tx = await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId, rewardAmount, proof);
      const receipt = await tx.wait();

      // Check final balance includes both stake amount and reward
      // Should be 900 + 100 + 50 = 1050
      const finalBalance = await noon.balanceOf(await addr1.getAddress());
      expect(finalBalance).to.equal(balanceAfterStake + amount + rewardAmount);

      // Verify reward was marked as claimed
      const isClaimed = (await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0;
      expect(isClaimed).to.be.true;
    });

    it('Should revert if trying to claim withdrawal reward twice', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // First withdrawal with reward
      await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId, rewardAmount, proof);

      // Verify reward was marked as claimed
      const isClaimed = (await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0;
      expect(isClaimed).to.be.true;
    });

    it('Should revert if merkle proof is invalid for withdrawal reward', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create invalid merkle tree with multiple leaves
      const invalidRewards = [
        { tokenId: tokenId + 1n, amount: rewardAmount }, // Wrong token ID
        { tokenId: tokenId + 2n, amount: rewardAmount }, // Another wrong token ID
      ];

      const leaves = invalidRewards.map((reward) =>
        ethers.solidityPackedKeccak256(
          ['uint256', 'uint256', 'string'],
          [reward.tokenId, reward.amount, 'WITHDRAWAL']
        )
      );
      // Add dummy node to ensure non-empty proofs
      const dummyLeaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [ethers.MaxUint256 - 1n, ethers.parseEther('1'), 'WITHDRAWAL']
      );

      const invalidMerkleTree = new MerkleTree(
        [...leaves, dummyLeaf],
        ethers.keccak256,
        {
          sortPairs: true,
        }
      );
      const merkleRoot = invalidMerkleTree.getHexRoot();
      const proof = invalidMerkleTree.getHexProof(leaves[0]);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Try to withdraw with invalid proof
      await expect(
        stakeNoon
          .connect(addr1)
          .withdrawWithReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should allow withdrawing without reward (backward compatibility)', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Get initial balance
      const initialBalance = await noon.balanceOf(await addr1.getAddress());

      // Withdraw without reward (using old function signature)
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Check final balance only includes stake amount
      const finalBalance = await noon.balanceOf(await addr1.getAddress());
      expect(finalBalance).to.equal(initialBalance + amount);
    });

    it('Should allow claiming reward after withdrawal', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Set merkle root and fund rewards FIRST
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);

      // Create merkle tree for withdrawal rewards AFTER getting tokenId
      const withdrawalMerkleTree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = withdrawalMerkleTree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = withdrawalMerkleTree.getHexProof(leaf);

      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Withdraw WITHOUT reward first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Verify stake owner is stored
      const storedOwner = await stakeNoon.withdrawnStakeOwners(tokenId);
      expect(storedOwner).to.equal(await addr1.getAddress());

      // Now claim the reward separately
      const balanceBeforeReward = await noon.balanceOf(
        await addr1.getAddress()
      );
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);
      const balanceAfterReward = await noon.balanceOf(await addr1.getAddress());

      // Verify reward was received
      expect(balanceAfterReward).to.equal(balanceBeforeReward + rewardAmount);

      // Verify reward was marked as claimed
      const isClaimed = (await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0;
      expect(isClaimed).to.be.true;
    });

    it('Should revert if non-owner tries to claim reward for withdrawn stake', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Withdraw stake
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Try to claim reward as different user
      await expect(
        stakeNoon
          .connect(addr2)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'NotOwner');
    });

    it('Should revert if trying to claim withdrawal reward twice using claimWithdrawalReward', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Withdraw stake first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // First claim should succeed
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);

      // Verify reward was marked as claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // Try to claim again (should revert)
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should revert if trying to claim withdrawal reward twice using withdrawWithReward then claimWithdrawalReward', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // First claim via withdrawWithReward (should succeed)
      await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId, rewardAmount, proof);

      // Verify reward was marked as claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // Try to claim again via claimWithdrawalReward (should revert)
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should revert if trying to compound reward twice in updateStake', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;
      const additionalDuration = ONE_YEAR;

      // Create initial stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Create merkle tree for withdrawal rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // First compound (should succeed)
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, 0, additionalDuration, rewardAmount, proof);

      // Verify reward was marked as claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // Wait for the extended stake to expire again
      await time.increase(additionalDuration + 1);

      // Try to compound again (should revert)
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(tokenId, 0, additionalDuration + 1, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should revert if trying to claim partial reward then full reward', async function () {
      const amount = ethers.parseEther('100');
      const partialReward = ethers.parseEther('30');
      const fullReward = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree with full reward amount
      const withdrawalMerkleTree = createWithdrawalRewardTree([
        { tokenId, amount: fullReward },
      ]);
      const merkleRoot = withdrawalMerkleTree.getHexRoot();
      const fullLeaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, fullReward, 'WITHDRAWAL']
      );
      const fullProof = withdrawalMerkleTree.getHexProof(fullLeaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), fullReward);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, fullReward);

      // Withdraw stake first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Try to claim partial reward (should fail - proof is for full amount)
      // This will fail with InvalidProof since the proof is for fullReward, not partialReward
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, partialReward, fullProof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should allow claiming larger reward after claiming smaller one', async function () {
      const amount = ethers.parseEther('100');
      const smallReward = ethers.parseEther('30');
      const largeReward = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree with large reward amount
      const withdrawalMerkleTree = createWithdrawalRewardTree([
        { tokenId, amount: largeReward },
      ]);
      const merkleRoot = withdrawalMerkleTree.getHexRoot();
      const largeLeaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, largeReward, 'WITHDRAWAL']
      );
      const proof = withdrawalMerkleTree.getHexProof(largeLeaf);

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), largeReward);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, largeReward);

      // Withdraw stake first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // First claim with small amount - create multi-node tree for small reward
      const smallRewardTree = createWithdrawalRewardTree([
        { tokenId, amount: smallReward },
      ]);

      // Update merkle root for small reward
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), smallReward);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(smallRewardTree.getHexRoot(), smallReward);

      const smallLeaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, smallReward, 'WITHDRAWAL']
      );
      const smallProof = smallRewardTree.getHexProof(smallLeaf);

      // Claim small reward
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, smallReward, smallProof);

      // Verify partial reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        smallReward
      );

      // Update merkle root for large reward
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), largeReward - smallReward);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(merkleRoot, largeReward - smallReward);

      // Claim larger reward (should claim the difference)
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, largeReward, proof);
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());

      // Should receive the difference
      expect(balanceAfter - balanceBefore).to.equal(largeReward - smallReward);

      // Verify full reward was marked as claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        largeReward
      );
    });
  });

  describe('NFT Functionality', function () {
    it('Should mint NFT when creating a stake', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();

      // Get the tokenId from the Transfer event
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      expect(await stakeNoon.ownerOf(tokenId)).to.equal(
        await addr1.getAddress()
      );
      expect(await stakeNoon.balanceOf(await addr1.getAddress())).to.equal(1);
    });

    it('Should burn NFT when withdrawing a stake', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);
      expect(await stakeNoon.balanceOf(await addr1.getAddress())).to.equal(0);
    });

    it('Should prevent transfers when not enabled', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await expect(
        stakeNoon
          .connect(addr1)
          .transferFrom(
            await addr1.getAddress(),
            await addr2.getAddress(),
            tokenId
          )
      ).to.be.revertedWithCustomError(stakeNoon, 'TransfersNotEnabled');
    });

    it('Should allow transfers when enabled', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await stakeNoon.setTransferable(true);
      await stakeNoon
        .connect(addr1)
        .transferFrom(
          await addr1.getAddress(),
          await addr2.getAddress(),
          tokenId
        );

      expect(await stakeNoon.ownerOf(tokenId)).to.equal(
        await addr2.getAddress()
      );
    });

    it('Should prevent VIP token transfers even when transfers are enabled', async function () {
      const amount = ethers.parseEther('100');

      // Create merkle tree and proof for VIP stake
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      // Transfer tokens to owner and approve
      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      // Create VIP stake through claimAndStake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await stakeNoon.setTransferable(true);

      await expect(
        stakeNoon
          .connect(addr1)
          .transferFrom(
            await addr1.getAddress(),
            await addr2.getAddress(),
            tokenId
          )
      ).to.be.revertedWithCustomError(stakeNoon, 'VIPTokensNotTransferable');
    });

    it('Should update stake ownership when NFT is transferred', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await stakeNoon.setTransferable(true);
      await stakeNoon
        .connect(addr1)
        .transferFrom(
          await addr1.getAddress(),
          await addr2.getAddress(),
          tokenId
        );

      const stakeIds = await stakeNoon.getUserStakeIds(
        await addr2.getAddress()
      );
      expect(stakeIds.length).to.equal(1);
      const stake = await stakeNoon.stakes(stakeIds[0]);
      expect(stake.amount).to.equal(amount);
    });
  });

  describe('Permanent Stakes', function () {
    it('Should calculate correct voting power for non-permanent stakes', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Get initial voting power
      const initialVotingPower = await stakeNoon.getTokenVotingPower(tokenId);

      // Move forward half the duration
      await time.increase(ONE_YEAR / 2);

      // Check voting power remains constant (no decay)
      const votingPowerAfterHalfYear =
        await stakeNoon.getTokenVotingPower(tokenId);

      expect(votingPowerAfterHalfYear).to.equal(initialVotingPower);

      // Move forward past stake.end - VP unchanged (stake.end is offchain only)
      await time.increase(ONE_YEAR / 2 + 1);

      const stake = await stakeNoon.stakes(tokenId);
      const currentTime = await time.latest();
      expect(currentTime).to.be.gte(stake.end); // stake.end has passed (for offchain reference)

      // Voting power unchanged (stake.end has no on-chain effect)
      const votingPowerAtEnd = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPowerAtEnd).to.equal(initialVotingPower);
    });
  });

  describe('Stake Limits', function () {
    it('Should allow up to 3 normal stakes per user', async function () {
      // Create 3 stakes
      await createStake(addr1, ethers.parseEther('100'), ONE_YEAR);
      await createStake(addr1, ethers.parseEther('100'), ONE_YEAR);
      await createStake(addr1, ethers.parseEther('100'), ONE_YEAR);

      // Try to create a fourth stake
      await expect(
        stakeNoon.connect(addr1).createStake(ethers.parseEther('100'), ONE_YEAR)
      ).to.be.revertedWithCustomError(stakeNoon, 'MaxNormalStakesReached');
    });

    it('Should allow only 1 VIP stake per user', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('150');

      // Create merkle tree and proof for first VIP stake
      const leaf1 = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount1])
      );
      const tree1 = new MerkleTree([leaf1], ethers.keccak256, {
        sortPairs: true,
      });
      const proof1 = tree1.getHexProof(leaf1);

      // Transfer tokens to owner and approve for first stake
      await noon.transfer(await owner.getAddress(), amount1);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount1);
      await stakeNoon.setMerkleRoot(tree1.getHexRoot(), amount1);

      // Create first VIP stake
      const tx1 = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount1, 100, proof1);
      const receipt1 = await tx1.wait();
      const transferEvent1 = receipt1?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId1 = transferEvent1?.args[2];

      // Verify VIP stake count
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(1);

      // Create new merkle tree and proof for second VIP stake attempt
      const leaf2 = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount2])
      );
      const tree2 = new MerkleTree([leaf2], ethers.keccak256, {
        sortPairs: true,
      });
      const proof2 = tree2.getHexProof(leaf2);

      // Transfer tokens to owner and approve for second stake attempt
      await noon.transfer(await owner.getAddress(), amount2);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount2);
      await stakeNoon.setMerkleRoot(tree2.getHexRoot(), amount2);

      // Try to create second VIP stake (should keep first stake)
      await stakeNoon.connect(addr1).claimAndStake(amount2, 100, proof2);
      //should have only 1 stake
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(1);
      //check amount of stake
      expect((await stakeNoon.stakes(tokenId1))[0]).to.equal(amount2);
    });

    it('Should track VIP stake count correctly', async function () {
      const amount = ethers.parseEther('100');

      // Create merkle tree and proof for VIP stake
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      // Transfer tokens to owner and approve
      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      // Create VIP stake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Verify VIP stake count
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(1);

      // Start unstake process
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);

      // Move time forward by 7 days
      await time.increase(7 * 24 * 60 * 60);

      // Withdraw VIP stake
      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      // Verify VIP stake count is decreased
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(0);
    });

    it('Should allow withdrawing VIP tokens anytime', async function () {
      const amount = ethers.parseEther('100');

      // Create merkle tree and proof for VIP stake
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      // Transfer tokens to owner and approve
      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      // Create VIP stake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Get initial balance
      const initialBalance = await noon.balanceOf(await addr1.getAddress());

      // Start unstake process
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);

      // Move time forward by 7 days
      await time.increase(7 * 24 * 60 * 60);

      // Withdraw VIP token
      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      // Verify token is burned
      expect(await stakeNoon.balanceOf(await addr1.getAddress())).to.equal(0);

      // Verify tokens are returned
      const finalBalance = await noon.balanceOf(await addr1.getAddress());
      expect(finalBalance).to.equal(initialBalance + amount);

      // Verify stake is removed
      const userStakes = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      expect(userStakes.length).to.equal(0);

      // Verify VIP stake count is decreased
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(0);
    });

    it('Should allow one-step direct VIP withdrawal when vipUnlockingPeriod is 0', async function () {
      const amount = ethers.parseEther('100');
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      const initialBalance = await noon.balanceOf(await addr1.getAddress());

      // Set vipUnlockingPeriod to 0 for one-step flow
      await stakeNoon.setVipUnlockingPeriod(0);

      // One-step: withdraw directly without startVIPUnstake
      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      expect(await stakeNoon.balanceOf(await addr1.getAddress())).to.equal(0);
      const finalBalance = await noon.balanceOf(await addr1.getAddress());
      expect(finalBalance).to.equal(initialBalance + amount);
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(0);
    });

    it('Should revert startVIPUnstake when vipUnlockingPeriod is 0', async function () {
      const amount = ethers.parseEther('100');
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await stakeNoon.setVipUnlockingPeriod(0);

      await expect(
        stakeNoon.connect(addr1).startVIPUnstake(tokenId)
      ).to.be.revertedWithCustomError(stakeNoon, 'UnlockNotRequired');
    });

    it('Should use snapshot of vipUnlockingPeriod so owner cannot extend wait after unlock started', async function () {
      const amount = ethers.parseEther('100');
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      const sevenDays = 7 * 24 * 60 * 60;
      const thirtyDays = 30 * 24 * 60 * 60;
      await stakeNoon.setVipUnlockingPeriod(sevenDays);

      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);

      // Owner tries to extend the period after user started unlock
      await stakeNoon.setVipUnlockingPeriod(thirtyDays);

      // After 7 days (original period), user should still be able to withdraw
      await time.increase(sevenDays);
      const balanceBefore = await noon.balanceOf(addr1.address);
      await stakeNoon.connect(addr1).withdrawVip(tokenId);
      const balanceAfter = await noon.balanceOf(addr1.address);
      expect(balanceAfter).to.equal(balanceBefore + amount);
    });

    it('Should allow owner to update max stakes', async function () {
      // Initial values
      expect(await stakeNoon.maxNormalStakes()).to.equal(3);
      expect(await stakeNoon.maxVipStakes()).to.equal(1);

      // Update max stakes
      await expect(stakeNoon.updateMaxStakes(5, 2))
        .to.emit(stakeNoon, 'MaxStakesUpdated')
        .withArgs(5, 2);

      // Verify new values
      expect(await stakeNoon.maxNormalStakes()).to.equal(5);
      expect(await stakeNoon.maxVipStakes()).to.equal(2);
    });

    it('Should not allow non-owner to update max stakes', async function () {
      await expect(
        stakeNoon.connect(addr1).updateMaxStakes(5, 2)
      ).to.be.revertedWithCustomError(stakeNoon, 'OwnableUnauthorizedAccount');
    });

    it('Should not allow setting max stakes to zero', async function () {
      await expect(
        stakeNoon.updateMaxStakes(0, 2)
      ).to.be.revertedWithCustomError(
        stakeNoon,
        'MaxNormalStakesMustBeGreaterThanZero'
      );
      await expect(
        stakeNoon.updateMaxStakes(5, 0)
      ).to.be.revertedWithCustomError(
        stakeNoon,
        'MaxVIPStakesMustBeGreaterThanZero'
      );
    });

    it('Should respect updated max stakes limits', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Update max stakes
      await stakeNoon.updateMaxStakes(2, 1);

      // Create first stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.connect(addr1).createStake(amount, stakeDuration);
      // Create second stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.connect(addr1).createStake(amount, stakeDuration);
      // Try to create third stake (should fail)
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      await expect(
        stakeNoon.connect(addr1).createStake(amount, stakeDuration)
      ).to.be.revertedWithCustomError(stakeNoon, 'MaxNormalStakesReached');

      // Create merkle tree and proof for first VIP stake
      const leaf1 = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree1 = new MerkleTree([leaf1], ethers.keccak256, {
        sortPairs: true,
      });
      const proof1 = tree1.getHexProof(leaf1);

      // Transfer tokens to owner and approve for first VIP stake
      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree1.getHexRoot(), amount);

      // Create first VIP stake
      await stakeNoon.connect(addr1).claimAndStake(amount, 100, proof1);

      // Create new merkle tree and proof for second VIP stake attempt
      const leaf2 = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr1.address, amount * 2n]
        )
      );
      const tree2 = new MerkleTree([leaf2], ethers.keccak256, {
        sortPairs: true,
      });
      const proof2 = tree2.getHexProof(leaf2);

      // Transfer tokens to owner and approve for second VIP stake attempt
      await noon.transfer(await owner.getAddress(), amount * 2n);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), amount * 2n);
      await stakeNoon.setMerkleRoot(tree2.getHexRoot(), amount * 2n);

      // Try to create second VIP stake (should fail)
      await stakeNoon.connect(addr1).claimAndStake(amount * 2n, 100, proof2);
      //should have only 1 stake
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(1);
    });
  });

  describe('Claim and Stake', function () {
    let merkleTree: any;
    let merkleRoot: string;
    let proof: string[];
    const totalAmount = ethers.parseEther('1000');

    beforeEach(async function () {
      // Create merkle tree with test data
      const leaves = [
        {
          account: await addr1.getAddress(),
          amount: ethers.parseEther('100'),
        },
        {
          account: await addr2.getAddress(),
          amount: ethers.parseEther('200'),
        },
      ];

      // Create merkle tree
      const elements = leaves.map((leaf) =>
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [leaf.account, leaf.amount]
          )
        )
      );
      merkleTree = new MerkleTree(elements, ethers.keccak256, {
        sortPairs: true,
      });
      merkleRoot = merkleTree.getHexRoot();

      // Transfer NOON tokens to owner for setting merkle root
      await noon.transfer(await owner.getAddress(), totalAmount);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), totalAmount);

      // Set merkle root in contract
      await stakeNoon.setMerkleRoot(merkleRoot, totalAmount);

      // Get proof for addr1
      const leaf = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await addr1.getAddress(), ethers.parseEther('100')]
        )
      );
      proof = merkleTree.getHexProof(leaf);
    });

    it('Should allow users to claim and stake tokens with VIP status', async function () {
      const amount = ethers.parseEther('100');

      // Claim and stake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Verify stake data
      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.amount).to.equal(amount);
      expect(stake.isVip).to.be.true;
      expect(stake.end).to.equal((await time.latest()) + FOUR_YEARS);
      expect(stake.multiplier).to.equal(ethers.parseEther('1')); // 1x (multiplier no longer used for VP)

      // Verify user stake count
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(1);

      // Verify claimed amount
      expect(
        await stakeNoon.getClaimedAmount(await addr1.getAddress())
      ).to.equal(amount);
      expect(await stakeNoon.getTotalClaimableAmount()).to.equal(
        totalAmount - amount
      );
    });

    it('Should send partial claim to wallet when stakePercentage < 100', async function () {
      const amount = ethers.parseEther('100');
      const stakePct = 50; // 50% staked, 50% to wallet

      const balanceBefore = await noon.balanceOf(addr1.address);

      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, stakePct, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      const stake = await stakeNoon.stakes(tokenId);
      const expectedStaked = (amount * BigInt(stakePct)) / 100n;
      const expectedToWallet = amount - expectedStaked;

      expect(stake.amount).to.equal(expectedStaked);
      expect(stake.isVip).to.be.true;

      const balanceAfter = await noon.balanceOf(addr1.address);
      expect(balanceAfter - balanceBefore).to.equal(expectedToWallet);

      expect(await stakeNoon.getClaimedAmount(addr1.address)).to.equal(amount);
    });

    it('Should send 100% to wallet when stakePercentage is 0', async function () {
      const amount = ethers.parseEther('100');

      const balanceBefore = await noon.balanceOf(addr1.address);

      const tx = await stakeNoon.connect(addr1).claimAndStake(amount, 0, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.amount).to.equal(0);
      expect(stake.isVip).to.be.true;

      const balanceAfter = await noon.balanceOf(addr1.address);
      expect(balanceAfter - balanceBefore).to.equal(amount);

      expect(await stakeNoon.getClaimedAmount(addr1.address)).to.equal(amount);
    });

    it('After 10 years, user who staked 50% gets full staked amount back on withdraw', async function () {
      const amount = ethers.parseEther('100');
      const stakePct = 50; // 50% staked, 50% to wallet

      // Deploy and set vesting so the staked 50% has vesting (90%) + stake (10%)
      const StakeNOONVesting =
        await ethers.getContractFactory('stakeNOONVesting');
      const vesting = (await upgrades.deployProxy(
        StakeNOONVesting,
        [
          await noon.getAddress(),
          await stakeNoon.getAddress(),
          await owner.getAddress(),
        ],
        { initializer: 'initialize' }
      )) as unknown as StakeNOONVesting;
      await stakeNoon.setVestingContract(await vesting.getAddress());

      const stakedPortion = (amount * BigInt(stakePct)) / 100n; // 50
      const vestingAllocation = stakedPortion * 9n; // 90% of staked is in vesting
      await noon.transfer(await vesting.getAddress(), vestingAllocation);
      await noon
        .connect(owner)
        .approve(await vesting.getAddress(), vestingAllocation);
      await vesting.addVestingAllocation(vestingAllocation);

      const balanceBeforeClaim = await noon.balanceOf(addr1.address);

      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, stakePct, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      const balanceAfterClaim = await noon.balanceOf(addr1.address);
      const toWalletAtClaim = amount - stakedPortion;
      expect(balanceAfterClaim - balanceBeforeClaim).to.equal(toWalletAtClaim);

      // Advance 10 years: vesting (12 months) is fully vested, user can withdraw
      await time.increase(10 * 365 * 24 * 60 * 60);

      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      await time.increase(7 * 24 * 60 * 60);

      const balanceBeforeWithdraw = await noon.balanceOf(addr1.address);
      await stakeNoon.connect(addr1).withdrawVip(tokenId);
      const balanceAfterWithdraw = await noon.balanceOf(addr1.address);

      // VIP stake: 10% in stake.amount, 90% in vesting (schedule totalAmount = stakedPortion * 9).
      // After 10 years vesting is full, so user gets stake.amount (50) + full vested (450) = 500.
      const expectedFromWithdraw = stakedPortion * 10n; // 10% + 90% = 10x the "immediate" share
      expect(balanceAfterWithdraw - balanceBeforeWithdraw).to.equal(
        expectedFromWithdraw
      );

      // Total received: 50% to wallet at claim (50) + full staked value on withdraw (500) = 550
      expect(balanceAfterWithdraw - balanceBeforeClaim).to.equal(
        toWalletAtClaim + expectedFromWithdraw
      );
    });

    it('Should add to existing VIP stake with partial percentage and send rest to wallet', async function () {
      const amount = ethers.parseEther('100');
      const stakePct = 75; // 75% staked, 25% to wallet

      const tx1 = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, stakePct, proof);
      const receipt1 = await tx1.wait();
      const transferEvent1 = receipt1?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent1?.args[2];

      const stakeAfterFirst = await stakeNoon.stakes(tokenId);
      const expectedStaked = (amount * BigInt(stakePct)) / 100n;
      const expectedToWallet = amount - expectedStaked;

      expect(stakeAfterFirst.amount).to.equal(expectedStaked);

      // Update merkle for second claim (addr1 total 200)
      const leaves = [
        { account: await addr1.getAddress(), amount: ethers.parseEther('200') },
        { account: await addr2.getAddress(), amount: ethers.parseEther('200') },
      ];
      const elements = leaves.map((leaf) =>
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [leaf.account, leaf.amount]
          )
        )
      );
      const newTree = new MerkleTree(elements, ethers.keccak256, {
        sortPairs: true,
      });
      const additionalForSecond = ethers.parseEther('100');
      await noon.transfer(await owner.getAddress(), additionalForSecond);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), additionalForSecond);
      await stakeNoon.setMerkleRoot(newTree.getHexRoot(), additionalForSecond);

      const leaf2 = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr1.address, ethers.parseEther('200')]
        )
      );
      const proof2 = newTree.getHexProof(leaf2);

      const balanceBeforeSecond = await noon.balanceOf(addr1.address);
      await stakeNoon
        .connect(addr1)
        .claimAndStake(ethers.parseEther('200'), 50, proof2);

      const additionalClaimed = ethers.parseEther('100');
      const additionalStaked = (additionalClaimed * 50n) / 100n;
      const additionalToWallet = additionalClaimed - additionalStaked;

      const stakeAfterSecond = await stakeNoon.stakes(tokenId);
      expect(stakeAfterSecond.amount).to.equal(
        expectedStaked + additionalStaked
      );

      // Second claim: 50% of additional 100 to wallet
      const balanceAfterSecond = await noon.balanceOf(addr1.address);
      expect(balanceAfterSecond - balanceBeforeSecond).to.equal(
        additionalToWallet
      );
    });

    it('Should not allow claiming more than max VIP stakes', async function () {
      const amount = ethers.parseEther('100');

      // First claim
      await stakeNoon.connect(addr1).claimAndStake(amount, 100, proof);

      // Try to claim again with same proof
      await expect(
        stakeNoon.connect(addr1).claimAndStake(amount, 100, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should add amounts to existing VIP stake', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('50');

      // First claim
      const tx1 = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount1, 100, proof);
      const receipt1 = await tx1.wait();
      const transferEvent1 = receipt1?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent1?.args[2];

      // Get initial stake data
      const initialStake = await stakeNoon.stakes(tokenId);
      expect(initialStake.amount).to.equal(amount1);

      // Create new merkle tree with updated amounts
      const leaves = [
        {
          account: await addr1.getAddress(),
          amount: amount1 + amount2, // Updated total amount
        },
        {
          account: await addr2.getAddress(),
          amount: ethers.parseEther('200'),
        },
      ];

      // Create merkle tree
      const elements = leaves.map((leaf) =>
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [leaf.account, leaf.amount]
          )
        )
      );
      const newMerkleTree = new MerkleTree(elements, ethers.keccak256, {
        sortPairs: true,
      });
      const newMerkleRoot = newMerkleTree.getHexRoot();

      // Update merkle root in contract
      await noon.transfer(await owner.getAddress(), amount2);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount2);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), totalAmount);
      await stakeNoon.setMerkleRoot(newMerkleRoot, totalAmount);

      // Get proof for second claim - use the total amount as the leaf
      const leaf2 = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await addr1.getAddress(), amount1 + amount2]
        )
      );
      const proof2 = newMerkleTree.getHexProof(leaf2);

      // Second claim - use the total amount
      await stakeNoon
        .connect(addr1)
        .claimAndStake(amount1 + amount2, 100, proof2);

      // Verify stake data is updated
      const updatedStake = await stakeNoon.stakes(tokenId);
      expect(updatedStake.amount).to.equal(amount1 + amount2);
      expect(updatedStake.isVip).to.be.true;
      expect(updatedStake.end).to.equal((await time.latest()) + FOUR_YEARS);
      expect(updatedStake.multiplier).to.equal(ethers.parseEther('1')); // 1x (multiplier no longer used for VP)

      // Verify user still has only one VIP stake
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(1);

      // Verify claimed amount
      expect(
        await stakeNoon.getClaimedAmount(await addr1.getAddress())
      ).to.equal(amount1 + amount2);
      expect(await stakeNoon.getTotalClaimableAmount()).to.equal(
        totalAmount * 2n - amount2 - amount1
      );
    });

    it('Should allow withdrawing VIP tokens anytime', async function () {
      const amount = ethers.parseEther('100');

      // Create VIP stake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Get initial balance
      const initialBalance = await noon.balanceOf(await addr1.getAddress());

      // Start unstake process
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);

      // Move time forward by 7 days
      await time.increase(7 * 24 * 60 * 60);

      // Withdraw VIP token
      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      // Verify token is burned
      expect(await stakeNoon.balanceOf(await addr1.getAddress())).to.equal(0);

      // Verify tokens are returned
      const finalBalance = await noon.balanceOf(await addr1.getAddress());
      expect(finalBalance).to.equal(initialBalance + amount);

      // Verify stake is removed
      const userStakes = await stakeNoon.getUserStakes(
        await addr1.getAddress()
      );
      expect(userStakes.length).to.equal(0);

      // Verify VIP stake count is decreased
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(0);
    });

    it('Should not allow non-owners to withdraw VIP tokens', async function () {
      const amount = ethers.parseEther('100');

      // Create VIP stake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Try to withdraw as non-owner
      await expect(
        stakeNoon.connect(addrs[0]).withdrawVip(tokenId)
      ).to.be.revertedWithCustomError(stakeNoon, 'NotOwner');
    });

    it('Should not allow withdrawing non-VIP tokens', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create normal stake
      await noon.connect(addr1).approve(await stakeNoon.getAddress(), amount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(amount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Try to withdraw as VIP
      await expect(
        stakeNoon.connect(addr1).withdrawVip(tokenId)
      ).to.be.revertedWithCustomError(stakeNoon, 'NotVIPStake');
    });

    it('Should not allow claiming more than allowed amount', async function () {
      const amount = ethers.parseEther('200'); // addr1 is only allowed 100

      await expect(
        stakeNoon.connect(addr1).claimAndStake(amount, 100, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should not allow claiming with invalid proof', async function () {
      const amount = ethers.parseEther('100');
      const invalidProof = [ethers.keccak256('0x1234')];

      await expect(
        stakeNoon.connect(addr1).claimAndStake(amount, 100, invalidProof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should allow owner to update merkle root with new amount', async function () {
      const newRoot = ethers.keccak256('0x1234');
      const newAmount = ethers.parseEther('500');

      // Transfer more tokens to owner
      await noon.transfer(await owner.getAddress(), newAmount);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), newAmount);

      await expect(stakeNoon.setMerkleRoot(newRoot, newAmount))
        .to.emit(stakeNoon, 'MerkleRootUpdated')
        .withArgs(newRoot, newAmount);

      expect(await stakeNoon.merkleRoot()).to.equal(newRoot);
      expect(await stakeNoon.getTotalClaimableAmount()).to.equal(
        newAmount + totalAmount
      );
    });

    it('Should not allow non-owner to update merkle root', async function () {
      const newRoot = ethers.keccak256('0x1234');
      const newAmount = ethers.parseEther('500');

      await expect(
        stakeNoon.connect(addr1).setMerkleRoot(newRoot, newAmount)
      ).to.be.revertedWithCustomError(stakeNoon, 'OwnableUnauthorizedAccount');
    });

    it('Should not allow setting merkle root with zero amount', async function () {
      const newRoot = ethers.keccak256('0x1234');
      await expect(
        stakeNoon.setMerkleRoot(newRoot, 0)
      ).to.be.revertedWithCustomError(stakeNoon, 'AmountMustBeGreaterThanZero');
    });

    it('Should allow multiple claimAndStake calls with incrementing amounts and verify voting power', async function () {
      const baseAmount = ethers.parseEther('100');
      const numClaims = 20;

      // Deploy and setup vesting contract
      const stakeNOONVesting =
        await ethers.getContractFactory('stakeNOONVesting');
      const vesting = (await upgrades.deployProxy(
        stakeNOONVesting,
        [
          await noon.getAddress(),
          await stakeNoon.getAddress(),
          await owner.getAddress(),
        ],
        {
          initializer: 'initialize',
        }
      )) as unknown as StakeNOONVesting;
      await stakeNoon.setVestingContract(await vesting.getAddress());

      // Add vesting allocation
      const vestingAmount = baseAmount * BigInt(numClaims) * 9n; // 9x multiplier for vesting
      await noon.transfer(await owner.getAddress(), vestingAmount);
      await noon
        .connect(owner)
        .approve(await vesting.getAddress(), vestingAmount);
      await vesting.addVestingAllocation(vestingAmount);

      // Initial setup for claimAndStake
      const totalClaimAmount = baseAmount * BigInt(numClaims);
      await noon.transfer(await owner.getAddress(), totalClaimAmount);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), totalClaimAmount);

      let currentAmount = baseAmount;
      let tokenId;

      // Create merkle tree and proof for first claim
      const leaf1 = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr1.address, currentAmount]
        )
      );
      const tree1 = new MerkleTree([leaf1], ethers.keccak256, {
        sortPairs: true,
      });
      const proof1 = tree1.getHexProof(leaf1);

      // Set merkle root for first claim
      await stakeNoon.setMerkleRoot(tree1.getHexRoot(), currentAmount);

      // First claim
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(currentAmount, 100, proof1);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      tokenId = transferEvent?.args[2];
      // Move time forward by 6 months to allow some vesting
      await time.increase(180 * 24 * 60 * 60);

      // Start unstake process
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);

      // Move time forward by 7 days
      await time.increase(7 * 24 * 60 * 60);

      // Withdraw first stake
      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      // Create merkle tree and proof for second claim
      currentAmount = baseAmount * 2n;
      const leaf2 = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr1.address, currentAmount]
        )
      );
      const tree2 = new MerkleTree([leaf2], ethers.keccak256, {
        sortPairs: true,
      });
      const proof2 = tree2.getHexProof(leaf2);

      // Set merkle root for second claim
      await stakeNoon.setMerkleRoot(tree2.getHexRoot(), currentAmount);

      // Second claim
      const tx2 = await stakeNoon
        .connect(addr1)
        .claimAndStake(currentAmount, 100, proof2);
      const receipt2 = await tx2.wait();
      const transferEvent2 = receipt2?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      tokenId = transferEvent2?.args[2];

      // Move time forward by 6 months to allow some vesting
      await time.increase(180 * 24 * 60 * 60);

      // Get vesting schedules for the stake
      const schedules = await vesting.getVestingSchedulesForStake(tokenId);
      let totalVested = 0n;

      // Calculate total vested amount
      for (const schedule of schedules) {
        const vestedAmount = await vesting.calculateVestedAmount(
          schedule.totalAmount,
          schedule.startTime,
          schedule.endTime,
          tokenId
        );
        totalVested += BigInt(vestedAmount) - BigInt(schedule.claimedAmount);
      }

      // Verify voting power (VP follows curve + vesting schedules, no multiplier)
      const votingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      // VP should be > 0 and less than total 10x (amount * 10)
      expect(votingPower).to.be.gt(0);
      expect(votingPower).to.be.lt(currentAmount * 10n);
    });
  });

  describe('Increase Stake Amount', function () {
    it('Should allow increasing stake amount', async function () {
      const initialAmount = ethers.parseEther('100');
      const additionalAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create initial stake
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), initialAmount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(initialAmount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Get initial stake data
      const initialStake = await stakeNoon.stakes(tokenId);
      expect(initialStake.amount).to.equal(initialAmount);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Approve and increase stake amount
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), additionalAmount);
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(tokenId, additionalAmount, 0, 0, [])
      )
        .to.emit(stakeNoon, 'StakeAmountIncreased')
        .withArgs(tokenId, additionalAmount, initialAmount + additionalAmount);

      // Verify stake data is updated
      const updatedStake = await stakeNoon.stakes(tokenId);
      expect(updatedStake.amount).to.equal(initialAmount + additionalAmount);
      expect(updatedStake.end).to.equal(initialStake.end); // End time should remain the same
      expect(updatedStake.multiplier).to.equal(initialStake.multiplier); // Multiplier should remain the same

      // Verify total stakeed amount is updated
      expect(await stakeNoon.totalStaked()).to.equal(
        initialAmount + additionalAmount
      );
    });

    it('Should not allow non-owners to increase stake amount', async function () {
      const initialAmount = ethers.parseEther('100');
      const additionalAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), initialAmount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(initialAmount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Try to increase amount as non-owner
      await noon
        .connect(addr2)
        .approve(await stakeNoon.getAddress(), additionalAmount);
      await expect(
        stakeNoon
          .connect(addr2)
          .updateStake(tokenId, additionalAmount, 0, 0, [])
      ).to.be.revertedWithCustomError(stakeNoon, 'NotOwner');
    });

    it('Should not allow increasing amount for non-existent stake', async function () {
      const additionalAmount = ethers.parseEther('50');
      const nonExistentTokenId = 999;

      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), additionalAmount);
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(nonExistentTokenId, additionalAmount, 0, 0, [])
      ).to.be.revertedWithCustomError(stakeNoon, 'ERC721NonexistentToken');
    });

    it('Should not allow increasing VIP stake amount', async function () {
      const amount = ethers.parseEther('100');
      const additionalAmount = ethers.parseEther('50');

      // Create merkle tree and proof for VIP stake
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      // Transfer tokens to owner and approve
      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      // Create VIP stake through claimAndStake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Try to increase VIP stake amount
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), additionalAmount);
      await expect(
        stakeNoon
          .connect(addr1)
          .updateStake(tokenId, additionalAmount, 0, 0, [])
      ).to.be.revertedWithCustomError(
        stakeNoon,
        'CannotIncreaseVIPStakeAmount'
      );
    });

    it('Should maintain voting power ratio when increasing stake amount', async function () {
      const initialAmount = ethers.parseEther('100');
      const additionalAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), initialAmount);
      const tx = await stakeNoon
        .connect(addr1)
        .createStake(initialAmount, stakeDuration);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Get initial voting power
      const initialVotingPower = await stakeNoon.getTokenVotingPower(tokenId);

      // Wait for stake to expire
      await time.increase(stakeDuration + 1);

      // Increase stake amount and extend duration to reactivate the stake
      await noon
        .connect(addr1)
        .approve(await stakeNoon.getAddress(), additionalAmount);
      await stakeNoon
        .connect(addr1)
        .updateStake(tokenId, additionalAmount, stakeDuration, 0, []);

      // Get new voting power
      const newVotingPower = await stakeNoon.getTokenVotingPower(tokenId);

      // Voting power should increase proportionally (allow for small rounding differences)
      // New amount is 1.5x, multiplier is still 1x for 1 year, so voting power should be 1.5x
      const expectedVotingPower = (initialVotingPower * 3n) / 2n;
      expect(newVotingPower).to.be.closeTo(
        expectedVotingPower,
        ethers.parseEther('0.0001')
      );
    });
  });

  describe('Claim and Stake with Multiple Durations', function () {
    let merkleTree: any;
    let merkleRoot: string;
    let proof: string[];
    const totalAmount = ethers.parseEther('1000');
    let vesting: any;

    beforeEach(async function () {
      // Deploy vesting contract
      const stakeNOONVesting =
        await ethers.getContractFactory('stakeNOONVesting');
      vesting = (await upgrades.deployProxy(
        stakeNOONVesting,
        [
          await noon.getAddress(),
          await stakeNoon.getAddress(),
          await owner.getAddress(),
        ],
        {
          initializer: 'initialize',
        }
      )) as unknown as StakeNOONVesting;

      // Set vesting contract in stakeNOON
      await stakeNoon.setVestingContract(await vesting.getAddress());

      // Add vesting allocation
      const vestingAmount = totalAmount * 9n; // 9x multiplier for vesting
      await noon.transfer(await owner.getAddress(), vestingAmount);
      await noon
        .connect(owner)
        .approve(await vesting.getAddress(), vestingAmount);
      await vesting.addVestingAllocation(vestingAmount);

      // Create merkle tree with test data
      const leaves = [
        {
          account: await addr1.getAddress(),
          amount: ethers.parseEther('100'),
        },
        {
          account: await addr2.getAddress(),
          amount: ethers.parseEther('200'),
        },
      ];

      // Create merkle tree
      const elements = leaves.map((leaf) =>
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [leaf.account, leaf.amount]
          )
        )
      );
      merkleTree = new MerkleTree(elements, ethers.keccak256, {
        sortPairs: true,
      });
      merkleRoot = merkleTree.getHexRoot();

      // Transfer NOON tokens to owner for setting merkle root
      await noon.transfer(await owner.getAddress(), totalAmount);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), totalAmount);

      // Set merkle root in contract
      await stakeNoon.setMerkleRoot(merkleRoot, totalAmount);

      // Get proof for addr1
      const leaf = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await addr1.getAddress(), ethers.parseEther('100')]
        )
      );
      proof = merkleTree.getHexProof(leaf);
    });

    it('Should allow claiming and withdrawing at different time points', async function () {
      const amount = ethers.parseEther('100');

      // Initial claim and stake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Get initial voting power - at t=0, curve gates all VP, so VP = 0
      const initialVotingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(initialVotingPower).to.equal(0n);

      // Test after 6 months
      await time.increase(180 * 24 * 60 * 60); // 6 months
      const votingPowerAfter6Months = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      // VP should be > initial (some curve + vesting has accrued)
      expect(votingPowerAfter6Months).to.be.gt(initialVotingPower);
      expect(votingPowerAfter6Months).to.be.lt(amount * 10n);

      // Test after 1 year - baseVP full (10x), curve at 25% of 4yr
      await time.increase(185 * 24 * 60 * 60); // Another ~6 months (total ~365 days)
      const votingPowerAfter1Year = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPowerAfter1Year).to.be.gt(votingPowerAfter6Months);

      // Test after 4 years - curve and vesting fully vested, VP = 10x
      await time.increase(3 * 365 * 24 * 60 * 60); // 3 more years (total 4 years)
      const votingPowerAfter4Years = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPowerAfter4Years).to.equal(amount * 10n);

      // Get balance before withdrawal
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      await time.increase(7 * 24 * 60 * 60); // 7 days unlock
      // Withdraw after 4 years + unlock
      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      // Verify withdrawal
      expect(await stakeNoon.balanceOf(await addr1.getAddress())).to.equal(0n);
      expect(await noon.balanceOf(await addr1.getAddress())).to.equal(
        balanceBefore + amount * 10n
      );
      expect(await stakeNoon.totalStaked()).to.equal(0n);
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(0);
    });

    it('Should handle multiple claims and withdrawals with different durations', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('150');

      // First claim
      const tx1 = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount1, 100, proof);
      const receipt1 = await tx1.wait();
      const transferEvent1 = receipt1?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId1 = transferEvent1?.args[2];

      // Create new merkle tree for second claim
      const leaf2 = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await addr1.getAddress(), amount2]
        )
      );
      const tree2 = new MerkleTree([leaf2], ethers.keccak256, {
        sortPairs: true,
      });
      const proof2 = tree2.getHexProof(leaf2);

      // Update merkle root for second claim
      await noon.transfer(await owner.getAddress(), amount2);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount2);
      await stakeNoon.setMerkleRoot(tree2.getHexRoot(), amount2);

      // Second claim
      await stakeNoon.connect(addr1).claimAndStake(amount2, 100, proof2);

      // Verify both stakes exist
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(1);
      const stake = await stakeNoon.stakes(tokenId1);
      expect(stake.amount).to.equal(amount2);

      // Test after 4 years - curve and vesting fully vested
      await time.increase(4 * 365 * 24 * 60 * 60);
      await stakeNoon.setVipUnlockingPeriod(0);
      const votingPowerAfter4Years = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPowerAfter4Years).to.equal(amount2 * 10n);

      // Get balance before withdrawal
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());

      await stakeNoon.connect(addr1).withdrawVip(tokenId1);

      // Verify withdrawal
      expect(await stakeNoon.balanceOf(await addr1.getAddress())).to.equal(0n);
      expect(await noon.balanceOf(await addr1.getAddress())).to.equal(
        balanceBefore + amount2 * 10n
      );
      expect(await stakeNoon.totalStaked()).to.equal(0n);
      expect(
        await stakeNoon.userVipStakeCount(await addr1.getAddress())
      ).to.equal(0);
    });

    it('Should maintain correct voting power after multiple claims and time periods', async function () {
      const amount = ethers.parseEther('100');

      // Create merkle tree and proof for VIP stake
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      // Transfer tokens to owner and approve
      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      // Create VIP stake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Move time forward by 6 months
      await time.increase(180 * 24 * 60 * 60);

      // Get voting power after 6 months
      const votingPowerAfter6Months = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPowerAfter6Months).to.be.gt(0);

      // Start unstake process
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);

      // Move time forward by 7 days
      await time.increase(7 * 24 * 60 * 60);

      // Get voting power after unstake period
      const votingPowerAfterUnstake = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(votingPowerAfterUnstake).to.be.gt(0);

      // Withdraw VIP stake
      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      // Verify final voting power is 0
      const finalVotingPower = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );
      expect(finalVotingPower).to.equal(0);
    });
  });

  describe('Claim and Stake', function () {
    it('Should not allow setting merkle root with zero amount', async function () {
      await expect(
        stakeNoon.setMerkleRoot(ethers.ZeroHash, 0)
      ).to.be.revertedWithCustomError(stakeNoon, 'AmountMustBeGreaterThanZero');
    });
  });

  describe('VIP Claiming', function () {
    it('Should allow users to claim VIP allocation without stakeing', async function () {
      const amount = ethers.parseEther('100');
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const proof = merkleTree.getHexProof(leaf);

      // Set merkle root and transfer tokens to contract
      await noon.approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(merkleTree.getHexRoot(), amount);

      // Get initial balances
      const initialBalance = await noon.balanceOf(addr1.address);
      const initialClaimed = await stakeNoon.claimedAmounts(addr1.address);

      // Claim VIP allocation
      await stakeNoon.connect(addr1).claimVIP(amount, proof);

      // Check final balances
      const finalBalance = await noon.balanceOf(addr1.address);
      const finalClaimed = await stakeNoon.claimedAmounts(addr1.address);

      // Verify balances
      expect(finalBalance - initialBalance).to.equal(amount);
      expect(finalClaimed).to.equal(amount);
      expect(initialClaimed).to.equal(0n);
    });

    it('Should revert if user tries to claim more than allocated', async function () {
      const amount = ethers.parseEther('100');
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const proof = merkleTree.getHexProof(leaf);

      // Set merkle root and transfer tokens to contract
      await noon.approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(merkleTree.getHexRoot(), amount);

      // Try to claim more than allocated
      await expect(
        stakeNoon.connect(addr1).claimVIP(amount + 1n, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InsufficientClaimableAmount');
    });

    it('Should revert if user tries to claim with invalid proof', async function () {
      const amount = ethers.parseEther('100');
      const invalidLeaf = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr1.address, amount + 1n]
        )
      );
      const invalidProof = merkleTree.getHexProof(invalidLeaf);

      // Set merkle root and transfer tokens to contract
      await noon.approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(merkleTree.getHexRoot(), amount);

      // Try to claim with invalid proof
      await expect(
        stakeNoon.connect(addr1).claimVIP(amount, invalidProof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if user tries to claim twice', async function () {
      const amount = ethers.parseEther('100');
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const proof = merkleTree.getHexProof(leaf);

      // Set merkle root and transfer tokens to contract
      await noon.approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(merkleTree.getHexRoot(), amount);

      // First claim
      await stakeNoon.connect(addr1).claimVIP(amount, proof);

      // Try to claim again
      await expect(
        stakeNoon.connect(addr1).claimVIP(amount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should emit VIPClaimed event on successful claim', async function () {
      const amount = ethers.parseEther('100');
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const proof = merkleTree.getHexProof(leaf);

      // Set merkle root and transfer tokens to contract
      await noon.approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(merkleTree.getHexRoot(), amount);

      // Claim and check event
      await expect(stakeNoon.connect(addr1).claimVIP(amount, proof))
        .to.emit(stakeNoon, 'VIPClaimed')
        .withArgs(addr1.address, amount);
    });
  });

  describe('VIP Stake Unstaking Period', () => {
    it('should not allow claim and stake while VIP stake is in unstaking period', async () => {
      const [owner, user1] = await ethers.getSigners();
      const amount = ethers.parseEther('1000');

      // Create a single leaf for the merkle tree
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [user1.address, amount])
      );

      // For a single leaf, the proof is empty but we need to set the merkle root to the leaf itself
      const merkleRoot = leaf;
      const proof: string[] = [];

      // Set merkle root and transfer tokens
      await noon.approve(stakeNoon.target, amount);
      await stakeNoon.setMerkleRoot(merkleRoot, amount);

      // Create initial VIP stake
      await stakeNoon.connect(user1).claimAndStake(amount, 100, proof);
      const tokenId = 1; // First token ID

      // Start VIP unstake
      await stakeNoon.connect(user1).startVIPUnstake(tokenId);

      const merkleRoot2 = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [user1.address, amount * 2n]
        )
      );
      //approve the tokens
      await noon.approve(stakeNoon.target, amount);
      await stakeNoon.setMerkleRoot(merkleRoot2, amount);
      //proof for the new merkle root
      const proof2: string[] = [];

      // Try to claim and stake again while in unstaking period
      await expect(
        stakeNoon.connect(user1).claimAndStake(amount * 2n, 100, proof2)
      ).to.be.revertedWithCustomError(stakeNoon, 'VIPStakeInWithdrawingPeriod');
    });

    it('should revert with invalid proof when using empty proof array', async () => {
      const [owner, user1] = await ethers.getSigners();
      const amount = ethers.parseEther('1000');

      // Create a merkle root that doesn't match the empty proof
      const merkleRoot = ethers.keccak256(
        ethers.toUtf8Bytes('some random data')
      );
      const proof: string[] = [];

      // Set merkle root and transfer tokens
      await noon.approve(stakeNoon.target, amount);
      await stakeNoon.setMerkleRoot(merkleRoot, amount);

      // Try to claim and stake with empty proof
      await expect(
        stakeNoon.connect(user1).claimAndStake(amount, 100, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });
  });
});
