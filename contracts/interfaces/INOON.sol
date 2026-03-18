// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface INOON {
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
    event Whitelisted(address indexed account);
    event Unwhitelisted(address indexed account);
    event TransferabilityUpdated(bool isTransferable);

    error ZeroAddress();
    error BlacklistedAddress();
    error TransferNotAllowed();
    error AlreadyWhitelisted();
    error NotWhitelisted();
}
