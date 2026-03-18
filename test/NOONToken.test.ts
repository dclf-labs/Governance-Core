import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { NOON } from '../typechain-types/contracts/NOON';

describe('NOON', function () {
  let noon: NOON;
  let owner: HardhatEthersSigner;
  let addr1: HardhatEthersSigner;
  let addr2: HardhatEthersSigner;
  const initialSupply = ethers.parseEther('1000000'); // 1 million tokens

  beforeEach(async function () {
    [owner, addr1, addr2] = await ethers.getSigners();

    // Deploy NOON token using upgradeable pattern
    const NOON = await ethers.getContractFactory('NOON');
    noon = (await upgrades.deployProxy(
      NOON,
      [await owner.getAddress(), initialSupply],
      {
        initializer: 'initialize',
      }
    )) as unknown as NOON;
  });

  // tests
  it('the token name should be correct', async () => {
    expect(await noon.name()).to.equal('NOON');
  });

  it('the token symbol should be correct', async () => {
    expect(await noon.symbol()).to.equal('NOON');
  });

  it('the token decimal should be correct', async () => {
    expect(await noon.decimals()).to.equal(18n);
  });

  it('the token supply should be correct', async () => {
    expect(await noon.totalSupply()).to.equal(initialSupply);
  });

  it('initial owner should have all tokens', async () => {
    expect(await noon.balanceOf(await owner.getAddress())).to.equal(
      initialSupply
    );
  });

  it('reverts when transferring tokens to the zero address', async () => {
    await expect(
      noon.transfer(ethers.ZeroAddress, 1n)
    ).to.be.revertedWithCustomError(noon, 'ERC20InvalidReceiver');
  });

  it('emits a Transfer event on successful transfers', async () => {
    const from = owner;
    const to = addr1;
    const value = ethers.parseEther('10');

    await expect(noon.connect(from).transfer(to.address, value))
      .to.emit(noon, 'Transfer')
      .withArgs(from.address, to.address, value);
  });

  it('token balance successfully changed after transfer', async () => {
    const from = owner;
    const to = addr1;
    const value = ethers.parseEther('10');

    await expect(
      noon.connect(from).transfer(to.address, value)
    ).to.changeTokenBalances(noon, [from, to], [-value, value]);
  });

  it('should revert when transferring more tokens than balance', async () => {
    const from = addr1;
    const to = addr2;
    const value = ethers.parseEther('10');
    await noon.setTransferable(true);

    await expect(
      noon.connect(from).transfer(to.address, value)
    ).to.be.revertedWithCustomError(noon, 'ERC20InsufficientBalance');
  });

  it('should revert when approving spending for zero address', async () => {
    const amount = ethers.parseEther('10');
    await expect(
      noon.approve(ethers.ZeroAddress, amount)
    ).to.be.revertedWithCustomError(noon, 'ERC20InvalidSpender');
  });

  it('should revert when transferring from an account with insufficient allowance', async () => {
    const from = owner;
    const to = addr1;
    const spender = addr2;
    const value = ethers.parseEther('10');

    await expect(
      noon.connect(spender).transferFrom(from.address, to.address, value)
    ).to.be.revertedWithCustomError(noon, 'ERC20InsufficientAllowance');
  });

  // Blacklisting tests
  it('should allow owner to blacklist an account', async () => {
    const accountToBlacklist = addr1;

    await expect(
      noon.connect(owner).blacklistAccount(accountToBlacklist.address)
    )
      .to.emit(noon, 'Blacklisted')
      .withArgs(accountToBlacklist.address);

    expect(await noon.blacklist(accountToBlacklist.address)).to.be.true;
  });

  it('should revert when non-owner tries to blacklist an account', async () => {
    const nonOwner = addr1;
    const accountToBlacklist = addr2;

    await expect(
      noon.connect(nonOwner).blacklistAccount(accountToBlacklist.address)
    ).to.be.revertedWithCustomError(noon, 'OwnableUnauthorizedAccount');
  });

  it('should prevent blacklisted accounts from transferring tokens', async () => {
    const blacklistedAccount = addr1;
    const recipient = addr2;
    const amount = ethers.parseEther('10');

    await noon.connect(owner).transfer(blacklistedAccount.address, amount);
    await noon.connect(owner).blacklistAccount(blacklistedAccount.address);

    await expect(
      noon.connect(blacklistedAccount).transfer(recipient.address, amount)
    ).to.be.revertedWithCustomError(noon, 'BlacklistedAddress');
  });

  it('should prevent transfers to blacklisted accounts', async () => {
    const sender = owner;
    const blacklistedRecipient = addr1;
    const amount = ethers.parseEther('10');

    await noon.connect(owner).blacklistAccount(blacklistedRecipient.address);

    await expect(
      noon.connect(sender).transfer(blacklistedRecipient.address, amount)
    ).to.be.revertedWithCustomError(noon, 'BlacklistedAddress');
  });

  it('should allow owner to unblacklist an account', async () => {
    const accountToUnblacklist = addr1;

    await noon.connect(owner).blacklistAccount(accountToUnblacklist.address);
    expect(await noon.blacklist(accountToUnblacklist.address)).to.be.true;

    await expect(
      noon.connect(owner).unblacklistAccount(accountToUnblacklist.address)
    )
      .to.emit(noon, 'Unblacklisted')
      .withArgs(accountToUnblacklist.address);

    expect(await noon.blacklist(accountToUnblacklist.address)).to.be.false;
  });

  it('should allow transfers after unblacklisting', async () => {
    const sender = owner;
    const recipient = addr1;
    const amount = ethers.parseEther('10');

    await noon.connect(owner).blacklistAccount(sender.address);

    await expect(
      noon.connect(sender).transfer(recipient.address, amount)
    ).to.be.revertedWithCustomError(noon, 'BlacklistedAddress');

    await noon.connect(owner).unblacklistAccount(sender.address);

    await expect(
      noon.connect(sender).transfer(recipient.address, amount)
    ).to.changeTokenBalances(noon, [sender, recipient], [-amount, amount]);
  });

  describe('ERC20Permit', () => {
    const amount = ethers.parseEther('100');
    let owner: HardhatEthersSigner;
    let spender: HardhatEthersSigner;
    let deadline: bigint;

    beforeEach(async () => {
      [owner, spender] = await ethers.getSigners();
      deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
    });

    it('should allow permit', async () => {
      const nonce = await noon.nonces(owner.address);
      const name = await noon.name();
      const version = '1';
      const chainId = await ethers.provider
        .getNetwork()
        .then((network) => network.chainId);

      const domain = {
        name,
        version,
        chainId,
        verifyingContract: await noon.getAddress(),
      };

      const types = {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      };

      const values = {
        owner: owner.address,
        spender: spender.address,
        value: amount,
        nonce,
        deadline: deadline * 10n,
      };

      const signature = await owner.signTypedData(domain, types, values);
      const { v, r, s } = ethers.Signature.from(signature);

      // Ensure the deadline is in the future
      const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
      expect(deadline).to.be.greaterThan(currentTimestamp);

      await expect(
        noon.permit(
          owner.address,
          spender.address,
          amount,
          deadline * 10n,
          v,
          r,
          s
        )
      )
        .to.emit(noon, 'Approval')
        .withArgs(owner.address, spender.address, amount);

      expect(await noon.allowance(owner.address, spender.address)).to.equal(
        amount
      );
    });

    it('should revert on expired permit', async () => {
      const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
      const nonce = await noon.nonces(owner.address);
      const name = await noon.name();
      const version = '1';
      const chainId = await ethers.provider
        .getNetwork()
        .then((network) => network.chainId);

      const domain = {
        name,
        version,
        chainId,
        verifyingContract: await noon.getAddress(),
      };

      const types = {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      };

      const values = {
        owner: owner.address,
        spender: spender.address,
        value: amount,
        nonce,
        deadline: expiredDeadline,
      };

      const signature = await owner.signTypedData(domain, types, values);
      const { v, r, s } = ethers.Signature.from(signature);

      await expect(
        noon.permit(
          owner.address,
          spender.address,
          amount,
          expiredDeadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(noon, 'ERC2612ExpiredSignature');
    });

    it('should revert on invalid signature', async () => {
      const nonce = await noon.nonces(owner.address);
      const name = await noon.name();
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600 * 1000); // 1000 hour from now
      const version = '1';
      const chainId = await ethers.provider
        .getNetwork()
        .then((network) => network.chainId);

      const domain = {
        name,
        version,
        chainId,
        verifyingContract: await noon.getAddress(),
      };

      const types = {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      };

      const values = {
        owner: owner.address,
        spender: spender.address,
        value: amount,
        nonce,
        deadline,
      };

      const signature = await spender.signTypedData(domain, types, values); // Signed by spender instead of owner
      const { v, r, s } = ethers.Signature.from(signature);

      await expect(
        noon.permit(owner.address, spender.address, amount, deadline, v, r, s)
      ).to.be.revertedWithCustomError(noon, 'ERC2612InvalidSigner');
    });
  });

  it('Should have 18 decimals', async function () {
    const decimals = await noon.decimals();
    expect(decimals).to.equal(18);
  });

  // Add upgrade tests
  describe('Upgrades', () => {
    it('should be upgradeable', async () => {
      const NOON = await ethers.getContractFactory('NOON');
      const upgraded = await upgrades.upgradeProxy(
        await noon.getAddress(),
        NOON
      );
      expect(await upgraded.getAddress()).to.equal(await noon.getAddress());
    });

    it('should maintain state after upgrade', async () => {
      // Set some state
      await noon.connect(owner).blacklistAccount(addr1.address);
      await noon.connect(owner).whitelistAccount(addr2.address);
      await noon.connect(owner).setTransferable(true);

      // Upgrade the contract
      const NOON = await ethers.getContractFactory('NOON');
      const upgraded = await upgrades.upgradeProxy(
        await noon.getAddress(),
        NOON
      );

      // Verify state is maintained
      expect(await upgraded.blacklist(addr1.address)).to.be.true;
      expect(await upgraded.whitelist(addr2.address)).to.be.true;
      expect(await upgraded.isTransferable()).to.be.true;
    });
  });

  describe('Transfer Restrictions', () => {
    const transferAmount = ethers.parseEther('10');

    beforeEach(async () => {
      // Transfer some tokens to addr1 for testing
      await noon.connect(owner).transfer(addr1.address, transferAmount);
    });

    describe('When token is not transferable', () => {
      beforeEach(async () => {
        await noon.connect(owner).setTransferable(false);
      });

      it('should allow transfer when sender is whitelisted', async () => {
        await expect(
          noon.connect(owner).transfer(addr1.address, transferAmount)
        ).to.changeTokenBalances(
          noon,
          [owner, addr1],
          [-transferAmount, transferAmount]
        );
      });

      it('should allow transfer when receiver is whitelisted', async () => {
        await noon.connect(owner).whitelistAccount(addr2.address);
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.changeTokenBalances(
          noon,
          [addr1, addr2],
          [-transferAmount, transferAmount]
        );
      });

      it('should allow transfer when both sender and receiver are whitelisted', async () => {
        await noon.connect(owner).whitelistAccount(addr1.address);
        await noon.connect(owner).whitelistAccount(addr2.address);
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.changeTokenBalances(
          noon,
          [addr1, addr2],
          [-transferAmount, transferAmount]
        );
      });

      it('should revert transfer when neither sender nor receiver is whitelisted', async () => {
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.be.revertedWithCustomError(noon, 'TransferNotAllowed');
      });
    });

    describe('When token is transferable', () => {
      beforeEach(async () => {
        await noon.connect(owner).setTransferable(true);
      });

      it('should allow transfer between non-whitelisted addresses', async () => {
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.changeTokenBalances(
          noon,
          [addr1, addr2],
          [-transferAmount, transferAmount]
        );
      });

      it('should allow transfer when sender is whitelisted', async () => {
        await expect(
          noon.connect(owner).transfer(addr1.address, transferAmount)
        ).to.changeTokenBalances(
          noon,
          [owner, addr1],
          [-transferAmount, transferAmount]
        );
      });

      it('should allow transfer when receiver is whitelisted', async () => {
        await noon.connect(owner).whitelistAccount(addr2.address);
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.changeTokenBalances(
          noon,
          [addr1, addr2],
          [-transferAmount, transferAmount]
        );
      });

      it('should allow transfer when both sender and receiver are whitelisted', async () => {
        await noon.connect(owner).whitelistAccount(addr1.address);
        await noon.connect(owner).whitelistAccount(addr2.address);
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.changeTokenBalances(
          noon,
          [addr1, addr2],
          [-transferAmount, transferAmount]
        );
      });
    });

    describe('Transfer restrictions with blacklist', () => {
      it('should revert transfer when sender is blacklisted', async () => {
        await noon.connect(owner).blacklistAccount(addr1.address);
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.be.revertedWithCustomError(noon, 'BlacklistedAddress');
      });

      it('should revert transfer when receiver is blacklisted', async () => {
        await noon.connect(owner).blacklistAccount(addr2.address);
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.be.revertedWithCustomError(noon, 'BlacklistedAddress');
      });

      it('should revert transfer when both sender and receiver are blacklisted', async () => {
        await noon.connect(owner).blacklistAccount(addr1.address);
        await noon.connect(owner).blacklistAccount(addr2.address);
        await expect(
          noon.connect(addr1).transfer(addr2.address, transferAmount)
        ).to.be.revertedWithCustomError(noon, 'BlacklistedAddress');
      });
    });
  });
});
