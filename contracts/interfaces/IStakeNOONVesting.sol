// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IStakeNOONVesting {
    struct VestingSchedule {
        uint256 totalAmount;
        uint256 startTime;
        uint256 endTime;
        uint256 claimedAmount;
        uint256 stakeId;
    }

    // Custom errors
    error AmountMustBeGreaterThanZero();
    error TokenTransferFailed();
    error InsufficientVestingAllocation();
    error StakeDoesNotBelongToUser();
    error OnlyVeNoon();
    error NoTokensToClaim();
    error InvalidScheduleId();
    error ScheduleNotActive();

    event VestingClaimed(address indexed user, uint256 scheduleId, uint256 amount);
    event VestingAllocationAdded(uint256 amount);
    event VestingScheduleCreated(
        address indexed user,
        uint256 scheduleId,
        uint256 amount,
        uint256 startTime,
        uint256 endTime,
        uint256 stakeId
    );

    function createVestingSchedule(address user, uint256 amount, uint256 stakeId) external;

    function getVestedAmountForStake(uint256 stakeId) external view returns (uint256);

    function getVestingSchedulesForStake(uint256 stakeId) external view returns (VestingSchedule[] memory);

    function calculateVestedAmount(
        uint256 totalAmount,
        uint256 startTime,
        uint256 endTime,
        uint256 stakeId
    ) external view returns (uint256);

    /// @dev Same curve as vesting (t/T)^3*0.73 + (t/T)*0.27 but without cliffs. Used for VP over 4 years.
    function calculateCurveSmooth(
        uint256 totalAmount,
        uint256 startTime,
        uint256 endTime
    ) external view returns (uint256);

    function claimVesting(address user, uint256 scheduleId) external;

    function getVestingSchedulesCount(address user) external view returns (uint256);

    function getClaimableAmount(address user, uint256 scheduleId) external view returns (uint256);

    function VESTING_MULTIPLIER() external view returns (uint256);

    function CLIFF_PERIOD() external view returns (uint256);
}
