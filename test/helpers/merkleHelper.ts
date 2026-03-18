import { ethers } from 'ethers';

interface RewardData {
  user: string;
  amount: bigint;
}

export function createMerkleTree(rewards: RewardData[]): {
  root: string;
  proofs: { [key: string]: string[] };
} {
  // Sort rewards by address to ensure consistent tree
  const sortedRewards = [...rewards].sort((a, b) =>
    a.user.toLowerCase().localeCompare(b.user.toLowerCase())
  );

  // Create leaves
  const leaves = sortedRewards.map((reward) =>
    ethers.keccak256(
      ethers.solidityPacked(
        ['address', 'uint256'],
        [reward.user, reward.amount]
      )
    )
  );

  // Create tree
  const tree: string[][] = [leaves];
  let currentLevel = leaves;

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 === currentLevel.length) {
        nextLevel.push(currentLevel[i]);
      } else {
        nextLevel.push(
          ethers.keccak256(
            ethers.concat([currentLevel[i], currentLevel[i + 1]])
          )
        );
      }
    }
    tree.push(nextLevel);
    currentLevel = nextLevel;
  }

  // Generate proofs
  const proofs: { [key: string]: string[] } = {};
  sortedRewards.forEach((reward, index) => {
    const proof: string[] = [];
    let currentIndex = index;

    for (let level = 0; level < tree.length - 1; level++) {
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < tree[level].length) {
        proof.push(tree[level][siblingIndex]);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    proofs[reward.user] = proof;
  });

  return {
    root: tree[tree.length - 1][0],
    proofs,
  };
}

export function getProofForUser(
  user: string,
  amount: bigint,
  rewards: RewardData[]
): string[] {
  const { proofs } = createMerkleTree(rewards);
  return proofs[user] || [];
}
