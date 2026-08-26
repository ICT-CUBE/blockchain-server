// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC721URIStorageUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title CubeNFT
/// @notice ERC-721 representation of ARZONE physical CUBEs. tokenId 1..10000 map 1:1 to official
/// CUBE serial numbers. Every transfer of ownership (other than the initial mint) requires both an
/// on-chain `AUTHORIZED_TRANSFER_ROLE` submitter and an EIP-712 `OwnerConsent` signed by the current
/// on-chain owner. Standard ERC-721 transfer entry points are permanently disabled so no marketplace,
/// wallet or administrator can move a CUBE without that owner consent. There is no burn function and
/// no administrator-forced transfer path.
contract CubeNFT is
    Initializable,
    ERC721Upgradeable,
    ERC721URIStorageUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    /// @dev Role allowed to mint new CUBE tokens (ARZONE Mint Signer).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @dev Role allowed to submit an `authorizedTransfer` transaction (ARZONE Relayer).
    /// Holding this role alone never moves a token: the current owner's `OwnerConsent` signature
    /// is independently verified for every call.
    bytes32 public constant AUTHORIZED_TRANSFER_ROLE = keccak256("AUTHORIZED_TRANSFER_ROLE");

    /// @dev Role allowed to trigger emergency `pause()`.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Role allowed to authorize UUPS upgrades. Owned by the environment admin in
    /// local/Amoy and reassigned to the governance Timelock before Mainnet (see TASK-03).
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    uint256 public constant MIN_TOKEN_ID = 1;
    uint256 public constant MAX_TOKEN_ID = 10000;

    /// @dev OwnerConsent.purpose values. Kept as plain uint8 (not a Solidity enum) so the value is
    /// stable across the EIP-712 struct hash regardless of contract/server language or version.
    uint8 public constant PURPOSE_TRANSFER = 1;
    uint8 public constant PURPOSE_WITHDRAWAL = 2;
    uint8 public constant PURPOSE_REENTRY = 3;
    uint8 public constant PURPOSE_EXTERNAL_RESALE = 4;

    /// @dev EIP-712 struct signed by the current NFT owner to authorize a single transfer.
    /// `currentOwner` and `from` are both included and cross-checked on-chain against the actual
    /// `ownerOf(tokenId)` so a stale or mismatched claim is rejected before the signature is even
    /// recovered.
    struct OwnerConsent {
        uint256 tokenId;
        address currentOwner;
        address from;
        address to;
        uint8 purpose;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 private constant OWNER_CONSENT_TYPEHASH = keccak256(
        "OwnerConsent(uint256 tokenId,address currentOwner,address from,address to,uint8 purpose,uint256 nonce,uint256 deadline)"
    );

    /// @dev Next OwnerConsent nonce required for a given tokenId. Incremented on every successful
    /// `authorizedTransfer`, so a signature can never be replayed and an old signature can never be
    /// reordered ahead of a newer one.
    mapping(uint256 tokenId => uint256 nonce) private _consentNonces;

    event CubeMinted(uint256 indexed tokenId, address indexed to, string uri);

    event AuthorizedTransferExecuted(
        uint256 indexed tokenId, address indexed from, address indexed to, uint8 purpose, uint256 nonce
    );

    error ZeroAddress();
    error TokenIdOutOfRange(uint256 tokenId);
    error TokenAlreadyMinted(uint256 tokenId);
    error DirectTransferDisabled();
    error ConsentExpired(uint256 deadline);
    error InvalidConsentPurpose(uint8 purpose);
    error OwnerMismatch(uint256 tokenId, address actualOwner, address claimedOwner);
    error InvalidConsentNonce(uint256 tokenId, uint256 expected, uint256 provided);
    error InvalidOwnerConsentSignature(uint256 tokenId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the proxy. Metadata `baseURI` is intentionally not configurable here:
    /// every token's URI is supplied individually by `mintTo`.
    function initialize(string memory name_, string memory symbol_, address admin, address minter, address relayer, address pauser)
        external
        initializer
    {
        if (admin == address(0) || minter == address(0) || relayer == address(0) || pauser == address(0)) {
            revert ZeroAddress();
        }

        __ERC721_init(name_, symbol_);
        __ERC721URIStorage_init();
        __AccessControl_init();
        __Pausable_init();
        __EIP712_init(name_, "1");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        _grantRole(AUTHORIZED_TRANSFER_ROLE, relayer);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /// @notice Mints `tokenId` directly to `to`. Reverts if `tokenId` is outside `1..10000` or has
    /// already been minted. There is no corresponding burn function anywhere in this contract.
    function mintTo(address to, uint256 tokenId, string calldata tokenUri) external onlyRole(MINTER_ROLE) whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (tokenId < MIN_TOKEN_ID || tokenId > MAX_TOKEN_ID) revert TokenIdOutOfRange(tokenId);
        if (_ownerOf(tokenId) != address(0)) revert TokenAlreadyMinted(tokenId);

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, tokenUri);

        emit CubeMinted(tokenId, to, tokenUri);
    }

    /// @notice Executes a single ARZONE-approved transfer. The caller must hold
    /// `AUTHORIZED_TRANSFER_ROLE`, and `ownerSignature` must be a valid EIP-712 signature (ECDSA or
    /// ERC-1271) from the token's actual current owner over `consent`. Holding
    /// `AUTHORIZED_TRANSFER_ROLE` alone can never move a token without this owner signature.
    function authorizedTransfer(OwnerConsent calldata consent, bytes calldata ownerSignature)
        external
        onlyRole(AUTHORIZED_TRANSFER_ROLE)
        whenNotPaused
    {
        if (block.timestamp > consent.deadline) revert ConsentExpired(consent.deadline);
        if (consent.purpose == 0) revert InvalidConsentPurpose(consent.purpose);
        if (consent.to == address(0)) revert ZeroAddress();

        address actualOwner = ownerOf(consent.tokenId);
        if (actualOwner != consent.currentOwner || actualOwner != consent.from) {
            revert OwnerMismatch(consent.tokenId, actualOwner, consent.currentOwner);
        }

        uint256 expectedNonce = _consentNonces[consent.tokenId];
        if (consent.nonce != expectedNonce) {
            revert InvalidConsentNonce(consent.tokenId, expectedNonce, consent.nonce);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                OWNER_CONSENT_TYPEHASH,
                consent.tokenId,
                consent.currentOwner,
                consent.from,
                consent.to,
                consent.purpose,
                consent.nonce,
                consent.deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        if (!SignatureChecker.isValidSignatureNow(actualOwner, digest, ownerSignature)) {
            revert InvalidOwnerConsentSignature(consent.tokenId);
        }

        _consentNonces[consent.tokenId] = expectedNonce + 1;

        _safeTransfer(actualOwner, consent.to, consent.tokenId, "");

        emit AuthorizedTransferExecuted(consent.tokenId, actualOwner, consent.to, consent.purpose, consent.nonce);
    }

    /// @notice Returns true if `tokenId` has been minted and not (there being no burn function)
    /// subsequently destroyed.
    function exists(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    /// @notice Next `OwnerConsent.nonce` value that will be accepted for `tokenId`.
    function consentNonce(uint256 tokenId) external view returns (uint256) {
        return _consentNonces[tokenId];
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Standard ERC-721 transfer entry points are permanently disabled. All ownership changes other
    // than mint must go through `authorizedTransfer`. Approvals remain fully functional for ERC-721
    // interface compliance and wallet UI compatibility, but can never move a token because every
    // transfer entry point below is rejected regardless of approval state.
    //
    // `safeTransferFrom(address,address,uint256)` is intentionally not listed here: in
    // ERC721Upgradeable it is a non-virtual wrapper that only calls the 4-argument overload below,
    // so disabling that overload disables both call sites.
    // ---------------------------------------------------------------------

    function transferFrom(address, address, uint256) public pure override(ERC721Upgradeable, IERC721) {
        revert DirectTransferDisabled();
    }

    function safeTransferFrom(address, address, uint256, bytes memory)
        public
        pure
        override(ERC721Upgradeable, IERC721)
    {
        revert DirectTransferDisabled();
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721Upgradeable, ERC721URIStorageUpgradeable)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, ERC721URIStorageUpgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /// @dev UUPS upgrade authorization. Local/Amoy grant this to a single dev admin; Mainnet
    /// reassigns it to the Safe-governed Timelock (TASK-03) before go-live.
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
