import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { EventLog } from 'ethers';
import { ethers, upgrades } from 'hardhat';
import keccak256 from 'keccak256';
import { MerkleTree } from 'merkletreejs';
import { NOON } from '../typechain-types/contracts/NOON';
import { StakeNOON } from '../typechain-types/contracts/StakeNOON';
import { StakeNOONVesting } from '../typechain-types/contracts/StakeNOONVesting';

// Helper function to calculate expected vested amount
function calculateExpectedVestedAmount(
  totalAmount: bigint,
  elapsedDays: number,
  totalDays: number = 365
): bigint {
  const SCALE = 10000n;
  const LINEAR_VESTING_PERCENTAGE = 27n;
  const CUBIC_VESTING_PERCENTAGE = 73n;
  const CLIFF_DAYS = 90;

  // Floor elapsed days to nearest cliff period (quarterly: 90-day steps)
  elapsedDays = Math.floor(elapsedDays / CLIFF_DAYS) * CLIFF_DAYS;

  // If floored to 0, nothing is vested yet
  if (elapsedDays === 0) return 0n;

  // If at or past the end, return the full amount
  if (elapsedDays >= totalDays) return totalAmount;

  // Calculate time ratio (0 to 1)
  const timeRatio = (BigInt(elapsedDays) * SCALE) / BigInt(totalDays);

  // Calculate cubic component: (timeRatio)^3 * 0.73
  const cubicComponent =
    (((timeRatio * timeRatio * timeRatio) / (SCALE * SCALE)) *
      CUBIC_VESTING_PERCENTAGE) /
    100n;

  // Calculate linear component: timeRatio * 0.27
  const linearComponent = (timeRatio * LINEAR_VESTING_PERCENTAGE) / 100n;

  // Combine components and scale to total amount
  const combinedRatio = cubicComponent + linearComponent;
  let vestedAmount = (totalAmount * combinedRatio) / SCALE;

  // Ensure we don't exceed the total amount
  if (vestedAmount > totalAmount) {
    vestedAmount = totalAmount;
  }

  return vestedAmount;
}

