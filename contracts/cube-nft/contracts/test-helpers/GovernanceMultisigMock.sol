// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal N-of-M threshold call-forwarder used only in tests to exercise
/// TimelockController's PROPOSER_ROLE/EXECUTOR_ROLE as a real Safe-like multisig would call them
/// (a single contract address requiring multiple owner approvals per call), rather than as
/// independent EOAs that would each satisfy the role check alone. This is not an audited multisig
/// and is not part of the deployed system — real Mainnet governance holds these roles with an
/// actually-deployed Safe (see docs `수행 계획서 - 세부 구현 계획.md` TASK-03 §14).
contract GovernanceMultisigMock {
    address[] private _owners;
    uint256 public immutable threshold;

    mapping(bytes32 callHash => mapping(address owner => bool approved)) public approvals;
    mapping(bytes32 callHash => uint256 count) public approvalCount;

    error NotOwner(address account);
    error AlreadyApproved(bytes32 callHash, address account);
    error ThresholdNotMet(bytes32 callHash, uint256 approved, uint256 required);
    error CallFailed(address target, bytes data);

    constructor(address[] memory owners_, uint256 threshold_) {
        _owners = owners_;
        threshold = threshold_;
    }

    modifier onlyOwner() {
        if (!isOwner(msg.sender)) revert NotOwner(msg.sender);
        _;
    }

    function isOwner(address account) public view returns (bool) {
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] == account) return true;
        }
        return false;
    }

    function callHashOf(address target, bytes calldata data, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, data, salt));
    }

    function approve(bytes32 callHash) external onlyOwner {
        if (approvals[callHash][msg.sender]) revert AlreadyApproved(callHash, msg.sender);
        approvals[callHash][msg.sender] = true;
        approvalCount[callHash] += 1;
    }

    /// @notice Forwards `data` to `target` once at least `threshold` owners have approved
    /// `callHashOf(target, data, salt)`. Any owner may trigger execution after threshold is met.
    function execute(address target, bytes calldata data, bytes32 salt) external onlyOwner returns (bytes memory) {
        bytes32 callHash = callHashOf(target, data, salt);
        uint256 approved = approvalCount[callHash];
        if (approved < threshold) revert ThresholdNotMet(callHash, approved, threshold);

        (bool success, bytes memory result) = target.call(data);
        if (!success) revert CallFailed(target, data);
        return result;
    }
}
