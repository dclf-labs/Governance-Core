// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./interfaces/INOON.sol";

/**
 * @title NOON
 * @dev Implementation of the NOON token with transfer restrictions and blacklist/whitelist functionality.
 * This contract is upgradeable and uses OpenZeppelin's upgradeable contracts.
 */
contract NOON is Initializable, ERC20Upgradeable, ERC20PermitUpgradeable, OwnableUpgradeable, INOON {
    /// @dev Mapping of blacklisted addresses
    mapping(address => bool) public blacklist;
    /// @dev Mapping of whitelisted addresses
    mapping(address => bool) public whitelist;
    /// @dev Flag indicating if transfers are allowed for non-whitelisted addresses
    bool public isTransferable;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initializes the contract with initial owner and supply
     * @param initialOwner The address that will receive the initial supply
     * @param initialSupply The amount of tokens to mint initially
     */
    function initialize(address initialOwner, uint256 initialSupply) public initializer {
        __ERC20_init("NOON", "NOON");
        __ERC20Permit_init("NOON");
        __Ownable_init(initialOwner);

        if (initialOwner == address(0)) revert ZeroAddress();
        whitelist[initialOwner] = true;
        _mint(initialOwner, initialSupply);
        isTransferable = false; // Default to non-transferable
    }

    /**
     * @dev Blacklists an account, preventing it from sending or receiving tokens
     * @param account The address to blacklist
     */
    function blacklistAccount(address account) external onlyOwner {
        blacklist[account] = true;
        emit Blacklisted(account);
    }

    /**
     * @dev Removes an account from the blacklist
     * @param account The address to remove from blacklist
     */
    function unblacklistAccount(address account) external onlyOwner {
        blacklist[account] = false;
        emit Unblacklisted(account);
    }

    /**
     * @dev Whitelists an account, allowing it to transfer tokens even when transfers are disabled
     * @param account The address to whitelist
     */
    function whitelistAccount(address account) external onlyOwner {
        if (whitelist[account]) revert AlreadyWhitelisted();
        whitelist[account] = true;
        emit Whitelisted(account);
    }

    /**
     * @dev Removes an account from the whitelist
     * @param account The address to remove from whitelist
     */
    function unwhitelistAccount(address account) external onlyOwner {
        if (!whitelist[account]) revert NotWhitelisted();
        whitelist[account] = false;
        emit Unwhitelisted(account);
    }

    /**
     * @dev Sets whether transfers are allowed for non-whitelisted addresses
     * @param _isTransferable True to enable transfers, false to disable
     */
    function setTransferable(bool _isTransferable) external onlyOwner {
        isTransferable = _isTransferable;
        emit TransferabilityUpdated(_isTransferable);
    }

    /**
     * @dev Internal function to handle token transfers with restrictions
     * @param from The address sending the tokens
     * @param to The address receiving the tokens
     * @param value The amount of tokens to transfer
     */
    function _update(address from, address to, uint256 value) internal virtual override(ERC20Upgradeable) {
        if (blacklist[from] || blacklist[to]) revert BlacklistedAddress();

        // Allow transfers if:
        // 1. Token is transferable, or
        // 2. From or to address is whitelisted
        if (!isTransferable && !whitelist[from] && !whitelist[to]) {
            revert TransferNotAllowed();
        }

        super._update(from, to, value);
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[50] private __gap;
}
