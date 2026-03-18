import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { Contract, EventLog } from 'ethers';
import { ethers, upgrades } from 'hardhat';
import { NOON } from '../typechain-types/contracts/NOON';
import { StakeNOON } from '../typechain-types/contracts/StakeNOON';
import { StakeNOONRewarder } from '../typechain-types/contracts/StakeNOONRewarder';

interface RewardClaim {
  amount: bigint;
  proof: string[];
}

describe('stakeNOONRewarder', function () {
  let noon: NOON;
  let veNoon: StakeNOON;
  let rewarder: StakeNOONRewarder;
  let owner: HardhatEthersSigner;
  let addr1: HardhatEthersSigner;
  let addr2: HardhatEthersSigner;
  let addrs: HardhatEthersSigner[];
  const initialSupply = ethers.parseEther('1000000'); // 1 million tokens
  const ONE_YEAR = 365 * 24 * 60 * 60; // 1 year in seconds

  // Helper function to create Merkle tree and get proof
  function createMerkleTree(rewards: { account: string; amount: bigint }[]) {
    const leaves = rewards.map((x) =>
      ethers.keccak256(
        ethers.solidityPacked(['address', 'uint256'], [x.account, x.amount])
      )
    );

    // Sort leaves
    leaves.sort();

    // Create Merkle tree
    const tree: string[][] = [];
    tree.push(leaves);

    // Build tree levels
    for (let i = 0; i < Math.log2(leaves.length); i++) {
      const level: string[] = [];
      const prevLevel = tree[i];
      for (let j = 0; j < prevLevel.length; j += 2) {
        if (j + 1 === prevLevel.length) {
          level.push(prevLevel[j]);
        } else {
          level.push(
            ethers.keccak256(ethers.concat([prevLevel[j], prevLevel[j + 1]]))
          );
        }
      }
      tree.push(level);
    }

    return {
      root: tree[tree.length - 1][0],
      getProof: (account: string, amount: bigint): string[] => {
        const leaf = ethers.keccak256(
          ethers.solidityPacked(['address', 'uint256'], [account, amount])
        );
        const proof: string[] = [];
        let index = leaves.indexOf(leaf);
        if (index === -1) throw new Error('Leaf not found in tree');

        for (let i = 0; i < tree.length - 1; i++) {
          const level = tree[i];
          const isRightNode = index % 2 === 1;
          const pairIndex = isRightNode ? index - 1 : index + 1;
          if (pairIndex < level.length) {
            proof.push(level[pairIndex]);
          }
          index = Math.floor(index / 2);
        }
        return proof;
      },
    };
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
    veNoon = (await upgrades.deployProxy(
      stakeNOON,
      [await noon.getAddress(), await owner.getAddress()],
      {
        initializer: 'initialize',
      }
    )) as unknown as StakeNOON;

    // Deploy rewarder using upgradeable pattern
    const stakeNOONRewarder =
      await ethers.getContractFactory('stakeNOONRewarder');
    rewarder = (await upgrades.deployProxy(
      stakeNOONRewarder,
      [
        await noon.getAddress(),
        await veNoon.getAddress(),
        await owner.getAddress(),
      ],
      {
        initializer: 'initialize',
      }
    )) as unknown as StakeNOONRewarder;

    // Setup test data
    const rewards = [
      { account: addr1.address, amount: ethers.parseEther('100') },
      { account: addr2.address, amount: ethers.parseEther('200') },
    ];

    const merkleTree = createMerkleTree(rewards);
    const merkleRoot = merkleTree.root;

    // Setup stakeNOON stakes
    await noon.transfer(addr1.address, ethers.parseEther('1000'));
    await noon.transfer(addr2.address, ethers.parseEther('1000'));

    await noon
      .connect(addr1)
      .approve(await veNoon.getAddress(), ethers.parseEther('1000'));
    await noon
      .connect(addr2)
      .approve(await veNoon.getAddress(), ethers.parseEther('1000'));

    // Create stakes with 1 year duration
    await veNoon.connect(addr1).createStake(ethers.parseEther('100'), ONE_YEAR);
    await veNoon.connect(addr2).createStake(ethers.parseEther('200'), ONE_YEAR);

    // Transfer NOON tokens for owner
    await noon.transfer(owner.address, ethers.parseEther('1000'));
    await noon.approve(await rewarder.getAddress(), ethers.parseEther('1000'));
  });

  describe('Reward Distribution', function () {
    it('Should allow owner to create reward distributions', async function () {
      const rewards = [
        { account: addr1.address, amount: ethers.parseEther('100') },
        { account: addr2.address, amount: ethers.parseEther('200') },
      ];

      const merkleTree = createMerkleTree(rewards);
      const merkleRoot = merkleTree.root;

      await expect(
        rewarder.createRewardDistribution(merkleRoot, ethers.parseEther('300'))
      )
        .to.emit(rewarder, 'RewardDistributionCreated')
        .withArgs(merkleRoot, ethers.parseEther('300'));

      const distribution = await rewarder.currentDistribution();
      expect(distribution.merkleRoot).to.equal(merkleRoot);
      expect(distribution.totalReward).to.equal(ethers.parseEther('300'));
      expect(distribution.isActive).to.be.true;
    });

    it('Should not allow creating new distribution while one is active', async function () {
      const rewards = [
        { account: addr1.address, amount: ethers.parseEther('100') },
        { account: addr2.address, amount: ethers.parseEther('200') },
      ];

      const merkleTree = createMerkleTree(rewards);
      const merkleRoot = merkleTree.root;

      await rewarder.createRewardDistribution(
        merkleRoot,
        ethers.parseEther('300')
      );

      await expect(
        rewarder.createRewardDistribution(merkleRoot, ethers.parseEther('300'))
      ).to.be.revertedWith('Active distribution exists');
    });

    it('Should allow users to claim rewards', async function () {
      const rewards = [
        { account: addr1.address, amount: ethers.parseEther('100') },
        { account: addr2.address, amount: ethers.parseEther('200') },
      ];

      const merkleTree = createMerkleTree(rewards);
      const merkleRoot = merkleTree.root;

      await rewarder.createRewardDistribution(
        merkleRoot,
        ethers.parseEther('300')
      );

      const proof = merkleTree.getProof(
        addr1.address,
        ethers.parseEther('100')
      );

      const claim: RewardClaim = {
        amount: ethers.parseEther('100'),
        proof: proof,
      };

      const initialBalance = await noon.balanceOf(addr1.address);
      await expect(rewarder.connect(addr1).claimReward(claim))
        .to.emit(rewarder, 'RewardClaimed')
        .withArgs(addr1.address, ethers.parseEther('100'));

      const finalBalance = await noon.balanceOf(addr1.address);
      expect(finalBalance - initialBalance).to.equal(ethers.parseEther('100'));

      // Check total claimed amount
      const totalClaimed = await rewarder.getTotalClaimedAmount(addr1.address);
      expect(totalClaimed).to.equal(ethers.parseEther('100'));
    });

    it('Should only allow claiming the difference between total and claimed amount', async function () {
      // Create Merkle tree with the total amount (100)
      const rewards = [
        { account: addr1.address, amount: ethers.parseEther('100') },
        { account: addr2.address, amount: ethers.parseEther('200') },
      ];

      const merkleTree = createMerkleTree(rewards);
      const merkleRoot = merkleTree.root;

      await rewarder.createRewardDistribution(
        merkleRoot,
        ethers.parseEther('300')
      );

      // First claim of 50 tokens
      const claim1: RewardClaim = {
        amount: ethers.parseEther('100'), // Total amount
        proof: merkleTree.getProof(addr1.address, ethers.parseEther('100')),
      };

      const initialBalance = await noon.balanceOf(addr1.address);
      await rewarder.connect(addr1).claimReward(claim1);
      let balanceAfterFirstClaim = await noon.balanceOf(addr1.address);
      expect(balanceAfterFirstClaim - initialBalance).to.equal(
        ethers.parseEther('100')
      );

      // Try to claim again with same amount (should fail)
      await expect(
        rewarder.connect(addr1).claimReward(claim1)
      ).to.be.revertedWith('No new rewards to claim');

      // End current distribution
      await rewarder.endRewardDistribution();

      // Create new distribution with higher amount
      const rewards2 = [
        { account: addr1.address, amount: ethers.parseEther('150') },
        { account: addr2.address, amount: ethers.parseEther('250') },
      ];

      const merkleTree2 = createMerkleTree(rewards2);
      await rewarder.createRewardDistribution(
        merkleTree2.root,
        ethers.parseEther('400')
      );

      // Second claim of 150 tokens (should get 50 more)
      const claim2: RewardClaim = {
        amount: ethers.parseEther('150'),
        proof: merkleTree2.getProof(addr1.address, ethers.parseEther('150')),
      };

      await rewarder.connect(addr1).claimReward(claim2);
      let balanceAfterSecondClaim = await noon.balanceOf(addr1.address);
      expect(balanceAfterSecondClaim - balanceAfterFirstClaim).to.equal(
        ethers.parseEther('50')
      );

      // Try to claim again with same amount (should fail)
      await expect(
        rewarder.connect(addr1).claimReward(claim2)
      ).to.be.revertedWith('No new rewards to claim');
    });

    it('Should allow multiple claims from different distributions', async function () {
      // First distribution
      const rewards1 = [
        { account: addr1.address, amount: ethers.parseEther('100') },
        { account: addr2.address, amount: ethers.parseEther('200') },
      ];

      const merkleTree1 = createMerkleTree(rewards1);
      await rewarder.createRewardDistribution(
        merkleTree1.root,
        ethers.parseEther('300')
      );

      const claim1: RewardClaim = {
        amount: ethers.parseEther('100'),
        proof: merkleTree1.getProof(addr1.address, ethers.parseEther('100')),
      };

      await rewarder.connect(addr1).claimReward(claim1);
      let totalClaimed = await rewarder.getTotalClaimedAmount(addr1.address);
      expect(totalClaimed).to.equal(ethers.parseEther('100'));

      // End first distribution
      await rewarder.endRewardDistribution();

      // Second distribution
      const rewards2 = [
        { account: addr1.address, amount: ethers.parseEther('150') },
        { account: addr2.address, amount: ethers.parseEther('250') },
      ];

      const merkleTree2 = createMerkleTree(rewards2);
      await rewarder.createRewardDistribution(
        merkleTree2.root,
        ethers.parseEther('400')
      );

      const claim2: RewardClaim = {
        amount: ethers.parseEther('150'),
        proof: merkleTree2.getProof(addr1.address, ethers.parseEther('150')),
      };

      await rewarder.connect(addr1).claimReward(claim2);
      totalClaimed = await rewarder.getTotalClaimedAmount(addr1.address);
      expect(totalClaimed).to.equal(ethers.parseEther('150')); // Only the new amount
    });

    it('Should allow owner to end distributions', async function () {
      const rewards = [
        { account: addr1.address, amount: ethers.parseEther('100') },
        { account: addr2.address, amount: ethers.parseEther('200') },
      ];

      const merkleTree = createMerkleTree(rewards);
      const merkleRoot = merkleTree.root;

      await rewarder.createRewardDistribution(
        merkleRoot,
        ethers.parseEther('300')
      );

      await expect(rewarder.endRewardDistribution()).to.emit(
        rewarder,
        'RewardDistributionEnded'
      );

      const distribution = await rewarder.currentDistribution();
      expect(distribution.isActive).to.be.false;
    });
  });
});
