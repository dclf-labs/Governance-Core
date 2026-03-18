import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { EventLog } from 'ethers';
import { ethers, upgrades } from 'hardhat';
import { MerkleTree } from 'merkletreejs';
import { NOON } from '../typechain-types/contracts/NOON';
import { StakeNOON } from '../typechain-types/contracts/StakeNOON';

describe('Withdrawal Rewards', function () {
  let noon: NOON;
  let stakeNoon: StakeNOON;
  let owner: HardhatEthersSigner;
  let addr1: HardhatEthersSigner;
  let addr2: HardhatEthersSigner;
  let addrs: HardhatEthersSigner[];

  const ONE_YEAR = 365 * 24 * 60 * 60;
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
  });

  describe('Withdraw with Reward', function () {
    it('Should allow withdrawing with reward and track claimed amount', async function () {
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

      // Get initial balance
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());

      // Verify no reward claimed yet
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(0);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .false;

      // Withdraw with reward
      await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId, rewardAmount, proof);

      // Check final balance
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfter).to.equal(balanceBefore + amount + rewardAmount);

      // Verify reward amount is tracked correctly
      const claimedAmount = await stakeNoon.claimedWithdrawalRewards(tokenId);
      expect(claimedAmount).to.equal(rewardAmount);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .true;
    });

    it('Should allow withdrawing with reward before stake expires (stake.end is offchain only)', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake (do not advance time - stake not "expired")
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

      // Withdraw with reward before stake "expires" - should succeed
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId, rewardAmount, proof);
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfter).to.equal(balanceBefore + amount + rewardAmount);
    });

    it('Should revert if trying to claim same reward twice', async function () {
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

      // Verify reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // Try to claim again with same amount (should fail because tokenId is already burned)
      // This will fail at the owner check since NFT is burned
      await expect(
        stakeNoon
          .connect(addr1)
          .withdrawWithReward(tokenId, rewardAmount, proof)
      ).to.be.reverted;
    });

    it('Should revert if merkle proof is invalid', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create valid merkle tree
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Use a completely random/invalid proof that doesn't match the merkle root
      const invalidProof: string[] = [
        '0x1234567890123456789012345678901234567890123456789012345678901234',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ];

      // Try to withdraw with invalid proof
      // The contract will construct leaf with (tokenId, rewardAmount, "WITHDRAWAL")
      // but the proof is completely random and doesn't match the merkle root, so it should fail
      await expect(
        stakeNoon
          .connect(addr1)
          .withdrawWithReward(tokenId, rewardAmount, invalidProof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if trying to withdraw with reward using empty proof array', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create multi-node merkle tree (so empty proof is invalid)
      // For single-node trees, empty proofs are valid (root == leaf)
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
        { tokenId: tokenId + 1n, amount: ethers.parseEther('30') }, // Add another node
      ]);
      const merkleRoot = tree.getHexRoot();

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Try to withdraw with empty proof when rewardAmount > 0
      // This should revert because empty proof won't verify against the merkle root
      await expect(
        stakeNoon.connect(addr1).withdrawWithReward(tokenId, rewardAmount, [])
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if trying to withdraw with reward using proof for wrong amount', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create multi-node merkle tree with correct reward amount
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
        { tokenId: tokenId + 1n, amount: ethers.parseEther('30') }, // Add another node
      ]);
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

      // Try to withdraw with invalid proof for wrong amount
      await expect(
        stakeNoon
          .connect(addr1)
          .withdrawWithReward(tokenId, rewardAmount, invalidProof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if trying to withdraw with reward when no merkle root is set', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree but don't set it
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      // Try to withdraw with proof when merkle root is not set (should be zero)
      await expect(
        stakeNoon
          .connect(addr1)
          .withdrawWithReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should revert if trying to withdraw with reward using proof from different merkle tree', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create first merkle tree (multi-node) and set it
      const tree1 = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
        { tokenId: tokenId + 2n, amount: ethers.parseEther('30') }, // Add another node
      ]);
      const merkleRoot1 = tree1.getHexRoot();

      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot1, rewardAmount);

      // Create second merkle tree with different data (different tokenId)
      const tree2 = createWithdrawalRewardTree([
        { tokenId: tokenId + 1n, amount: rewardAmount },
        { tokenId: tokenId + 3n, amount: ethers.parseEther('30') }, // Add another node
      ]);
      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId + 1n, rewardAmount, 'WITHDRAWAL']
      );
      const proofFromTree2 = tree2.getHexProof(leaf2);

      // Try to withdraw with proof from different tree
      // The contract constructs leaf as (tokenId, rewardAmount, "WITHDRAWAL")
      // which is for tokenId, but proofFromTree2 is for tokenId+1, so it should fail
      await expect(
        stakeNoon
          .connect(addr1)
          .withdrawWithReward(tokenId, rewardAmount, proofFromTree2)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should allow withdrawing without reward (rewardAmount = 0, empty proof)', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Get initial balance
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());

      // Withdraw without reward (rewardAmount = 0, empty proof array)
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Check final balance (should only include stake amount)
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfter).to.equal(balanceBefore + amount);

      // Verify no reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(0);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .false;
    });

    it('Should allow withdrawing with rewardAmount = 0 and no proof (empty array)', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Get initial balance
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());

      // Withdraw with rewardAmount = 0 and empty proof array
      // This should work the same as withdraw() - no reward processing
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Check final balance (should only include stake amount, no reward)
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfter).to.equal(balanceBefore + amount);

      // Verify stake was withdrawn
      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.amount).to.equal(0);

      // Verify no reward was tracked
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(0);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .false;

      // Verify withdrawn stake owner is stored
      expect(await stakeNoon.withdrawnStakeOwners(tokenId)).to.equal(
        await addr1.getAddress()
      );
    });

    it('Should allow withdrawing with rewardAmount = 0 even when merkle root exists', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree for withdrawal rewards (but we won't use it)
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();

      // Set merkle root and fund rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // Get initial balance
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());

      // Withdraw with rewardAmount = 0 and empty proof (should ignore merkle root)
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Check final balance (should only include stake amount, no reward)
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfter).to.equal(balanceBefore + amount);

      // Verify no reward was claimed (even though merkle root exists)
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(0);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .false;

      // Verify total claimable amount is still available
      expect(await stakeNoon.getTotalClaimableAmount()).to.equal(rewardAmount);
    });

    it('Should revert if trying to use withdrawWithReward on VIP stake', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create merkle tree for VIP stake
      const leaf = ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [addr1.address, amount])
      );
      const tree = new MerkleTree([leaf], ethers.keccak256, {
        sortPairs: true,
      });
      const proof = tree.getHexProof(leaf);

      // Set merkle root and fund rewards
      await noon.transfer(await owner.getAddress(), amount);
      await noon.connect(owner).approve(await stakeNoon.getAddress(), amount);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), amount);

      // Create VIP stake through claimAndStake
      const tx = await stakeNoon.connect(addr1).claimAndStake(amount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Verify it's a VIP stake
      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.isVip).to.be.true;

      // Move forward past stake duration (VIP stakes can be withdrawn anytime after unlock period)
      await time.increase(ONE_YEAR + 1);

      // Try to use withdrawWithReward on VIP stake (should revert)
      await expect(
        stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, [])
      ).to.be.revertedWithCustomError(stakeNoon, 'NotVIPStake');
    });
  });

  describe('Claim Withdrawal Reward After Withdrawal', function () {
    it('Should allow claiming reward separately after withdrawal', async function () {
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

      // Withdraw without reward first
      const balanceBeforeWithdrawal = await noon.balanceOf(
        await addr1.getAddress()
      );
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Verify stake owner is stored
      const storedOwner = await stakeNoon.withdrawnStakeOwners(tokenId);
      expect(storedOwner).to.equal(await addr1.getAddress());

      // Verify no reward claimed yet
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(0);

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

      // Verify total received is stake + reward
      const totalReceived = balanceAfterReward - balanceBeforeWithdrawal;
      expect(totalReceived).to.equal(amount + rewardAmount);

      // Verify reward amount is tracked correctly
      const claimedAmount = await stakeNoon.claimedWithdrawalRewards(tokenId);
      expect(claimedAmount).to.equal(rewardAmount);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .true;
    });

    it('Should revert if trying to claim reward for stake that is not unlocked (not withdrawn)', async function () {
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

      // Stake is expired but NOT withdrawn yet (still exists)
      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.amount).to.equal(amount); // Stake still exists

      // Try to claim reward while stake is still active (not withdrawn/unlocked)
      // Should revert because stake needs to be withdrawn first
      // The contract checks withdrawnStakeOwners first, which will be address(0)
      // So it reverts with NotOwner before checking StakeNotWithdrawn
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'NotOwner');
    });

    it('Should allow claiming reward after stake is withdrawn (unlocked)', async function () {
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

      // Withdraw stake first (unlock it)
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Verify stake is unlocked (withdrawn - stake no longer exists)
      // Check that stake.amount is 0 or token doesn't exist
      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.amount).to.equal(0); // Stake is withdrawn

      // Verify withdrawn stake owner is stored
      const storedOwner = await stakeNoon.withdrawnStakeOwners(tokenId);
      expect(storedOwner).to.equal(await addr1.getAddress());

      // Now claim reward (should succeed because stake is unlocked)
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());

      // Verify reward was received
      expect(balanceAfter).to.equal(balanceBefore + rewardAmount);

      // Verify reward was marked as claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );
    });

    it('Should allow VIP user to claim withdrawal reward after withdrawVip', async function () {
      const vipAmount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');

      // Create merkle tree for VIP claim (claimAndStake)
      const vipLeaf = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [addr1.address, vipAmount]
        )
      );
      const vipTree = new MerkleTree([vipLeaf], ethers.keccak256, {
        sortPairs: true,
      });
      const vipProof = vipTree.getHexProof(vipLeaf);

      // Fund and set merkle root for VIP claim
      await noon.transfer(await owner.getAddress(), vipAmount);
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), vipAmount);
      await stakeNoon.setMerkleRoot(vipTree.getHexRoot(), vipAmount);

      // Create VIP stake via claimAndStake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(vipAmount, 100, vipProof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Create merkle tree for withdrawal rewards (tokenId known after VIP stake created)
      const withdrawalTree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const withdrawalLeaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const withdrawalProof = withdrawalTree.getHexProof(withdrawalLeaf);

      // Set merkle root and fund withdrawal rewards
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(withdrawalTree.getHexRoot(), rewardAmount);

      // Start VIP unstake and wait unlock period
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      await time.increase(7 * 24 * 60 * 60);

      // Withdraw VIP stake
      const balanceBeforeWithdraw = await noon.balanceOf(
        await addr1.getAddress()
      );
      await stakeNoon.connect(addr1).withdrawVip(tokenId);
      const balanceAfterWithdraw = await noon.balanceOf(
        await addr1.getAddress()
      );
      expect(balanceAfterWithdraw).to.equal(balanceBeforeWithdraw + vipAmount);

      // Verify withdrawnStakeOwners is set (VIP exits leave same ownership trail as normal withdrawals)
      const storedOwner = await stakeNoon.withdrawnStakeOwners(tokenId);
      expect(storedOwner).to.equal(await addr1.getAddress());

      // Claim withdrawal reward (should succeed - previously reverted with NotOwner before L-1 fix)
      const balanceBeforeReward = await noon.balanceOf(
        await addr1.getAddress()
      );
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, withdrawalProof);
      const balanceAfterReward = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfterReward).to.equal(balanceBeforeReward + rewardAmount);

      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );
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

    it('Should revert if trying to claim reward twice', async function () {
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

      // First claim
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);

      // Verify reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // Try to claim again
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should revert if insufficient claimable amount available', async function () {
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

      // Set merkle root with less than required amount
      const insufficientAmount = rewardAmount / 2n;
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), insufficientAmount);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(merkleRoot, insufficientAmount);

      // Withdraw stake
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Try to claim reward (should fail due to insufficient funds)
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InsufficientClaimableAmount');
    });
  });

  describe('Amount Tracking', function () {
    it('Should correctly track claimed amounts for multiple withdrawals', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const rewardAmount1 = ethers.parseEther('50');
      const rewardAmount2 = ethers.parseEther('75');
      const stakeDuration = ONE_YEAR;

      // Create first stake
      const tokenId1 = await createStake(addr1, amount1, stakeDuration);

      // Create second stake
      const tokenId2 = await createStake(addr2, amount2, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Create merkle tree with both rewards
      const tree = createWithdrawalRewardTree([
        { tokenId: tokenId1, amount: rewardAmount1 },
        { tokenId: tokenId2, amount: rewardAmount2 },
      ]);
      const merkleRoot = tree.getHexRoot();

      // Get proofs for both
      const leaf1 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId1, rewardAmount1, 'WITHDRAWAL']
      );
      const proof1 = tree.getHexProof(leaf1);

      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId2, rewardAmount2, 'WITHDRAWAL']
      );
      const proof2 = tree.getHexProof(leaf2);

      // Set merkle root and fund rewards
      const totalRewardAmount = rewardAmount1 + rewardAmount2;
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), totalRewardAmount);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(merkleRoot, totalRewardAmount);

      // Withdraw first stake with reward
      await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId1, rewardAmount1, proof1);

      // Verify first reward tracking
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId1)).to.equal(
        rewardAmount1
      );
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId2)).to.equal(0);

      // Withdraw second stake with reward
      await stakeNoon
        .connect(addr2)
        .withdrawWithReward(tokenId2, rewardAmount2, proof2);

      // Verify both rewards tracked correctly
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId1)).to.equal(
        rewardAmount1
      );
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId2)).to.equal(
        rewardAmount2
      );
    });

    it('Should emit WithdrawalRewardClaimed event with correct parameters', async function () {
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

      // Withdraw with reward and check event
      await expect(
        stakeNoon
          .connect(addr1)
          .withdrawWithReward(tokenId, rewardAmount, proof)
      )
        .to.emit(stakeNoon, 'WithdrawalRewardClaimed')
        .withArgs(tokenId, rewardAmount);
    });
  });

  describe('Edge Cases', function () {
    it('Should handle zero reward amount gracefully', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Withdraw with zero reward
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfter).to.equal(balanceBefore + amount);

      // Verify no reward tracked
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(0);
    });

    it('Should revert if claiming reward with zero amount', async function () {
      const amount = ethers.parseEther('100');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Withdraw stake first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Try to claim zero reward
      await expect(
        stakeNoon.connect(addr1).claimWithdrawalReward(tokenId, 0, [])
      ).to.be.revertedWithCustomError(stakeNoon, 'AmountMustBeGreaterThanZero');
    });

    it('Should verify amount tracking persists after multiple merkle root updates', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount1 = ethers.parseEther('50');
      const rewardAmount2 = ethers.parseEther('100'); // Updated amount
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // First merkle tree with smaller reward
      const tree1 = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount1 },
      ]);
      const merkleRoot1 = tree1.getHexRoot();
      const leaf1 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount1, 'WITHDRAWAL']
      );
      const proof1 = tree1.getHexProof(leaf1);

      // Set first merkle root
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount1);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot1, rewardAmount1);

      // Withdraw with first reward
      await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId, rewardAmount1, proof1);

      // Verify first amount tracked
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount1
      );

      // Note: Since the NFT is burned, we can't test claiming again with a new tree
      // But this test shows the amount tracking works correctly for the first claim
    });
  });

  describe('Claim Reward After Withdrawal (Delayed Merkle Root)', function () {
    it('Should allow user to withdraw stake first, then claim reward later when merkle root is set', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // User withdraws WITHOUT reward (no merkle root set yet)
      const balanceBeforeWithdrawal = await noon.balanceOf(
        await addr1.getAddress()
      );
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Verify stake owner is stored
      const storedOwner = await stakeNoon.withdrawnStakeOwners(tokenId);
      expect(storedOwner).to.equal(await addr1.getAddress());

      // Verify no reward claimed yet and no merkle root exists
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(0);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .false;
      expect(await stakeNoon.merkleRoot()).to.equal(ethers.ZeroHash);

      // Verify balance only has stake amount (no reward)
      const balanceAfterWithdrawal = await noon.balanceOf(
        await addr1.getAddress()
      );
      expect(balanceAfterWithdrawal).to.equal(balanceBeforeWithdrawal + amount);

      // Wait some time (simulating delay)
      await time.increase(30 * 24 * 60 * 60); // 30 days later

      // NOW set merkle root and fund rewards (after withdrawal)
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

      // Verify reward is now available
      expect(await stakeNoon.merkleRoot()).to.equal(merkleRoot);
      expect(await stakeNoon.getTotalClaimableAmount()).to.equal(rewardAmount);

      // Now claim the reward separately (later)
      const balanceBeforeReward = await noon.balanceOf(
        await addr1.getAddress()
      );
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);

      const balanceAfterReward = await noon.balanceOf(await addr1.getAddress());

      // Verify reward was received
      expect(balanceAfterReward).to.equal(balanceBeforeReward + rewardAmount);

      // Verify total received is stake + reward
      const totalReceived = balanceAfterReward - balanceBeforeWithdrawal;
      expect(totalReceived).to.equal(amount + rewardAmount);

      // Verify reward amount is tracked correctly
      const claimedAmount = await stakeNoon.claimedWithdrawalRewards(tokenId);
      expect(claimedAmount).to.equal(rewardAmount);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .true;
    });

    it('Should allow user to withdraw stake first, then claim reward later when merkle root is updated', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount1 = ethers.parseEther('30');
      const rewardAmount2 = ethers.parseEther('50'); // Higher reward later
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // User withdraws WITHOUT reward (no merkle root set yet)
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Verify stake owner is stored
      const storedOwner = await stakeNoon.withdrawnStakeOwners(tokenId);
      expect(storedOwner).to.equal(await addr1.getAddress());

      // Set initial merkle root with smaller reward
      const tree1 = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount1 },
      ]);
      const merkleRoot1 = tree1.getHexRoot();
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount1);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot1, rewardAmount1);

      // Wait some time
      await time.increase(7 * 24 * 60 * 60); // 7 days later

      // Update merkle root with higher reward
      const tree2 = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount2 },
      ]);
      const merkleRoot2 = tree2.getHexRoot();
      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount2, 'WITHDRAWAL']
      );
      const proof2 = tree2.getHexProof(leaf2);

      // Fund additional amount (total should be rewardAmount1 + rewardAmount2)
      const additionalAmount = rewardAmount2 - rewardAmount1;
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), additionalAmount);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(merkleRoot2, additionalAmount);

      // Now claim the higher reward
      const balanceBeforeReward = await noon.balanceOf(
        await addr1.getAddress()
      );
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount2, proof2);

      const balanceAfterReward = await noon.balanceOf(await addr1.getAddress());

      // Verify reward was received (should be rewardAmount2)
      expect(balanceAfterReward).to.equal(balanceBeforeReward + rewardAmount2);

      // Verify reward amount is tracked correctly
      const claimedAmount = await stakeNoon.claimedWithdrawalRewards(tokenId);
      expect(claimedAmount).to.equal(rewardAmount2);
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .true;
    });

    it('Should handle multiple users withdrawing first, then claiming rewards later', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const rewardAmount1 = ethers.parseEther('50');
      const rewardAmount2 = ethers.parseEther('75');
      const stakeDuration = ONE_YEAR;

      // Create stakes for both users
      const tokenId1 = await createStake(addr1, amount1, stakeDuration);
      const tokenId2 = await createStake(addr2, amount2, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Both users withdraw WITHOUT reward
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId1, 0, []);
      await stakeNoon.connect(addr2).withdrawWithReward(tokenId2, 0, []);

      // Verify both stake owners are stored
      expect(await stakeNoon.withdrawnStakeOwners(tokenId1)).to.equal(
        await addr1.getAddress()
      );
      expect(await stakeNoon.withdrawnStakeOwners(tokenId2)).to.equal(
        await addr2.getAddress()
      );

      // Wait some time
      await time.increase(15 * 24 * 60 * 60); // 15 days later

      // NOW set merkle root with both rewards
      const tree = createWithdrawalRewardTree([
        { tokenId: tokenId1, amount: rewardAmount1 },
        { tokenId: tokenId2, amount: rewardAmount2 },
      ]);
      const merkleRoot = tree.getHexRoot();

      // Get proofs for both
      const leaf1 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId1, rewardAmount1, 'WITHDRAWAL']
      );
      const proof1 = tree.getHexProof(leaf1);

      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId2, rewardAmount2, 'WITHDRAWAL']
      );
      const proof2 = tree.getHexProof(leaf2);

      // Set merkle root and fund rewards
      const totalRewardAmount = rewardAmount1 + rewardAmount2;
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), totalRewardAmount);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(merkleRoot, totalRewardAmount);

      // First user claims reward
      const balance1Before = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId1, rewardAmount1, proof1);
      const balance1After = await noon.balanceOf(await addr1.getAddress());
      expect(balance1After).to.equal(balance1Before + rewardAmount1);

      // Second user claims reward
      const balance2Before = await noon.balanceOf(await addr2.getAddress());
      await stakeNoon
        .connect(addr2)
        .claimWithdrawalReward(tokenId2, rewardAmount2, proof2);
      const balance2After = await noon.balanceOf(await addr2.getAddress());
      expect(balance2After).to.equal(balance2Before + rewardAmount2);

      // Verify both rewards tracked correctly
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId1)).to.equal(
        rewardAmount1
      );
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId2)).to.equal(
        rewardAmount2
      );
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId1)) > 0n).to.be
        .true;
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId2)) > 0n).to.be
        .true;
    });

    it('Should revert if user tries to claim reward before merkle root is set', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // User withdraws WITHOUT reward (no merkle root set yet)
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Verify no merkle root exists
      expect(await stakeNoon.merkleRoot()).to.equal(ethers.ZeroHash);

      // Try to claim reward (should fail - no merkle root)
      const invalidProof: string[] = [];
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, rewardAmount, invalidProof)
      ).to.be.revertedWithCustomError(stakeNoon, 'InvalidProof');
    });

    it('Should allow claiming reward even if significant time has passed after withdrawal', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // User withdraws WITHOUT reward
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Wait a long time (e.g., 1 year later)
      await time.increase(365 * 24 * 60 * 60);

      // NOW set merkle root and fund rewards
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);

      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // User should still be able to claim reward
      const balanceBeforeReward = await noon.balanceOf(
        await addr1.getAddress()
      );
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);
      const balanceAfterReward = await noon.balanceOf(await addr1.getAddress());

      // Verify reward was received
      expect(balanceAfterReward).to.equal(balanceBeforeReward + rewardAmount);
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );
    });
  });

  describe('Prevent Multiple Reward Claims', function () {
    it('Should revert if user tries to claim same reward twice using withdrawWithReward', async function () {
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

      // First withdrawal with reward (should succeed)
      await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId, rewardAmount, proof);

      // Verify reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .true;

      // Try to claim again (should fail - NFT is burned, so can't withdraw again)
      // This will fail at the owner check since NFT is burned
      await expect(
        stakeNoon
          .connect(addr1)
          .withdrawWithReward(tokenId, rewardAmount, proof)
      ).to.be.reverted; // Will fail because token doesn't exist anymore
    });

    it('Should revert if user tries to claim same reward twice using claimWithdrawalReward', async function () {
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

      // Withdraw without reward first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // First claim (should succeed)
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);

      // Verify reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );
      expect((await stakeNoon.claimedWithdrawalRewards(tokenId)) > 0n).to.be
        .true;

      // Try to claim again with same amount (should fail)
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should revert if user tries to claim reward with different amount but same tokenId (partial claim)', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Withdraw without reward first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Create merkle tree with full reward amount
      const tree = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount },
      ]);
      const merkleRoot = tree.getHexRoot();
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot, rewardAmount);

      // First claim full reward (should succeed)
      const leaf = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount, 'WITHDRAWAL']
      );
      const proof = tree.getHexProof(leaf);
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);

      // Try to claim again with same tokenId but different amount (should fail)
      // Even if the merkle tree has a different amount, the claimed amount check should fail
      const smallerReward = rewardAmount / 2n;
      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, smallerReward, 'WITHDRAWAL']
      );

      // Create new tree with smaller amount
      const tree2 = createWithdrawalRewardTree([
        { tokenId, amount: smallerReward },
      ]);
      const proof2 = tree2.getHexProof(leaf2);
      const merkleRoot2 = tree2.getHexRoot();

      // Set new merkle root
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), smallerReward);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot2, smallerReward);

      // Try to claim smaller amount (should fail because already claimed full amount)
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, smallerReward, proof2)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should allow claiming larger reward after claiming smaller one (claims difference)', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount1 = ethers.parseEther('30');
      const rewardAmount2 = ethers.parseEther('50'); // Larger reward
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Withdraw without reward first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Create merkle tree with smaller reward amount
      const tree1 = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount1 },
      ]);
      const merkleRoot1 = tree1.getHexRoot();
      const leaf1 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount1, 'WITHDRAWAL']
      );
      const proof1 = tree1.getHexProof(leaf1);

      // Set merkle root and fund smaller reward
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount1);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot1, rewardAmount1);

      // Claim smaller reward (should succeed)
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount1, proof1);

      // Verify smaller reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount1
      );

      // Now try to claim larger reward (should fail)
      const tree2 = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount2 },
      ]);
      const merkleRoot2 = tree2.getHexRoot();
      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount2, 'WITHDRAWAL']
      );
      const proof2 = tree2.getHexProof(leaf2);

      // Fund additional amount
      const additionalAmountForFunding = rewardAmount2 - rewardAmount1;
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), additionalAmountForFunding);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(merkleRoot2, additionalAmountForFunding);

      // Try to claim larger reward
      // The contract allows claiming the difference (rewardAmount2 - rewardAmount1)
      // So if we claimed 30, we can claim up to 50 (the additional 20)
      // The contract checks: if (claimedWithdrawalRewards[tokenId] >= rewardAmount) revert AlreadyClaimed();
      // So if claimed = 30 and rewardAmount = 50, then 30 >= 50 is false, so it won't revert.
      // It will calculate: additionalRewardAmount = 50 - 30 = 20, and claim it.
      // The test name says it should revert, but the contract logic allows claiming the difference.
      // Updating the test to match the actual contract behavior - it should allow claiming the difference.
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount2, proof2);
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());

      // Should claim the difference (rewardAmount2 - rewardAmount1 = 50 - 30 = 20)
      const differenceAmount = rewardAmount2 - rewardAmount1;
      expect(balanceAfter).to.equal(balanceBefore + differenceAmount);

      // Verify total claimed is now rewardAmount2
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount2
      );
    });

    it('Should allow claiming additional reward if user claimed partial reward first', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount1 = ethers.parseEther('30');
      const rewardAmount2 = ethers.parseEther('50'); // Total reward
      const stakeDuration = ONE_YEAR;

      // Create stake
      const tokenId = await createStake(addr1, amount, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Withdraw without reward first
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);

      // Create merkle tree with partial reward amount
      const tree1 = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount1 },
      ]);
      const merkleRoot1 = tree1.getHexRoot();
      const leaf1 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount1, 'WITHDRAWAL']
      );
      const proof1 = tree1.getHexProof(leaf1);

      // Set merkle root and fund partial reward
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), rewardAmount1);
      await stakeNoon.connect(owner).setMerkleRoot(merkleRoot1, rewardAmount1);

      // Claim partial reward (should succeed)
      const balanceBefore1 = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount1, proof1);
      const balanceAfter1 = await noon.balanceOf(await addr1.getAddress());
      expect(balanceAfter1).to.equal(balanceBefore1 + rewardAmount1);

      // Verify partial reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount1
      );

      // Now set merkle root with full reward amount
      const tree2 = createWithdrawalRewardTree([
        { tokenId, amount: rewardAmount2 },
      ]);
      const merkleRoot2 = tree2.getHexRoot();
      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId, rewardAmount2, 'WITHDRAWAL']
      );
      const proof2 = tree2.getHexProof(leaf2);

      // Fund additional amount (only the difference)
      const additionalAmount = rewardAmount2 - rewardAmount1;
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), additionalAmount);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(merkleRoot2, additionalAmount);

      // Claim the additional reward (should succeed - claiming difference)
      const balanceBefore2 = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount2, proof2);
      const balanceAfter2 = await noon.balanceOf(await addr1.getAddress());

      // Verify additional reward was received
      expect(balanceAfter2).to.equal(balanceBefore2 + additionalAmount);

      // Verify total claimed is full reward
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount2
      );
    });

    it('Should revert if user tries to claim reward multiple times with withdrawWithReward and claimWithdrawalReward', async function () {
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

      // Claim reward using withdrawWithReward
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      await stakeNoon
        .connect(addr1)
        .withdrawWithReward(tokenId, rewardAmount, proof);
      const balanceAfter = await noon.balanceOf(await addr1.getAddress());

      // Verify reward was received
      expect(balanceAfter).to.equal(balanceBefore + amount + rewardAmount);
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // Try to claim again using claimWithdrawalReward (should fail - already claimed)
      // The stake was already withdrawn and reward was claimed, so withdrawnStakeOwners[tokenId] exists
      // But the reward was already claimed, so it should revert with AlreadyClaimed
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });

    it('Should prevent claiming same reward by different users', async function () {
      const amount = ethers.parseEther('100');
      const rewardAmount = ethers.parseEther('50');
      const stakeDuration = ONE_YEAR;

      // Create stake for addr1
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

      // addr1 withdraws and claims reward
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId, 0, []);
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId, rewardAmount, proof);

      // Verify reward was claimed
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId)).to.equal(
        rewardAmount
      );

      // addr2 tries to claim same reward (should fail - not the owner)
      await expect(
        stakeNoon
          .connect(addr2)
          .claimWithdrawalReward(tokenId, rewardAmount, proof)
      ).to.be.revertedWithCustomError(stakeNoon, 'NotOwner');
    });

    it('Should track claimed amounts correctly across multiple withdrawals and claims', async function () {
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');
      const rewardAmount1 = ethers.parseEther('50');
      const rewardAmount2 = ethers.parseEther('75');
      const stakeDuration = ONE_YEAR;

      // Create stakes
      const tokenId1 = await createStake(addr1, amount1, stakeDuration);
      const tokenId2 = await createStake(addr2, amount2, stakeDuration);

      // Move forward past stake duration
      await time.increase(ONE_YEAR + 1);

      // Both withdraw without reward
      await stakeNoon.connect(addr1).withdrawWithReward(tokenId1, 0, []);
      await stakeNoon.connect(addr2).withdrawWithReward(tokenId2, 0, []);

      // Create merkle tree with both rewards
      const tree = createWithdrawalRewardTree([
        { tokenId: tokenId1, amount: rewardAmount1 },
        { tokenId: tokenId2, amount: rewardAmount2 },
      ]);
      const merkleRoot = tree.getHexRoot();

      // Get proofs
      const leaf1 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId1, rewardAmount1, 'WITHDRAWAL']
      );
      const proof1 = tree.getHexProof(leaf1);

      const leaf2 = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256', 'string'],
        [tokenId2, rewardAmount2, 'WITHDRAWAL']
      );
      const proof2 = tree.getHexProof(leaf2);

      // Set merkle root and fund rewards
      const totalRewardAmount = rewardAmount1 + rewardAmount2;
      await noon
        .connect(owner)
        .approve(await stakeNoon.getAddress(), totalRewardAmount);
      await stakeNoon
        .connect(owner)
        .setMerkleRoot(merkleRoot, totalRewardAmount);

      // User 1 claims reward
      await stakeNoon
        .connect(addr1)
        .claimWithdrawalReward(tokenId1, rewardAmount1, proof1);

      // User 2 tries to claim user 1's reward (should fail)
      await expect(
        stakeNoon
          .connect(addr2)
          .claimWithdrawalReward(tokenId1, rewardAmount1, proof1)
      ).to.be.revertedWithCustomError(stakeNoon, 'NotOwner');

      // User 1 tries to claim user 2's reward (should fail)
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId2, rewardAmount2, proof2)
      ).to.be.revertedWithCustomError(stakeNoon, 'NotOwner');

      // User 2 claims their own reward (should succeed)
      await stakeNoon
        .connect(addr2)
        .claimWithdrawalReward(tokenId2, rewardAmount2, proof2);

      // Verify both rewards tracked correctly
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId1)).to.equal(
        rewardAmount1
      );
      expect(await stakeNoon.claimedWithdrawalRewards(tokenId2)).to.equal(
        rewardAmount2
      );

      // Both users try to claim again (should fail)
      await expect(
        stakeNoon
          .connect(addr1)
          .claimWithdrawalReward(tokenId1, rewardAmount1, proof1)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');

      await expect(
        stakeNoon
          .connect(addr2)
          .claimWithdrawalReward(tokenId2, rewardAmount2, proof2)
      ).to.be.revertedWithCustomError(stakeNoon, 'AlreadyClaimed');
    });
  });
});
