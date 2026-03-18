// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./stakeNOON.sol";

contract stakeNOONRewarder is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    struct RewardDistribution {
        bytes32 merkleRoot;
        uint256 totalReward;
        bool isActive;
    }

    struct RewardClaim {
        uint256 amount;
        bytes32[] proof;
    }

    IERC20 public noon;
    stakeNOON public veNoon;

    RewardDistribution public currentDistribution;
    mapping(address => uint256) public claimedAmounts; // user => total claimed amount

    event RewardDistributionCreated(bytes32 merkleRoot, uint256 totalReward);
    event RewardClaimed(address indexed user, uint256 amount);
    event RewardDistributionEnded();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _noon, address _veNoon, address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();

        noon = IERC20(_noon);
        veNoon = stakeNOON(_veNoon);
    }

    function createRewardDistribution(bytes32 merkleRoot, uint256 totalReward) external onlyOwner {
        require(totalReward > 0, "Reward must be greater than 0");
        require(!currentDistribution.isActive, "Active distribution exists");

        // Transfer NOON tokens to this contract
        noon.transferFrom(msg.sender, address(this), totalReward);

        currentDistribution = RewardDistribution({ merkleRoot: merkleRoot, totalReward: totalReward, isActive: true });

        emit RewardDistributionCreated(merkleRoot, totalReward);
    }

    function claimReward(RewardClaim calldata claim) external nonReentrant {
        require(currentDistribution.isActive, "No active distribution");

        // Verify merkle proof
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, claim.amount));
        require(MerkleProof.verify(claim.proof, currentDistribution.merkleRoot, leaf), "Invalid proof");

        // Check if user has active locks
        require(veNoon.balanceOf(msg.sender) > 0, "No active locks");

        // Calculate claimable amount
        uint256 alreadyClaimed = claimedAmounts[msg.sender];
        require(claim.amount > alreadyClaimed, "No new rewards to claim");
        uint256 claimableAmount = claim.amount - alreadyClaimed;

        // Transfer reward
        noon.transfer(msg.sender, claimableAmount);

        // Update total claimed amount
        claimedAmounts[msg.sender] = claim.amount;

        emit RewardClaimed(msg.sender, claimableAmount);
    }

    function endRewardDistribution() external onlyOwner {
        require(currentDistribution.isActive, "No active distribution");
        currentDistribution.isActive = false;
        emit RewardDistributionEnded();
    }

    function getTotalClaimedAmount(address user) external view returns (uint256) {
        return claimedAmounts[user];
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[50] private __gap;
}
