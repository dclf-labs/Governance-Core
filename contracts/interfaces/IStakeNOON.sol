// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IStakeNOON is IERC165, IERC721 {
    struct Stake {
        uint256 amount;
        uint256 end;
        uint256 multiplier;
        bool isVip;
        uint256 stakeDate;
        bool isPermanent;
    }

    // Custom errors
    error AmountMustBeGreaterThanZero();
    error StakeDurationTooShort();
    error StakeDurationTooLong();
    error MaxNormalStakesReached();
    error NotOwner();
    error StakeNotFound();
    error StakeNotExpired();
    error StakeNotWithdrawn();
    error NewStakeMustBeLonger();
    error TransfersNotEnabled();
    error VIPTokensNotTransferable();
    error InvalidVestingContractAddress();
    error VestingContractNotSet();
    error NoVestingSchedulesForStake();
    error ScheduleNotForStake();
    error InvalidProof();
    error InsufficientClaimableAmount();
    error AlreadyClaimed();
    error NoVIPStakeFound();
    error NotVIPStake();
    error MaxVIPStakesMustBeGreaterThanZero();
    error MaxNormalStakesMustBeGreaterThanZero();
    error NotPermanentStake();
    error TokenTransferFailed();
    error UnlockAlreadyStarted();
    error UnlockNotStarted();
    error UnlockPeriodNotCompleted();
    error UnlockNotRequired();
    error VIPStakeInWithdrawingPeriod();
    error CannotIncreaseVIPStakeAmount();
    error InvalidPercentage();

    event VIPUnlockStarted(uint256 indexed tokenId, uint256 startTime);
    event VipUnlockingPeriodUpdated(uint256 newPeriod);
    event MaxStakesUpdated(uint256 maxNormalStakes, uint256 maxVipStakes);
    event StakeCreated(address indexed user, uint256 tokenId, uint256 amount, uint256 stakeEnd, uint256 multiplier);
    event StakeExtended(uint256 indexed tokenId, uint256 newStakeEnd, uint256 newMultiplier);
    event StakeWithdrawn(uint256 indexed tokenId, uint256 amount);
    event Restaked(uint256 indexed tokenId, uint256 newStakeEnd, uint256 newMultiplier);
    event TransferabilityUpdated(bool isTransferable);
    event PermanentStatusUpdated(uint256 indexed tokenId, bool isPermanent);
    event PermanentStakeRestaked(uint256 indexed tokenId, uint256 newStakeEnd);
    event PermanentStakeUnlocked(uint256 indexed tokenId);
    event ClaimAndStaked(address indexed user, uint256 tokenId, uint256 amount, uint256 stakeEnd, uint256 multiplier);
    event MerkleRootUpdated(bytes32 merkleRoot, uint256 totalAmount);
    event StakeAmountIncreased(uint256 indexed tokenId, uint256 additionalAmount, uint256 newTotalAmount);
    event VestingClaimed(address indexed user, uint256 indexed tokenId, uint256 amount);
    event VIPClaimed(address indexed user, uint256 amount);
    event WithdrawalRewardClaimed(uint256 indexed tokenId, uint256 rewardAmount);
    event VipStakePercentageUpdated(uint256 percentage);
    event VipDirectTransfer(address indexed user, uint256 amount);
    event VestingClaimFailed(uint256 indexed tokenId);
    event VestingContractUpdated(address indexed newVestingContract);

    function createStake(uint256 amount, uint256 stakeDuration) external returns (uint256);

    function withdrawWithReward(uint256 tokenId, uint256 rewardAmount, bytes32[] calldata proof) external;

    function getVotingPower(address user) external view returns (uint256);

    function getTokenVotingPower(uint256 tokenId) external view returns (uint256);

    function calculateMultiplier(uint256 stakeDuration) external pure returns (uint256);

    function getUserStakeIds(address user) external view returns (uint256[] memory);

    function setTransferable(bool _isTransferable) external;

    function updateStake(
        uint256 tokenId,
        uint256 additionalAmount,
        uint256 newStakeDuration,
        uint256 rewardAmount,
        bytes32[] calldata proof
    ) external;

    function getVIPUnlockStartTime(uint256 tokenId) external view returns (uint256);

    function claimWithdrawalReward(uint256 tokenId, uint256 rewardAmount, bytes32[] calldata proof) external;
}
