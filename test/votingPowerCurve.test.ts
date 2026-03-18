import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { EventLog } from 'ethers';
import { ethers, upgrades } from 'hardhat';
import { MerkleTree } from 'merkletreejs';
import { NOON } from '../typechain-types/contracts/NOON';
import { StakeNOON } from '../typechain-types/contracts/StakeNOON';
import { StakeNOONVesting } from '../typechain-types/contracts/StakeNOONVesting';

describe('Voting Power Curve & Vesting Integration', function () {
  let noon: NOON;
  let stakeNoon: StakeNOON;
  let vesting: StakeNOONVesting;
  let owner: HardhatEthersSigner;
  let addr1: HardhatEthersSigner;
  let addr2: HardhatEthersSigner;
  let addrs: HardhatEthersSigner[];

  const ONE_DAY = 24 * 60 * 60;
  const ONE_WEEK = 7 * ONE_DAY;
  const ONE_YEAR = 365 * ONE_DAY;
  const FOUR_YEARS = 4 * ONE_YEAR;
  const SCALE = 10000n;
  const CLIFF_DAYS = 90; // 3-month cliff period in days
  const initialSupply = ethers.parseEther('10000000'); // 10 million

  // VP uses SMOOTH curve (same formula as vesting but no cliffs):
  // ((t/T)^3 * 0.73 + (t/T) * 0.27) over 4 years, continuous
  function calculateCurveRatio(elapsedSeconds: number): bigint {
    if (elapsedSeconds <= 0) return 0n;
    if (elapsedSeconds >= FOUR_YEARS) return SCALE;

    const elapsed = BigInt(Math.floor(elapsedSeconds));
    const total = BigInt(FOUR_YEARS);

    const timeRatio = (elapsed * SCALE) / total;

    const cubicComponent =
      (((timeRatio * timeRatio * timeRatio) / (SCALE * SCALE)) * 73n) / 100n;
    const linearComponent = (timeRatio * 27n) / 100n;

    return cubicComponent + linearComponent;
  }

  // Expected VP for normal stakes: VP = curve(amount) over 4 years (curve gates all VP)
  function expectedNormalVP(amount: bigint, elapsedSeconds: number): bigint {
    const curveRatio = calculateCurveRatio(elapsedSeconds);
    return (amount * curveRatio) / SCALE;
  }

  // Expected VP for VIP: per-schedule curves. Each schedule: curve(vested + totalAmount/9, schedule.startTime, +4y)
  async function expectedVIPVP(
    vesting: StakeNOONVesting,
    tokenId: bigint,
    currentTimestamp: number
  ): Promise<bigint> {
    const schedules = await vesting.getVestingSchedulesForStake(tokenId);
    let totalVP = 0n;
    for (const s of schedules) {
      if (s.stakeId !== tokenId || s.claimedAmount !== 0n) continue;
      const vested = await vesting.calculateVestedAmount(
        s.totalAmount,
        s.startTime,
        s.endTime,
        s.stakeId
      );
      const scheduleBaseVP = vested + s.totalAmount / 9n;
      const elapsed = currentTimestamp - Number(s.startTime);
      const curveRatio = calculateCurveRatio(Math.max(0, elapsed));
      totalVP += (scheduleBaseVP * curveRatio) / SCALE;
    }
    return totalVP;
  }

  // Helper function to create a stake and return tokenId
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

  beforeEach(async function () {
    [owner, addr1, addr2, ...addrs] = await ethers.getSigners();

    // Deploy NOON token
    const NOON = await ethers.getContractFactory('NOON');
    noon = (await upgrades.deployProxy(
      NOON,
      [await owner.getAddress(), initialSupply],
      { initializer: 'initialize' }
    )) as unknown as NOON;
    await noon.setTransferable(true);

    // Deploy stakeNOON
    const stakeNOONFactory = await ethers.getContractFactory('stakeNOON');
    stakeNoon = (await upgrades.deployProxy(
      stakeNOONFactory,
      [await noon.getAddress(), await owner.getAddress()],
      { initializer: 'initialize' }
    )) as unknown as StakeNOON;

    // Deploy stakeNOONVesting
    const stakeNOONVestingFactory =
      await ethers.getContractFactory('stakeNOONVesting');
    vesting = (await upgrades.deployProxy(
      stakeNOONVestingFactory,
      [
        await noon.getAddress(),
        await stakeNoon.getAddress(),
        await owner.getAddress(),
      ],
      { initializer: 'initialize' }
    )) as unknown as StakeNOONVesting;

    // Wire up vesting contract
    await stakeNoon.setVestingContract(await vesting.getAddress());

    // Fund test accounts
    await noon.transfer(await addr1.getAddress(), ethers.parseEther('100000'));
    await noon.transfer(await addr2.getAddress(), ethers.parseEther('100000'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Normal Stake VP Curve Tests
  // ─────────────────────────────────────────────────────────────────────────
  describe('Normal Stake - VP follows vesting curve', function () {
    it('Should give 0 VP at t=0 (curve gates all VP over 4 years)', async function () {
      const amount = ethers.parseEther('1000');
      const tokenId = await createStake(addr1, amount, ONE_YEAR);

      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vp).to.equal(0n); // curve gives 0 at t=0
    });

    it('Should give 100% VP after 4 years', async function () {
      const amount = ethers.parseEther('1000');
      const tokenId = await createStake(addr1, amount, FOUR_YEARS);

      await time.increase(FOUR_YEARS);

      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vp).to.equal(amount);
    });

    it('Should follow the cubic+linear curve over time', async function () {
      const amount = ethers.parseEther('10000');
      const tokenId = await createStake(addr1, amount, FOUR_YEARS);

      // Check at various time points (curve over 4 years)
      const checkpoints = [
        { days: 0, label: 't=0' },
        { days: 90, label: '3 months' },
        { days: 180, label: '6 months' },
        { days: 365, label: '12 months' },
        { days: 730, label: '2 years' },
        { days: 1095, label: '3 years' },
        { days: 1460, label: '4 years' },
      ];

      for (const cp of checkpoints) {
        if (cp.days > 0) {
          const stakeData = await stakeNoon.stakes(tokenId);
          const targetTime = Number(stakeData.stakeDate) + cp.days * ONE_DAY;
          await time.increaseTo(targetTime);
        }

        const vp = await stakeNoon.getTokenVotingPower(tokenId);
        const expected = expectedNormalVP(amount, cp.days * ONE_DAY);

        expect(vp).to.equal(expected, `VP mismatch at ${cp.label}`);
      }
    });

    it('Should cap VP at 100% after 4 years (no further growth)', async function () {
      const amount = ethers.parseEther('1000');
      const tokenId = await createStake(addr1, amount, FOUR_YEARS);

      await time.increase(FOUR_YEARS + 1);

      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vp).to.equal(amount);
    });

    it('Should maintain VP after stake.end (stake.end is offchain only)', async function () {
      const amount = ethers.parseEther('1000');
      await createStake(addr1, amount, ONE_YEAR);

      // Advance past stake.end and past VP curve max (4 years)
      await time.increase(FOUR_YEARS + 1);
      const vpAfterStakeEnd = await stakeNoon.getVotingPower(
        await addr1.getAddress()
      );

      // Advance more - VP should stay maxed (stake.end has no on-chain effect)
      await time.increase(ONE_YEAR);
      const vpLater = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(vpLater).to.equal(vpAfterStakeEnd);
      expect(vpLater).to.equal(amount);
    });

    it('Should correctly aggregate VP for multiple normal stakes', async function () {
      await stakeNoon.updateMaxStakes(5, 1);

      const amount1 = ethers.parseEther('1000');
      const amount2 = ethers.parseEther('2000');

      const tokenId1 = await createStake(addr1, amount1, FOUR_YEARS);

      await time.increase(30 * ONE_DAY);
      const tokenId2 = await createStake(addr1, amount2, FOUR_YEARS);

      const vp1 = await stakeNoon.getTokenVotingPower(tokenId1);
      const vp2 = await stakeNoon.getTokenVotingPower(tokenId2);

      // VP curve is over 4 years; at 30 days we're before first cliff (90 days)
      const expectedVP1 = expectedNormalVP(amount1, 30 * ONE_DAY);
      const expectedVP2 = expectedNormalVP(amount2, 0); // t=0 for new stake

      expect(vp1).to.equal(expectedVP1);
      expect(vp2).to.equal(expectedVP2);

      const totalVP = await stakeNoon.getVotingPower(await addr1.getAddress());
      expect(totalVP).to.equal(vp1 + vp2);
    });

    it('Should set multiplier to 1e18 in stake struct (storage compat)', async function () {
      const amount = ethers.parseEther('100');
      const tokenId = await createStake(addr1, amount, ONE_YEAR);

      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.multiplier).to.equal(ethers.parseEther('1'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VIP Stake VP Curve Tests
  // ─────────────────────────────────────────────────────────────────────────
  describe('VIP Stake - VP uses curve on stake.amount + vesting contract', function () {
    let merkleTree: MerkleTree;
    let proof: string[];
    const claimAmount = ethers.parseEther('100');
    const totalMerkleAmount = ethers.parseEther('10000');

    beforeEach(async function () {
      const vestingAllocation = totalMerkleAmount * 9n;
      await noon.approve(await vesting.getAddress(), vestingAllocation);
      await vesting.addVestingAllocation(vestingAllocation);

      const leaves = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, claimAmount]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, claimAmount]
          )
        ),
      ];
      merkleTree = new MerkleTree(leaves, ethers.keccak256, {
        sortPairs: true,
      });

      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(merkleTree.getHexRoot(), totalMerkleAmount);

      proof = merkleTree.getHexProof(leaves[0]);
    });

    it('Should give 0 VP at t=0 for VIP (curve gates all VP)', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vp).to.equal(0n); // curve gives 0 at t=0
    });

    it('Should grow VIP VP over time (curve + vesting)', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      const vpAtStart = await stakeNoon.getTokenVotingPower(tokenId);

      await time.increase(180 * ONE_DAY);

      const vpAt6Months = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt6Months).to.be.gt(vpAtStart);

      await time.increase(185 * ONE_DAY);

      const vpAt12Months = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt12Months).to.be.gt(vpAt6Months);

      // At 12 months: baseVP = 10x, curve at 25% of 4yr gives partial VP
      expect(vpAt12Months).to.be.gt(vpAt6Months);
    });

    it('Should reach full VP (10x) after 4 years for VIP', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await time.increase(FOUR_YEARS);

      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      // VP curve (4y) + vesting (12mo) both full = 10x
      expect(vp).to.equal(claimAmount * 10n);
    });

    it('Should cap VIP VP at 10x after 4 years', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await time.increase(5 * ONE_YEAR);

      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vp).to.equal(claimAmount * 10n);
    });

    it('VIP VP at intermediate points should match per-schedule curve', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await time.increase(90 * ONE_DAY);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!
        .timestamp;

      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      const expectedVP = await expectedVIPVP(vesting, tokenId, blockTimestamp);
      expect(vp).to.equal(expectedVP);
    });

    it('VIP with 2 schedules: VP = sum of per-schedule curves', async function () {
      const firstAmount = ethers.parseEther('50');
      const leaves1 = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, firstAmount]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, firstAmount]
          )
        ),
      ];
      const tree1 = new MerkleTree(leaves1, ethers.keccak256, {
        sortPairs: true,
      });
      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(tree1.getHexRoot(), totalMerkleAmount);

      const tx1 = await stakeNoon
        .connect(addr1)
        .claimAndStake(firstAmount, 100, tree1.getHexProof(leaves1[0]));
      const receipt1 = await tx1.wait();
      const tokenId = (
        receipt1?.logs.find(
          (l: any) => 'fragment' in l && l.fragment?.name === 'Transfer'
        ) as EventLog
      )?.args[2];

      await time.increase(30 * ONE_DAY);
      const secondTotal = ethers.parseEther('100');
      const leaves2 = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, secondTotal]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, secondTotal]
          )
        ),
      ];
      const tree2 = new MerkleTree(leaves2, ethers.keccak256, {
        sortPairs: true,
      });
      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(tree2.getHexRoot(), totalMerkleAmount);
      await stakeNoon
        .connect(addr1)
        .claimAndStake(secondTotal, 100, tree2.getHexProof(leaves2[0]));

      // At 60 days total: schedule1 elapsed 60d, schedule2 elapsed 30d
      await time.increase(30 * ONE_DAY);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!
        .timestamp;
      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      const expectedVP = await expectedVIPVP(vesting, tokenId, blockTimestamp);
      expect(vp).to.equal(expectedVP);
    });

    it('Should handle multiple monthly claimAndStake calls', async function () {
      const firstAmount = ethers.parseEther('50');

      const leaves1 = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, firstAmount]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, firstAmount]
          )
        ),
      ];
      const tree1 = new MerkleTree(leaves1, ethers.keccak256, {
        sortPairs: true,
      });

      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(tree1.getHexRoot(), totalMerkleAmount);

      const proof1 = tree1.getHexProof(leaves1[0]);

      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(firstAmount, 100, proof1);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      let stake = await stakeNoon.stakes(tokenId);
      expect(stake.amount).to.equal(firstAmount);
      expect(stake.isVip).to.be.true;

      await time.increase(30 * ONE_DAY);

      // Second claim: total 100 (additional 50)
      const secondTotal = ethers.parseEther('100');
      const leaves2 = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, secondTotal]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, secondTotal]
          )
        ),
      ];
      const tree2 = new MerkleTree(leaves2, ethers.keccak256, {
        sortPairs: true,
      });

      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(tree2.getHexRoot(), totalMerkleAmount);

      const proof2 = tree2.getHexProof(leaves2[0]);
      await stakeNoon.connect(addr1).claimAndStake(secondTotal, 100, proof2);

      stake = await stakeNoon.stakes(tokenId);
      expect(stake.amount).to.equal(secondTotal);

      // Advance so per-schedule curves give non-zero VP
      await time.increase(90 * ONE_DAY);
      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vp).to.be.gt(0n);

      // After 4 years, full VP = 10x total staked (curve + vesting both maxed)
      await time.increase(FOUR_YEARS);
      const vpFull = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpFull).to.equal(secondTotal * 10n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VIP Withdrawal Tests
  // ─────────────────────────────────────────────────────────────────────────
  describe('VIP Withdrawal - 10% stays in stake', function () {
    let merkleTree: MerkleTree;
    let proof: string[];
    const claimAmount = ethers.parseEther('100');
    const totalMerkleAmount = ethers.parseEther('10000');

    beforeEach(async function () {
      const vestingAllocation = totalMerkleAmount * 9n;
      await noon.approve(await vesting.getAddress(), vestingAllocation);
      await vesting.addVestingAllocation(vestingAllocation);

      const leaves = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, claimAmount]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, claimAmount]
          )
        ),
      ];
      merkleTree = new MerkleTree(leaves, ethers.keccak256, {
        sortPairs: true,
      });

      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(merkleTree.getHexRoot(), totalMerkleAmount);

      proof = merkleTree.getHexProof(leaves[0]);
    });

    it('Should return stake.amount + fully vested on withdrawVip', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await time.increase(ONE_YEAR);

      const balanceBefore = await noon.balanceOf(await addr1.getAddress());

      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      await time.increase(ONE_WEEK);

      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      // stake.amount (100) + vested (900) = 1000
      expect(balanceAfter - balanceBefore).to.equal(claimAmount * 10n);
    });

    it('Should not have claimImmediateAmount function', async function () {
      expect((stakeNoon as any).claimImmediateAmount).to.be.undefined;
    });

    it('Should not have addImmediateVestingToStake function', async function () {
      expect((stakeNoon as any).addImmediateVestingToStake).to.be.undefined;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // claimVesting - releases 90% from vesting + 10% from stake.amount
  // ─────────────────────────────────────────────────────────────────────────
  describe('claimVesting - releases 10% + 90% together', function () {
    let merkleTree: MerkleTree;
    let proof: string[];
    const claimAmount = ethers.parseEther('100');
    const totalMerkleAmount = ethers.parseEther('10000');

    beforeEach(async function () {
      const vestingAllocation = totalMerkleAmount * 9n;
      await noon.approve(await vesting.getAddress(), vestingAllocation);
      await vesting.addVestingAllocation(vestingAllocation);

      const leaves = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, claimAmount]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, claimAmount]
          )
        ),
      ];
      merkleTree = new MerkleTree(leaves, ethers.keccak256, {
        sortPairs: true,
      });

      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(merkleTree.getHexRoot(), totalMerkleAmount);

      proof = merkleTree.getHexProof(leaves[0]);
    });

    it('claimVesting should transfer 10% from stake + 90% vested from vesting contract', async function () {
      // Claim and stake
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Wait for full vesting
      await time.increase(ONE_YEAR);

      // Start unlock and wait for unlock period
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      await time.increase(ONE_WEEK);

      // Get state before claiming
      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      const stakeBefore = await stakeNoon.stakes(tokenId);
      const totalStakedBefore = await stakeNoon.totalStaked();

      // Claim the single vesting schedule (index 0)
      await stakeNoon.connect(addr1).claimVesting(tokenId, 0);

      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      const stakeAfter = await stakeNoon.stakes(tokenId);
      const totalStakedAfter = await stakeNoon.totalStaked();

      // 10% = claimAmount (100), 90% = claimAmount * 9 (900)
      // Total received = 100 + 900 = 1000
      expect(balanceAfter - balanceBefore).to.equal(claimAmount * 10n);

      // stake.amount should be reduced by the 10% (claimAmount)
      expect(stakeAfter.amount).to.equal(stakeBefore.amount - claimAmount);

      // totalStaked should also be reduced
      expect(totalStakedAfter).to.equal(totalStakedBefore - claimAmount);
    });

    it('claimVesting should reduce stake.amount by exactly totalAmount / VESTING_MULTIPLIER', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await time.increase(ONE_YEAR);

      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      await time.increase(ONE_WEEK);

      // Get schedule to verify the 10% calculation
      const schedules = await vesting.getVestingSchedulesForStake(tokenId);
      const vestingMultiplier = await vesting.VESTING_MULTIPLIER();
      const expected10Percent = schedules[0].totalAmount / vestingMultiplier;

      const stakeBefore = await stakeNoon.stakes(tokenId);

      await stakeNoon.connect(addr1).claimVesting(tokenId, 0);

      const stakeAfter = await stakeNoon.stakes(tokenId);
      expect(stakeBefore.amount - stakeAfter.amount).to.equal(
        expected10Percent
      );
    });

    it('claimVesting with partial vesting should still release full 10%', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Only wait 6 months (partial vesting)
      await time.increase(180 * ONE_DAY);

      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      await time.increase(ONE_WEEK);

      const balanceBefore = await noon.balanceOf(await addr1.getAddress());
      const stakeBefore = await stakeNoon.stakes(tokenId);

      await stakeNoon.connect(addr1).claimVesting(tokenId, 0);

      const balanceAfter = await noon.balanceOf(await addr1.getAddress());
      const stakeAfter = await stakeNoon.stakes(tokenId);

      // 10% is always fully released (claimAmount)
      expect(stakeBefore.amount - stakeAfter.amount).to.equal(claimAmount);

      // Total received = 10% (full) + 90% (partially vested)
      const totalReceived = balanceAfter - balanceBefore;
      expect(totalReceived).to.be.gt(claimAmount); // More than just the 10%
      expect(totalReceived).to.be.lt(claimAmount * 10n); // Less than full 10x
    });

    it('withdrawVip after partial claimVesting should return correct total', async function () {
      // Set up two monthly claims to create two vesting schedules
      const firstAmount = ethers.parseEther('50');

      const leaves1 = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, firstAmount]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, firstAmount]
          )
        ),
      ];
      const tree1 = new MerkleTree(leaves1, ethers.keccak256, {
        sortPairs: true,
      });

      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(tree1.getHexRoot(), totalMerkleAmount);

      const proof1 = tree1.getHexProof(leaves1[0]);
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(firstAmount, 100, proof1);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      // Second claim 30 days later
      await time.increase(30 * ONE_DAY);
      const secondTotal = ethers.parseEther('100');
      const leaves2 = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, secondTotal]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, secondTotal]
          )
        ),
      ];
      const tree2 = new MerkleTree(leaves2, ethers.keccak256, {
        sortPairs: true,
      });

      await noon.approve(await stakeNoon.getAddress(), totalMerkleAmount);
      await stakeNoon.setMerkleRoot(tree2.getHexRoot(), totalMerkleAmount);
      const proof2 = tree2.getHexProof(leaves2[0]);
      await stakeNoon.connect(addr1).claimAndStake(secondTotal, 100, proof2);

      // Now we have 2 schedules, stake.amount = 100 (50 + 50)
      const scheduleCount = await vesting.getVestingSchedulesCount(
        await addr1.getAddress()
      );
      expect(scheduleCount).to.equal(2);

      // Wait for full vesting
      await time.increase(ONE_YEAR);

      const balanceBeforeAll = await noon.balanceOf(await addr1.getAddress());

      // Start unlock
      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      await time.increase(ONE_WEEK);

      // Claim first schedule individually via claimVesting
      // (this claims 10% of schedule[0] from stake + 90% from vesting)
      await stakeNoon.connect(addr1).claimVesting(tokenId, 0);

      // Then withdraw the rest via withdrawVip
      // (this claims remaining vesting schedules + remaining stake.amount)
      await stakeNoon.connect(addr1).withdrawVip(tokenId);

      const balanceAfterAll = await noon.balanceOf(await addr1.getAddress());

      // Total should be 10x of total staked (100 NOON)
      // = 100 * 10 = 1000
      expect(balanceAfterAll - balanceBeforeAll).to.equal(secondTotal * 10n);
    });

    it('claimVesting should revert if unlock not started', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      await tx.wait();
      const receipt = await tx.wait();
      const transferEvent = (receipt as any)?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2] ?? 1n;

      await time.increase(ONE_YEAR);

      // Try to claim without starting unlock
      await expect(
        stakeNoon.connect(addr1).claimVesting(tokenId, 0)
      ).to.be.revertedWithCustomError(stakeNoon, 'UnlockNotStarted');
    });

    it('claimVesting should revert if unlock period not completed', async function () {
      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(claimAmount, 100, proof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      await time.increase(ONE_YEAR);

      await stakeNoon.connect(addr1).startVIPUnstake(tokenId);
      // Don't wait for unlock period

      await expect(
        stakeNoon.connect(addr1).claimVesting(tokenId, 0)
      ).to.be.revertedWithCustomError(stakeNoon, 'UnlockPeriodNotCompleted');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UpdateStake - multiplier set to 1e18
  // ─────────────────────────────────────────────────────────────────────────
  describe('UpdateStake - no multiplier', function () {
    it('Should set multiplier to 1e18 when extending stake', async function () {
      const amount = ethers.parseEther('100');
      const tokenId = await createStake(addr1, amount, ONE_YEAR);

      await time.increase(ONE_YEAR + 1);

      await stakeNoon.connect(addr1).updateStake(tokenId, 0, FOUR_YEARS, 0, []);

      const stake = await stakeNoon.stakes(tokenId);
      expect(stake.multiplier).to.equal(ethers.parseEther('1'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VP Smooth Curve (no cliffs, unlike vesting claims)
  // ─────────────────────────────────────────────────────────────────────────
  describe('VP Smooth Curve - no cliffs, continuous growth', function () {
    it('VP should grow smoothly from t>0', async function () {
      const amount = ethers.parseEther('1000');
      const tokenId = await createStake(addr1, amount, FOUR_YEARS);

      const stakeData = await stakeNoon.stakes(tokenId);
      const vpAtStart = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAtStart).to.equal(0n); // curve gives 0 at t=0

      // Check at day 45 - smooth curve gives non-zero growth
      await time.increaseTo(Number(stakeData.stakeDate) + 45 * ONE_DAY);
      const vpAt45 = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt45).to.be.gt(0n);

      // Check at day 89 - continues growing
      await time.increaseTo(Number(stakeData.stakeDate) + 89 * ONE_DAY);
      const vpAt89 = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt89).to.be.gt(vpAt45);
    });

    it('VP should grow continuously', async function () {
      const amount = ethers.parseEther('1000');
      const tokenId = await createStake(addr1, amount, FOUR_YEARS);

      const stakeData = await stakeNoon.stakes(tokenId);

      await time.increaseTo(Number(stakeData.stakeDate) + 90 * ONE_DAY);
      const vpAt90 = await stakeNoon.getTokenVotingPower(tokenId);

      // Day 120: smooth curve - VP should be higher than day 90
      await time.increaseTo(Number(stakeData.stakeDate) + 120 * ONE_DAY);
      const vpAt120 = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt120).to.be.gt(vpAt90);

      await time.increaseTo(Number(stakeData.stakeDate) + 180 * ONE_DAY);
      const vpAt180 = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt180).to.be.gt(vpAt120);
    });

    it('VP should match smooth curve at checkpoints', async function () {
      const amount = ethers.parseEther('10000');
      const tokenId = await createStake(addr1, amount, FOUR_YEARS);

      const stakeData = await stakeNoon.stakes(tokenId);

      const cliffPoints = [
        { day: 0, label: 't=0' },
        { day: 90, label: '3 months' },
        { day: 180, label: '6 months' },
        { day: 270, label: '9 months' },
        { day: 365, label: '12 months' },
        { day: 540, label: '18 months' },
        { day: 900, label: '~2.5 years' },
        { day: 1440, label: '~4 years' },
      ];

      let prevVP = 0n;
      for (const cp of cliffPoints) {
        if (cp.day > 0) {
          await time.increaseTo(Number(stakeData.stakeDate) + cp.day * ONE_DAY);
        }

        const vp = await stakeNoon.getTokenVotingPower(tokenId);
        const expected = expectedNormalVP(amount, cp.day * ONE_DAY);

        expect(vp).to.equal(expected, `VP mismatch at ${cp.label}`);
        expect(vp).to.be.gte(prevVP, `VP should not decrease at ${cp.label}`);
        prevVP = vp;
      }
    });

    it('VIP: per-schedule curve over 4 years from each schedule.startTime', async function () {
      // Each schedule: curve(vested + totalAmount/9) over 4y from schedule.startTime
      const vipAmount = ethers.parseEther('100');
      const totalMerkle = ethers.parseEther('10000');
      const vestingAlloc = totalMerkle * 9n;
      await noon.approve(await vesting.getAddress(), vestingAlloc);
      await vesting.addVestingAllocation(vestingAlloc);

      const leaves = [
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr1.address, vipAmount]
          )
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [addr2.address, vipAmount]
          )
        ),
      ];
      const tree = new MerkleTree(leaves, ethers.keccak256, {
        sortPairs: true,
      });

      await noon.approve(await stakeNoon.getAddress(), totalMerkle);
      await stakeNoon.setMerkleRoot(tree.getHexRoot(), totalMerkle);
      const vipProof = tree.getHexProof(leaves[0]);

      const tx = await stakeNoon
        .connect(addr1)
        .claimAndStake(vipAmount, 100, vipProof);
      const receipt = await tx.wait();
      const transferEvent = receipt?.logs.find(
        (log: any) => 'fragment' in log && log.fragment?.name === 'Transfer'
      ) as EventLog;
      const tokenId = transferEvent?.args[2];

      const stakeData = await stakeNoon.stakes(tokenId);

      // At day 45: vesting 0 (before cliff), baseVP = 1x, curve gives small VP
      await time.increaseTo(Number(stakeData.stakeDate) + 45 * ONE_DAY);
      const vpAt45 = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt45).to.be.gt(0n);

      // At day 90: vesting first cliff, baseVP jumps, curve applies
      await time.increaseTo(Number(stakeData.stakeDate) + 90 * ONE_DAY);
      const vpAt90 = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt90).to.be.gt(vpAt45);

      // At day 120: vesting flat, curve continues (smooth)
      await time.increaseTo(Number(stakeData.stakeDate) + 120 * ONE_DAY);
      const vpAt120 = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vpAt120).to.be.gt(vpAt90);
    });

    it('CLIFF_PERIOD constant should be 90 days', async function () {
      expect(await vesting.CLIFF_PERIOD()).to.equal(90 * ONE_DAY);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────────────
  describe('Edge Cases', function () {
    it('VP curve should be monotonically increasing', async function () {
      const amount = ethers.parseEther('1000');
      const tokenId = await createStake(addr1, amount, FOUR_YEARS);

      let prevVP = 0n;
      for (let day = 0; day <= 365; day += 30) {
        if (day > 0) {
          const stakeData = await stakeNoon.stakes(tokenId);
          await time.increaseTo(Number(stakeData.stakeDate) + day * ONE_DAY);
        }

        const vp = await stakeNoon.getTokenVotingPower(tokenId);
        expect(vp).to.be.gte(prevVP, `VP should not decrease at day ${day}`);
        prevVP = vp;
      }
    });

    it('VP for tiny amounts should not underflow', async function () {
      const tinyAmount = ethers.parseEther('0.000000001');
      const tokenId = await createStake(addr1, tinyAmount, FOUR_YEARS);

      const vp = await stakeNoon.getTokenVotingPower(tokenId);
      expect(vp).to.be.gte(0n);
    });

    it('Vesting contract curve constants should be consistent', async function () {
      // Verify the constants used by the vesting contract
      expect(await vesting.VESTING_DURATION()).to.equal(ONE_YEAR);
      expect(await vesting.LINEAR_VESTING_PERCENTAGE()).to.equal(27);
      expect(await vesting.CUBIC_VESTING_PERCENTAGE()).to.equal(73);
      expect(await vesting.SCALE()).to.equal(10000);
      expect(await vesting.CLIFF_PERIOD()).to.equal(90 * ONE_DAY);
    });
  });
});