describe('stakeNOONVesting', function () {
  let noon: NOON;
  let veNoon: StakeNOON;
  let vesting: StakeNOONVesting;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let addrs: HardhatEthersSigner[];
  let INITIAL_SUPPLY = ethers.parseEther('1000000');
  let VESTING_AMOUNT = ethers.parseEther('1000');
  let merkleTree: MerkleTree;
  let addr1: HardhatEthersSigner;
  let addr2: HardhatEthersSigner;
  let ONE_YEAR = 365 * 24 * 60 * 60;

  beforeEach(async function () {
    [owner, user, addr1, addr2, ...addrs] = await ethers.getSigners();

    // Deploy NOON token using upgradeable pattern
    const NOON = await ethers.getContractFactory('NOON');
    noon = (await upgrades.deployProxy(
      NOON,
      [await owner.getAddress(), INITIAL_SUPPLY],
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

    // Deploy stakeNOONVesting using upgradeable pattern
    const stakeNOONVesting =
      await ethers.getContractFactory('stakeNOONVesting');
    vesting = (await upgrades.deployProxy(
      stakeNOONVesting,
      [
        await noon.getAddress(),
        await veNoon.getAddress(),
        await owner.getAddress(),
      ],
      {
        initializer: 'initialize',
      }
    )) as unknown as StakeNOONVesting;

    // Set vesting contract in stakeNOON
    await veNoon.setVestingContract(await vesting.getAddress());

    // Transfer NOON tokens for testing
    await noon.transfer(await user.getAddress(), ethers.parseEther('1000'));
    await noon.transfer(await vesting.getAddress(), VESTING_AMOUNT);

    // Add vesting allocation
    await noon.approve(await vesting.getAddress(), VESTING_AMOUNT);
    await vesting.addVestingAllocation(VESTING_AMOUNT);

    // Setup merkle tree for VIP claims
    const leaves = [
      keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [user.address, ethers.parseEther('100')]
        )
      ),
    ];
    merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const merkleRoot = merkleTree.getHexRoot();

    // Set merkle root and transfer tokens for claims
    await noon.approve(await veNoon.getAddress(), ethers.parseEther('100'));
    await veNoon.setMerkleRoot(merkleRoot, ethers.parseEther('100'));

    // Use 7-day unlock period so startVIPUnstake is required (when 0, direct withdraw/claim is used)
    await veNoon.setVipUnlockingPeriod(7 * 24 * 60 * 60);
  });

  describe('Deployment', function () {
    it('Should set the correct owner', async function () {
      expect(await vesting.owner()).to.equal(await owner.getAddress());
    });

    it('Should set the correct NOON token address', async function () {
      expect(await vesting.noon()).to.equal(await noon.getAddress());
    });

    it('Should set the correct stakeNOON address', async function () {
      expect(await vesting.stakeNOON()).to.equal(await veNoon.getAddress());
    });
  });

  describe('Vesting Schedule', function () {
    it('Should create a vesting schedule for VIP stake', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const schedules = await vesting.getVestingSchedulesForStake(stakeIds[0]);

      expect(schedules.length).to.equal(1);
      expect(schedules[0].totalAmount).to.equal(ethers.parseEther('900')); // 9x the staked amount

      //get vested amount
      const vestedAmount = await vesting.getVestedAmountForStake(stakeIds[0]);
      expect(vestedAmount).to.equal(0);
      const calculatedVestedAmount = await vesting.calculateVestedAmount(
        schedules[0].totalAmount,
        schedules[0].startTime,
        //current time
        await time.latest(),
        stakeIds[0]
      );
      expect(calculatedVestedAmount).to.equal(0);

      //balance before claim
      const balanceBefore = await noon.balanceOf(user.address);
      //start vip unlock
      await veNoon.connect(user).startVIPUnstake(stakeIds[0]);
      //advance time by 7 days
      await time.increase(7 * 24 * 60 * 60);
      //claim vesting
      await veNoon.connect(user).claimVesting(stakeIds[0], 0n);

      //check balance (claimVesting transfers the 10% immediate portion even when 90% vesting = 0)
      const balanceAfter = await noon.balanceOf(user.address);
      expect(balanceAfter).to.equal(balanceBefore + ethers.parseEther('100'));
    });

    it('Should calculate vested amount correctly after 6 months', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);

      // Advance time by 6 months
      await time.increase(180 * 24 * 60 * 60);

      const vestedAmount = await vesting.getVestedAmountForStake(stakeIds[0]);
      expect(vestedAmount).to.be.gt(0);
      expect(vestedAmount).to.be.lt(ethers.parseEther('900')); // Should be less than total
    });

    it('Should calculate vested amount correctly after 12 months', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);

      // Advance time by 12 months
      await time.increase(365 * 24 * 60 * 60);

      const vestedAmount = await vesting.getVestedAmountForStake(stakeIds[0]);
      expect(vestedAmount).to.equal(ethers.parseEther('900')); // Should be fully vested
    });

    it('Should allow claiming vested tokens', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);

      // Advance time by 6 months
      await time.increase(180 * 24 * 60 * 60);

      // Get initial balance
      const initialBalance = await noon.balanceOf(user.address);

      // Start VIP unlock
      await veNoon.connect(user).startVIPUnstake(stakeIds[0]);
      // Advance time by 7 days
      await time.increase(7 * 24 * 60 * 60);

      // Claim vested tokens
      await veNoon.connect(user).claimVesting(stakeIds[0], 0n);

      // Check new balance
      const newBalance = await noon.balanceOf(user.address);
      expect(newBalance).to.be.gt(initialBalance);
    });

    it('Should calculate correct vesting amounts at monthly intervals', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      // Get initial vesting amount (should be 0)
      let vestedAmount = await vesting.getVestedAmountForStake(stakeId);
      console.log('Initial vested amount:', ethers.formatEther(vestedAmount));
      expect(vestedAmount).to.equal(0);

      // Test vesting amounts at monthly intervals
      const monthlyIntervals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const totalVestingAmount = ethers.parseEther('900'); // 9x the staked amount
      console.log(
        'Total vesting amount:',
        ethers.formatEther(totalVestingAmount)
      );

      for (let i = 0; i < monthlyIntervals.length; i++) {
        // Move time forward by the specified number of months
        if (i === 0) {
          await time.increase(monthlyIntervals[i] * 30 * 24 * 60 * 60);
        } else {
          await time.increase(
            (monthlyIntervals[i] - monthlyIntervals[i - 1]) * 30 * 24 * 60 * 60
          );
        }

        // Get vested amount
        vestedAmount = await vesting.getVestedAmountForStake(stakeId);
        console.log(
          `Vested amount after ${monthlyIntervals[i]} months:`,
          ethers.formatEther(vestedAmount)
        );

        // Get the vesting schedule
        const schedules = await vesting.getVestingSchedulesForStake(stakeId);
        for (const schedule of schedules) {
          console.log('Schedule details:', {
            totalAmount: ethers.formatEther(schedule.totalAmount),
            startTime: new Date(
              Number(schedule.startTime) * 1000
            ).toISOString(),
            endTime: new Date(Number(schedule.endTime) * 1000).toISOString(),
            claimedAmount: ethers.formatEther(schedule.claimedAmount),
          });

          // Calculate vested amount directly
          const calculatedAmount = await vesting.calculateVestedAmount(
            schedule.totalAmount,
            schedule.startTime,
            schedule.endTime,
            stakeId
          );
          console.log(
            'Calculated vested amount:',
            ethers.formatEther(calculatedAmount)
          );
        }
      }

      // Verify final amount after 12 months
      await time.increase(365 * 24 * 60 * 60);
      vestedAmount = await vesting.getVestedAmountForStake(stakeId);
      console.log('Final vested amount:', ethers.formatEther(vestedAmount));
      expect(vestedAmount).to.equal(totalVestingAmount);
    });

    it('Should maintain correct vesting schedule after unlock', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      // Move time forward by 6 months
      await time.increase(180 * 24 * 60 * 60);

      // Get vested amount before unlock
      const vestedAmountBeforeUnlock =
        await vesting.getVestedAmountForStake(stakeId);
      console.log(
        'Vested amount before unlock:',
        ethers.formatEther(vestedAmountBeforeUnlock)
      );

      // Get vesting schedule before unlock
      const schedulesBefore =
        await vesting.getVestingSchedulesForStake(stakeId);
      console.log('Vesting schedule before unlock:', {
        totalAmount: ethers.formatEther(schedulesBefore[0].totalAmount),
        startTime: new Date(
          Number(schedulesBefore[0].startTime) * 1000
        ).toISOString(),
        endTime: new Date(
          Number(schedulesBefore[0].endTime) * 1000
        ).toISOString(),
        claimedAmount: ethers.formatEther(schedulesBefore[0].claimedAmount),
      });

      // Start unlock process
      await veNoon.connect(user).startVIPUnstake(stakeId);

      // Move time forward by 7 days
      await time.increase(7 * 24 * 60 * 60);

      // Get vested amount after unlock
      const vestedAmountAfterUnlock =
        await vesting.getVestedAmountForStake(stakeId);
      console.log(
        'Vested amount after unlock:',
        ethers.formatEther(vestedAmountAfterUnlock)
      );

      // Get vesting schedule after unlock
      const schedulesAfter = await vesting.getVestingSchedulesForStake(stakeId);
      console.log('Vesting schedule after unlock:', {
        totalAmount: ethers.formatEther(schedulesAfter[0].totalAmount),
        startTime: new Date(
          Number(schedulesAfter[0].startTime) * 1000
        ).toISOString(),
        endTime: new Date(
          Number(schedulesAfter[0].endTime) * 1000
        ).toISOString(),
        claimedAmount: ethers.formatEther(schedulesAfter[0].claimedAmount),
      });

      // Verify that vesting amount doesn't change during unlock period
      expect(vestedAmountAfterUnlock).to.equal(vestedAmountBeforeUnlock);
      const balanceBefore = await noon.balanceOf(user.address);
      // Withdraw tokens
      await veNoon.connect(user).withdrawVip(stakeId);

      // Verify final balance includes both staked and vested amounts
      const finalBalance = await noon.balanceOf(user.address);
      const stakedAmount = ethers.parseEther('100');
      const expectedBalance = stakedAmount + vestedAmountAfterUnlock;
      console.log('Final balance:', ethers.formatEther(finalBalance));
      console.log('Expected balance:', ethers.formatEther(expectedBalance));
      expect(finalBalance).to.equal(balanceBefore + expectedBalance);
    });
  });

  describe('Vesting Schedule Creation', function () {
    it('Should revert if amount is zero', async function () {
      await expect(
        vesting.connect(owner).createVestingSchedule(user.address, 0, 1)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });

    it('Should revert if stake does not belong to user', async function () {
      await expect(
        vesting
          .connect(owner)
          .createVestingSchedule(user.address, ethers.parseEther('100'), 1)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });

    it('Should revert if insufficient vesting allocation', async function () {
      await expect(
        vesting
          .connect(owner)
          .createVestingSchedule(user.address, ethers.parseEther('2000'), 1)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });
  });

  describe('Vesting Claims', function () {
    it('Should revert if schedule ID is invalid', async function () {
      await expect(
        vesting.connect(owner).claimVesting(user.address, 0)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });

    it('Should revert if schedule is not active', async function () {
      // This is an access control test: only stakeNOON can call this
      await expect(
        vesting
          .connect(owner)
          .createVestingSchedule(user.address, ethers.parseEther('100'), 1)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });

    it('Should revert if no tokens to claim', async function () {
      // This is an access control test: only stakeNOON can call this
      await expect(
        vesting
          .connect(owner)
          .createVestingSchedule(user.address, ethers.parseEther('100'), 1)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });
  });

  describe('Access Control', function () {
    it('Should revert if non-owner tries to add vesting allocation', async function () {
      await expect(
        vesting.connect(user).addVestingAllocation(ethers.parseEther('100'))
      ).to.be.revertedWithCustomError(vesting, 'OwnableUnauthorizedAccount');
    });

    it('Should revert if non-stakeNOON contract tries to create vesting schedule', async function () {
      await expect(
        vesting
          .connect(user)
          .createVestingSchedule(user.address, ethers.parseEther('100'), 1)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });
  });

  describe('Vesting Schedule Edge Cases', function () {
    it('Should handle VIP unlock affecting vesting', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      // Advance time by 3 months
      await time.increase(90 * 24 * 60 * 60);

      // Start VIP unlock
      await veNoon.connect(user).startVIPUnstake(stakeId);

      // Get vested amount after unlock start
      const vestedAmount = await vesting.getVestedAmountForStake(stakeId);
      expect(vestedAmount).to.be.gt(0);
      expect(vestedAmount).to.be.lt(ethers.parseEther('900')); // Should be less than total
    });

    it('Should allow claimVesting after original period even if owner extended vipUnlockingPeriod', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      const sevenDays = 7 * 24 * 60 * 60;
      const thirtyDays = 30 * 24 * 60 * 60;

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      await veNoon.connect(user).startVIPUnstake(stakeId);

      // Owner extends the period after user started unlock
      await veNoon.setVipUnlockingPeriod(thirtyDays);

      // After 7 days (original period), user should still be able to claimVesting
      await time.increase(sevenDays);
      const balanceBefore = await noon.balanceOf(user.address);
      await veNoon.connect(user).claimVesting(stakeId, 0n);
      const balanceAfter = await noon.balanceOf(user.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  describe('Vesting Schedule Access Control', function () {
    it('Should only allow owner to add vesting allocation', async function () {
      const amount = ethers.parseEther('100');

      // Deploy vesting contract
      const Vesting = await ethers.getContractFactory('stakeNOONVesting');
      const vesting = (await upgrades.deployProxy(
        Vesting,
        [
          await noon.getAddress(),
          await veNoon.getAddress(),
          await owner.getAddress(),
        ],
        {
          initializer: 'initialize',
        }
      )) as unknown as StakeNOONVesting;

      await noon.approve(await vesting.getAddress(), amount);
      await expect(
        vesting.connect(addr1).addVestingAllocation(amount)
      ).to.be.revertedWithCustomError(vesting, 'OwnableUnauthorizedAccount');
    });

    it('Should only allow stakeNOON to create vesting schedules', async function () {
      const amount = ethers.parseEther('100');

      // Deploy vesting contract
      const Vesting = await ethers.getContractFactory('stakeNOONVesting');
      const vesting = (await upgrades.deployProxy(
        Vesting,
        [
          await noon.getAddress(),
          await veNoon.getAddress(),
          await owner.getAddress(),
        ],
        {
          initializer: 'initialize',
        }
      )) as unknown as StakeNOONVesting;

      await noon.approve(await vesting.getAddress(), amount);
      await vesting.addVestingAllocation(amount);

      await expect(
        vesting.connect(addr1).createVestingSchedule(addr1.address, amount, 1)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });

    it('Should only allow stakeNOON to claim vesting', async function () {
      const amount = ethers.parseEther('100');

      // Deploy vesting contract
      const Vesting = await ethers.getContractFactory('stakeNOONVesting');
      const vesting = (await upgrades.deployProxy(
        Vesting,
        [
          await noon.getAddress(),
          await veNoon.getAddress(),
          await owner.getAddress(),
        ],
        {
          initializer: 'initialize',
        }
      )) as unknown as StakeNOONVesting;

      await noon.approve(await vesting.getAddress(), amount);
      await vesting.addVestingAllocation(amount);

      await expect(
        vesting.connect(addr1).claimVesting(addr1.address, 0)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });
  });

  describe('Vesting Schedule Management', function () {
    it('Should handle vesting schedule for non-existent stake', async function () {
      const amount = ethers.parseEther('100');

      // Deploy vesting contract
      const Vesting = await ethers.getContractFactory('stakeNOONVesting');
      const vesting = (await upgrades.deployProxy(
        Vesting,
        [
          await noon.getAddress(),
          await veNoon.getAddress(),
          await owner.getAddress(),
        ],
        {
          initializer: 'initialize',
        }
      )) as unknown as StakeNOONVesting;

      await noon.approve(await vesting.getAddress(), amount);
      await vesting.addVestingAllocation(amount);

      // Try to create vesting schedule for non-existent stake
      await expect(
        vesting.createVestingSchedule(addr1.address, amount, 999)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });

    it('Should handle vesting schedule for wrong beneficiary', async function () {
      const amount = ethers.parseEther('100');

      // Transfer tokens to addr1
      await noon.transfer(addr1.address, amount);

      // Deploy vesting contract
      const Vesting = await ethers.getContractFactory('stakeNOONVesting');
      const vesting = (await upgrades.deployProxy(
        Vesting,
        [
          await noon.getAddress(),
          await veNoon.getAddress(),
          await owner.getAddress(),
        ],
        {
          initializer: 'initialize',
        }
      )) as unknown as StakeNOONVesting;

      await noon.approve(await vesting.getAddress(), amount);
      await vesting.addVestingAllocation(amount);

      // Create stake
      await noon.connect(addr1).approve(await veNoon.getAddress(), amount);
      const tx = await veNoon.connect(addr1).createStake(amount, ONE_YEAR);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Try to create vesting schedule for wrong beneficiary
      await expect(
        vesting.createVestingSchedule(addr2.address, amount, tokenId)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });
  });
  describe('Vesting Allocation', function () {
    it('Should allow owner to add vesting allocation', async function () {
      const amount = ethers.parseEther('1000');
      await noon.approve(await vesting.getAddress(), amount);
      await vesting.addVestingAllocation(amount);
      expect(await vesting.totalVestingAllocation()).to.equal(amount * 2n); // Double because of beforeEach
    });

    it('Should not allow non-owner to add vesting allocation', async function () {
      const amount = ethers.parseEther('1000');
      await noon.approve(await vesting.getAddress(), amount);
      await expect(
        vesting.connect(addr1).addVestingAllocation(amount)
      ).to.be.revertedWithCustomError(vesting, 'OwnableUnauthorizedAccount');
    });
  });

  describe('Vesting Schedule', function () {
    it('Should not allow non-stakeNOON to create vesting schedule', async function () {
      const amount = ethers.parseEther('1000');
      await noon.approve(await vesting.getAddress(), amount);
      await vesting.addVestingAllocation(amount);

      await expect(
        vesting.connect(addr1).createVestingSchedule(addr1.address, amount, 1)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });

    it('Should not allow non-stakeNOON to claim vesting', async function () {
      const amount = ethers.parseEther('1000');
      await noon.approve(await vesting.getAddress(), amount);
      await vesting.addVestingAllocation(amount);

      await expect(
        vesting.connect(addr1).claimVesting(addr1.address, 0)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });
  });

  describe('Vesting Schedule Creation', function () {
    it('Should not allow creating vesting schedule for non-existent stake', async function () {
      const amount = ethers.parseEther('1000');
      await noon.approve(await vesting.getAddress(), amount);
      await vesting.addVestingAllocation(amount);

      // Try to create vesting schedule for non-existent stake
      await expect(
        vesting.createVestingSchedule(addr1.address, amount, 999)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });

    it('Should not allow creating vesting schedule for wrong beneficiary', async function () {
      const amount = ethers.parseEther('1000');

      // Transfer tokens to addr1 first
      await noon.transfer(await addr1.getAddress(), amount);

      // Approve and create stake
      await noon.connect(addr1).approve(await veNoon.getAddress(), amount);
      const tx = await veNoon.connect(addr1).createStake(amount, ONE_YEAR);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => log.fragment && log.fragment.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Try to create vesting schedule for wrong beneficiary
      await expect(
        vesting.createVestingSchedule(addr2.address, amount, tokenId)
      ).to.be.revertedWithCustomError(vesting, 'OnlyVeNoon');
    });
  });

  describe('ClaimVestingFromUser', function () {
    it('Should delete schedule from array after claiming', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      // Create stake and vesting schedule
      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      // Advance time by 6 months to have some vested amount
      await time.increase(180 * 24 * 60 * 60);

      // Get initial schedule count
      const initialScheduleCount = await vesting.getVestingSchedulesCount(
        user.address
      );
      expect(initialScheduleCount).to.equal(1);

      // Get initial stake vesting schedules
      const initialStakeSchedules =
        await vesting.getVestingSchedulesForStake(stakeId);
      expect(initialStakeSchedules.length).to.equal(1);

      // Get initial balance
      const initialBalance = await noon.balanceOf(user.address);
      //start vip unlock
      await veNoon.connect(user).startVIPUnstake(stakeId);
      await time.increase(7 * 24 * 60 * 60);

      // Claim vesting — this will also finalize the stake (burn NFT) since stake.amount goes to 0
      await veNoon.connect(user).claimVesting(stakeId, 0n);

      // Verify balance increased
      const finalBalance = await noon.balanceOf(user.address);
      expect(finalBalance).to.be.gt(initialBalance);

      // Verify the NFT was burned (stake.amount reached 0 → _finalizeVipStake burned it)
      await expect(veNoon.ownerOf(stakeId)).to.be.revertedWithCustomError(
        veNoon,
        'ERC721NonexistentToken'
      );

      // Verify user has no more VIP stakes
      const userStakeIds = await veNoon.getUserStakeIds(user.address);
      expect(userStakeIds.length).to.equal(0);
    });

    it('Should handle multiple schedules correctly', async function () {
      // Add more vesting allocation first
      const additionalAllocation = ethers.parseEther('1000');
      await noon.approve(await vesting.getAddress(), additionalAllocation);
      await vesting.addVestingAllocation(additionalAllocation);

      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      // Create first stake and vesting schedule
      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      let stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId1 = stakeIds[0];

      // Create merkle root for second stake
      const leaves = [
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('200')]
          )
        ),
      ];
      merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
      const merkleRoot = merkleTree.getHexRoot();
      await noon.approve(await veNoon.getAddress(), ethers.parseEther('200'));
      await veNoon.setMerkleRoot(merkleRoot, ethers.parseEther('200'));

      const proof2 = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('200')]
          )
        )
      );

      // Create second stake and vesting schedule
      await veNoon
        .connect(user)
        .claimAndStake(ethers.parseEther('200'), 100, proof2);
      stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId2 = stakeIds[0];

      // Advance time by 6 months
      await time.increase(180 * 24 * 60 * 60);
      // Get initial schedule count
      const initialScheduleCount = await vesting.getVestingSchedulesCount(
        user.address
      );
      expect(initialScheduleCount).to.equal(2);

      // Get initial balance
      const initialBalance = await noon.balanceOf(user.address);
      const initialStake1Schedules =
        await vesting.getVestingSchedulesForStake(stakeId1);
      expect(initialStake1Schedules.length).to.equal(2);
      const expectedVestedAmount = calculateExpectedVestedAmount(
        ethers.parseEther('1800'),
        180
      );
      expect(expectedVestedAmount).to.equal(
        await vesting.getVestedAmountForStake(stakeId1)
      );
      //start vip unlock
      await veNoon.connect(user).startVIPUnstake(stakeId1);
      await time.increase(7 * 24 * 60 * 60);
      // Claim first schedule
      await veNoon.connect(user).claimVesting(stakeId1, 0n);
      /*Check indices and stake before and after claim*/
      let stake1Schedules = await vesting.getVestingSchedulesForStake(stakeId1);
      expect(stake1Schedules.length).to.equal(1);

      // Verify balance increased
      const midBalance = await noon.balanceOf(user.address);
      expect(midBalance).to.be.gt(initialBalance);

      // Wait 1 month
      await time.increase(30 * 24 * 60 * 60);

      // Verify stake schedules
      stake1Schedules = await vesting.getVestingSchedulesForStake(stakeId1);
      expect(stake1Schedules.length).to.equal(1);

      // Get vested amount
      const vestedAmount = await vesting.getVestedAmountForStake(stakeId1);
      expect(vestedAmount).to.be.gt(0);
      const expectedVestedAmount1 = calculateExpectedVestedAmount(
        ethers.parseEther('900'),
        180
      );
      //only 1 vesting left
      expect(vestedAmount).to.equal(expectedVestedAmount1);
      // Get claimable amount
      const claimableAmount = await vesting.getClaimableAmount(user.address, 0);
      expect(claimableAmount).to.be.gt(0);
      expect(claimableAmount).to.be.equal(vestedAmount);

      // Claim second schedule — this will also finalize the stake (burn NFT) since stake.amount goes to 0
      await veNoon.connect(user).claimVesting(stakeId2, 0n);

      // Verify final balance (includes 90% vesting + 10% immediate transfer from stake)
      const finalBalance = await noon.balanceOf(user.address);
      expect(finalBalance).to.equal(
        midBalance + vestedAmount + ethers.parseEther('100')
      );

      // Verify the NFT was burned (stake.amount reached 0 → _finalizeVipStake burned it)
      await expect(veNoon.ownerOf(stakeId2)).to.be.revertedWithCustomError(
        veNoon,
        'ERC721NonexistentToken'
      );

      // Verify user has no more VIP stakes
      const userStakeIds = await veNoon.getUserStakeIds(user.address);
      expect(userStakeIds.length).to.equal(0);
    });

    it('Should revert if schedule ID is invalid', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      //start vip unlock
      await veNoon.connect(user).startVIPUnstake(stakeId);
      await time.increase(7 * 24 * 60 * 60);

      await expect(
        veNoon.connect(user).claimVesting(stakeId, 999n)
      ).to.be.revertedWithCustomError(veNoon, 'NoVestingSchedulesForStake');
    });

    it('Should revert if schedule is not active', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      // Create stake and vesting schedule
      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      // Advance time by 1 year to fully vest
      await time.increase(365 * 24 * 60 * 60);

      // Get initial balance
      const initialBalance = await noon.balanceOf(user.address);
      //start vip unlock
      await veNoon.connect(user).startVIPUnstake(stakeId);
      await time.increase(7 * 24 * 60 * 60);

      // Claim first time — this will also finalize the stake (burn NFT) since stake.amount goes to 0
      await veNoon.connect(user).claimVesting(stakeId, 0n);

      // Verify balance increased
      const finalBalance = await noon.balanceOf(user.address);
      expect(finalBalance).to.be.gt(initialBalance);

      // Verify the NFT was burned (stake.amount reached 0 → _finalizeVipStake)
      await expect(veNoon.ownerOf(stakeId)).to.be.revertedWithCustomError(
        veNoon,
        'ERC721NonexistentToken'
      );

      // Try to claim again — should revert since NFT is burned
      await expect(
        veNoon.connect(user).claimVesting(stakeId, 0n)
      ).to.be.revertedWithCustomError(veNoon, 'ERC721NonexistentToken');

      // Try to withdrawVip — should also revert since NFT is burned
      await expect(
        veNoon.connect(user).withdrawVip(stakeId)
      ).to.be.revertedWithCustomError(veNoon, 'ERC721NonexistentToken');
    });

    it('Should emit VestingClaimed event with correct parameters', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      // Create stake and vesting schedule
      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      // Advance time by 6 months
      await time.increase(180 * 24 * 60 * 60);

      //start vip unlock
      await veNoon.connect(user).startVIPUnstake(stakeId);
      await time.increase(7 * 24 * 60 * 60);
      // Get claimable amount
      const claimableAmount = await vesting.getClaimableAmount(user.address, 0);

      // Claim and verify event
      await expect(veNoon.connect(user).claimVesting(stakeId, 0n))
        .to.emit(vesting, 'VestingClaimed')
        .withArgs(user.address, 0, claimableAmount);
    });
  });

  describe('Vesting Schedule', function () {
    it('Should calculate vested amount correctly at monthly intervals', async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [user.address, ethers.parseEther('100')]
          )
        )
      );

      await veNoon.connect(user).claimAndStake(ethers.parseEther('100'), 100, proof);
      const stakeIds = await veNoon.getUserStakeIds(user.address);
      const stakeId = stakeIds[0];

      const totalAmount = ethers.parseEther('900'); // 9x the staked amount
      const monthlyIntervals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

      for (let i = 0; i < monthlyIntervals.length; i++) {
        // Move time forward by the specified number of months
        if (i === 0) {
          await time.increase(monthlyIntervals[i] * 30 * 24 * 60 * 60);
        } else {
          await time.increase(
            (monthlyIntervals[i] - monthlyIntervals[i - 1]) * 30 * 24 * 60 * 60
          );
        }

        // Get actual vested amount from contract
        const actualVestedAmount =
          await vesting.getVestedAmountForStake(stakeId);

        // Calculate expected vested amount
        const expectedVestedAmount = calculateExpectedVestedAmount(
          totalAmount,
          monthlyIntervals[i] * 30 // Convert months to days
        );

        // Log the comparison
        console.log(`Month ${monthlyIntervals[i]}:`);
        console.log(
          'Actual vested amount:',
          ethers.formatEther(actualVestedAmount)
        );
        console.log(
          'Expected vested amount:',
          ethers.formatEther(expectedVestedAmount)
        );

        // Allow for small rounding differences (within 0.1%)
        const difference =
          actualVestedAmount > expectedVestedAmount
            ? actualVestedAmount - expectedVestedAmount
            : expectedVestedAmount - actualVestedAmount;
        const maxAllowedDifference = totalAmount / 1000n; // 0.1% of total amount

        expect(difference).to.be.lte(maxAllowedDifference);
      }

      // Verify final amount after 12 months
      await time.increase(365 * 24 * 60 * 60);
      const finalVestedAmount = await vesting.getVestedAmountForStake(stakeId);
      expect(finalVestedAmount).to.equal(totalAmount);
    });
  });
});
