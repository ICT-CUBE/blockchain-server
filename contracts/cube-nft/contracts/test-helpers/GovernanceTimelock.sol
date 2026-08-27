// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Unmodified pass-through constructor so Hardhat produces a queryable artifact for
/// OpenZeppelin's TimelockController — a project-level contract (unlike one merely imported from
/// an npm package) always gets a full artifact/factory. Used by scripts/transfer-governance.ts and
/// test/Governance.spec.ts to deploy the real, un-forked TimelockController implementation as-is.
contract GovernanceTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
