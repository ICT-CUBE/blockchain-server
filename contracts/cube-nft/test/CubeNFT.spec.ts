import { expect } from "chai";
import hre, { network } from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

import {
  CUBE_NFT_EIP712_DOMAIN_VERSION,
  CUBE_NFT_MAX_TOKEN_ID,
  CUBE_NFT_MIN_TOKEN_ID,
  OWNER_CONSENT_EIP712_TYPES,
  OWNER_CONSENT_PURPOSE,
} from "../src/types.js";

const CONTRACT_NAME = "ARZONE CUBE NFT";
const CONTRACT_SYMBOL = "CUBE";
const SAMPLE_URI = "ipfs://bafybeigsample/1.json";
const ONE_HOUR = 60n * 60n;

describe("CubeNFT", function () {
  let ethers: Awaited<ReturnType<typeof network.create>>["ethers"];
  let upgradesApi: Awaited<ReturnType<typeof upgrades>>;

  before(async () => {
    const connection = await network.create();
    ({ ethers } = connection);
    upgradesApi = await upgrades(hre, connection);
  });

  async function deployCube() {
    const [admin, minter, relayer, pauser, ownerA, ownerB, stranger] = await ethers.getSigners();

    const CubeNFTFactory = await ethers.getContractFactory("CubeNFT");
    const cube = await upgradesApi.deployProxy(
      CubeNFTFactory,
      [CONTRACT_NAME, CONTRACT_SYMBOL, admin.address, minter.address, relayer.address, pauser.address],
      { kind: "uups" },
    );
    await cube.waitForDeployment();

    return { cube, admin, minter, relayer, pauser, ownerA, ownerB, stranger };
  }

  async function eip712Domain(cubeAddress: string) {
    const net = await ethers.provider.getNetwork();
    return {
      name: CONTRACT_NAME,
      version: CUBE_NFT_EIP712_DOMAIN_VERSION,
      chainId: net.chainId,
      verifyingContract: cubeAddress,
    };
  }

  async function signOwnerConsent(
    signer: { signTypedData: (domain: unknown, types: unknown, value: unknown) => Promise<string> },
    cubeAddress: string,
    consent: {
      tokenId: bigint;
      currentOwner: string;
      from: string;
      to: string;
      purpose: number;
      nonce: bigint;
      deadline: bigint;
    },
  ) {
    const domain = await eip712Domain(cubeAddress);
    return signer.signTypedData(domain, OWNER_CONSENT_EIP712_TYPES, consent);
  }

  describe("initialization", function () {
    it("rejects a zero address role", async () => {
      const [admin, minter, relayer, pauser] = await ethers.getSigners();
      const CubeNFTFactory = await ethers.getContractFactory("CubeNFT");
      await expect(
        upgradesApi.deployProxy(
          CubeNFTFactory,
          [CONTRACT_NAME, CONTRACT_SYMBOL, admin.address, minter.address, relayer.address, ethers.ZeroAddress],
          { kind: "uups" },
        ),
      ).to.be.revert(ethers);
    });

    it("cannot be initialized twice", async () => {
      const { cube, admin, minter, relayer, pauser } = await deployCube();
      await expect(
        cube.initialize(CONTRACT_NAME, CONTRACT_SYMBOL, admin.address, minter.address, relayer.address, pauser.address),
      ).to.be.revert(ethers);
    });

    it("exposes the fixed tokenId range", async () => {
      const { cube } = await deployCube();
      expect(await cube.MIN_TOKEN_ID()).to.equal(CUBE_NFT_MIN_TOKEN_ID);
      expect(await cube.MAX_TOKEN_ID()).to.equal(CUBE_NFT_MAX_TOKEN_ID);
    });
  });

  describe("mintTo", function () {
    it("mints tokenId 1 directly to the recipient", async () => {
      const { cube, minter, ownerA } = await deployCube();

      await expect(cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI))
        .to.emit(cube, "CubeMinted")
        .withArgs(1n, ownerA.address, SAMPLE_URI);

      expect(await cube.ownerOf(1)).to.equal(ownerA.address);
      expect(await cube.exists(1)).to.equal(true);
      expect(await cube.tokenURI(1)).to.equal(SAMPLE_URI);
    });

    it("mints tokenId 10000 (upper boundary)", async () => {
      const { cube, minter, ownerA } = await deployCube();
      await cube.connect(minter).mintTo(ownerA.address, 10000, SAMPLE_URI);
      expect(await cube.ownerOf(10000)).to.equal(ownerA.address);
    });

    it("rejects tokenId 0 (below range)", async () => {
      const { cube, minter, ownerA } = await deployCube();
      await expect(cube.connect(minter).mintTo(ownerA.address, 0, SAMPLE_URI))
        .to.be.revertedWithCustomError(cube, "TokenIdOutOfRange")
        .withArgs(0);
    });

    it("rejects tokenId 10001 (above range)", async () => {
      const { cube, minter, ownerA } = await deployCube();
      await expect(cube.connect(minter).mintTo(ownerA.address, 10001, SAMPLE_URI))
        .to.be.revertedWithCustomError(cube, "TokenIdOutOfRange")
        .withArgs(10001);
    });

    it("rejects a duplicate mint of an already-minted tokenId", async () => {
      const { cube, minter, ownerA, ownerB } = await deployCube();
      await cube.connect(minter).mintTo(ownerA.address, 42, SAMPLE_URI);
      await expect(cube.connect(minter).mintTo(ownerB.address, 42, SAMPLE_URI))
        .to.be.revertedWithCustomError(cube, "TokenAlreadyMinted")
        .withArgs(42);
    });

    it("rejects minting to the zero address", async () => {
      const { cube, minter } = await deployCube();
      await expect(cube.connect(minter).mintTo(ethers.ZeroAddress, 1, SAMPLE_URI)).to.be.revertedWithCustomError(
        cube,
        "ZeroAddress",
      );
    });

    it("rejects mint from a non-minter caller", async () => {
      const { cube, stranger, ownerA } = await deployCube();
      await expect(cube.connect(stranger).mintTo(ownerA.address, 1, SAMPLE_URI)).to.be.revert(ethers);
    });

    it("rejects mint while paused", async () => {
      const { cube, minter, pauser, ownerA } = await deployCube();
      await cube.connect(pauser).pause();
      await expect(cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI)).to.be.revert(ethers);
    });
  });

  describe("standard ERC-721 transfer entry points are disabled", function () {
    it("rejects transferFrom even after approve", async () => {
      const { cube, minter, ownerA, ownerB } = await deployCube();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      await cube.connect(ownerA).approve(ownerB.address, 1);
      expect(await cube.getApproved(1)).to.equal(ownerB.address);

      await expect(cube.connect(ownerA).transferFrom(ownerA.address, ownerB.address, 1)).to.be.revertedWithCustomError(
        cube,
        "DirectTransferDisabled",
      );
      await expect(
        cube.connect(ownerB).transferFrom(ownerA.address, ownerB.address, 1),
      ).to.be.revertedWithCustomError(cube, "DirectTransferDisabled");
    });

    it("rejects safeTransferFrom (3-arg and 4-arg)", async () => {
      const { cube, minter, ownerA, ownerB } = await deployCube();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);

      await expect(
        cube.connect(ownerA)["safeTransferFrom(address,address,uint256)"](ownerA.address, ownerB.address, 1),
      ).to.be.revertedWithCustomError(cube, "DirectTransferDisabled");

      await expect(
        cube.connect(ownerA)["safeTransferFrom(address,address,uint256,bytes)"](
          ownerA.address,
          ownerB.address,
          1,
          "0x",
        ),
      ).to.be.revertedWithCustomError(cube, "DirectTransferDisabled");
    });

    it("still allows setApprovalForAll bookkeeping even though it cannot move tokens", async () => {
      const { cube, ownerA, ownerB } = await deployCube();
      await cube.connect(ownerA).setApprovalForAll(ownerB.address, true);
      expect(await cube.isApprovedForAll(ownerA.address, ownerB.address)).to.equal(true);
    });
  });

  describe("authorizedTransfer", function () {
    it("executes a valid owner-consented transfer submitted by the relayer", async () => {
      const { cube, minter, relayer, ownerA, ownerB } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);

      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      const signature = await signOwnerConsent(ownerA, cubeAddress, consent);

      await expect(cube.connect(relayer).authorizedTransfer(consent, signature))
        .to.emit(cube, "AuthorizedTransferExecuted")
        .withArgs(1n, ownerA.address, ownerB.address, OWNER_CONSENT_PURPOSE.TRANSFER, 0n);

      expect(await cube.ownerOf(1)).to.equal(ownerB.address);
      expect(await cube.consentNonce(1)).to.equal(1n);
    });

    it("rejects a submitter without AUTHORIZED_TRANSFER_ROLE", async () => {
      const { cube, minter, ownerA, ownerB, stranger } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      const signature = await signOwnerConsent(ownerA, cubeAddress, consent);

      await expect(cube.connect(stranger).authorizedTransfer(consent, signature)).to.be.revert(ethers);
    });

    it("rejects a consent whose claimed owner does not match the actual owner", async () => {
      const { cube, minter, relayer, ownerA, ownerB, stranger } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: stranger.address,
        from: stranger.address,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      const signature = await signOwnerConsent(stranger, cubeAddress, consent);

      await expect(cube.connect(relayer).authorizedTransfer(consent, signature)).to.be.revertedWithCustomError(
        cube,
        "OwnerMismatch",
      );
    });

    it("rejects an expired consent", async () => {
      const { cube, minter, relayer, ownerA, ownerB } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      const deadline = BigInt(Math.floor(Date.now() / 1000)) - ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      const signature = await signOwnerConsent(ownerA, cubeAddress, consent);

      await expect(cube.connect(relayer).authorizedTransfer(consent, signature)).to.be.revertedWithCustomError(
        cube,
        "ConsentExpired",
      );
    });

    it("rejects reuse of an already-consumed nonce (replay)", async () => {
      const { cube, minter, relayer, ownerA, ownerB } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      const signature = await signOwnerConsent(ownerA, cubeAddress, consent);
      await cube.connect(relayer).authorizedTransfer(consent, signature);

      // ownerB now owns the token; replaying ownerA's old signature must fail on the owner check
      // before nonce is even considered, proving the signature cannot be repurposed after transfer.
      await expect(cube.connect(relayer).authorizedTransfer(consent, signature)).to.be.revert(ethers);
    });

    it("rejects a stale nonce even for the correct current owner", async () => {
      const { cube, minter, relayer, ownerA, ownerB } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const staleConsent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 5n,
        deadline,
      };
      const signature = await signOwnerConsent(ownerA, cubeAddress, staleConsent);

      await expect(cube.connect(relayer).authorizedTransfer(staleConsent, signature))
        .to.be.revertedWithCustomError(cube, "InvalidConsentNonce")
        .withArgs(1n, 0n, 5n);
    });

    it("rejects a signature not produced by the current owner", async () => {
      const { cube, minter, relayer, ownerA, ownerB, stranger } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      // signed by `stranger`, not the actual owner `ownerA`
      const signature = await signOwnerConsent(stranger, cubeAddress, consent);

      await expect(cube.connect(relayer).authorizedTransfer(consent, signature)).to.be.revertedWithCustomError(
        cube,
        "InvalidOwnerConsentSignature",
      );
    });

    it("rejects purpose 0", async () => {
      const { cube, minter, relayer, ownerA, ownerB } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: ownerB.address,
        purpose: 0,
        nonce: 0n,
        deadline,
      };
      const signature = await signOwnerConsent(ownerA, cubeAddress, consent);

      await expect(cube.connect(relayer).authorizedTransfer(consent, signature)).to.be.revertedWithCustomError(
        cube,
        "InvalidConsentPurpose",
      );
    });

    it("rejects authorizedTransfer while paused", async () => {
      const { cube, minter, relayer, pauser, ownerA, ownerB } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      const signature = await signOwnerConsent(ownerA, cubeAddress, consent);
      await cube.connect(pauser).pause();

      await expect(cube.connect(relayer).authorizedTransfer(consent, signature)).to.be.revert(ethers);
    });

    it("accepts an ERC-1271 contract wallet as the current owner", async () => {
      const { cube, minter, relayer, ownerA, ownerB } = await deployCube();
      const cubeAddress = await cube.getAddress();

      const WalletFactory = await ethers.getContractFactory("ERC1271WalletMock");
      const wallet = await WalletFactory.deploy(ownerA.address);
      await wallet.waitForDeployment();
      const walletAddress = await wallet.getAddress();

      await cube.connect(minter).mintTo(walletAddress, 1, SAMPLE_URI);

      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: walletAddress,
        from: walletAddress,
        to: ownerB.address,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      // The EOA that controls the contract wallet signs; SignatureChecker routes this through
      // IERC1271.isValidSignature on `walletAddress` since `walletAddress` is a contract.
      const signature = await signOwnerConsent(ownerA, cubeAddress, consent);

      await expect(cube.connect(relayer).authorizedTransfer(consent, signature)).to.emit(
        cube,
        "AuthorizedTransferExecuted",
      );
      expect(await cube.ownerOf(1)).to.equal(ownerB.address);
    });

    it("rejects a transfer to a contract that cannot receive ERC-721 tokens", async () => {
      const { cube, minter, relayer, ownerA } = await deployCube();
      const cubeAddress = await cube.getAddress();
      await cube.connect(minter).mintTo(ownerA.address, 1, SAMPLE_URI);

      const NonReceivingFactory = await ethers.getContractFactory("NonReceivingWalletMock");
      const nonReceiving = await NonReceivingFactory.deploy();
      await nonReceiving.waitForDeployment();
      const nonReceivingAddress = await nonReceiving.getAddress();

      const deadline = BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR;
      const consent = {
        tokenId: 1n,
        currentOwner: ownerA.address,
        from: ownerA.address,
        to: nonReceivingAddress,
        purpose: OWNER_CONSENT_PURPOSE.TRANSFER,
        nonce: 0n,
        deadline,
      };
      const signature = await signOwnerConsent(ownerA, cubeAddress, consent);

      await expect(cube.connect(relayer).authorizedTransfer(consent, signature)).to.be.revert(ethers);
      // ownership must not have moved
      expect(await cube.ownerOf(1)).to.equal(ownerA.address);
    });
  });

  describe("pause governance", function () {
    it("only PAUSER_ROLE can pause", async () => {
      const { cube, stranger } = await deployCube();
      await expect(cube.connect(stranger).pause()).to.be.revert(ethers);
    });

    it("only DEFAULT_ADMIN_ROLE can unpause", async () => {
      const { cube, pauser, stranger } = await deployCube();
      await cube.connect(pauser).pause();
      await expect(cube.connect(stranger).unpause()).to.be.revert(ethers);
      await expect(cube.connect(pauser).unpause()).to.be.revert(ethers);
    });

    it("admin can unpause after pauser paused", async () => {
      const { cube, admin, pauser } = await deployCube();
      await cube.connect(pauser).pause();
      await cube.connect(admin).unpause();
      expect(await cube.paused()).to.equal(false);
    });
  });

  describe("UUPS upgrade authorization", function () {
    it("rejects an upgrade attempt from an account without UPGRADER_ROLE", async () => {
      const { cube, stranger } = await deployCube();
      const NewImplFactory = await ethers.getContractFactory("CubeNFT");
      const newImpl = await NewImplFactory.deploy();
      await newImpl.waitForDeployment();
      const newImplAddress = await newImpl.getAddress();

      await expect(cube.connect(stranger).upgradeToAndCall(newImplAddress, "0x")).to.be.revert(ethers);
    });

    it("allows the admin (UPGRADER_ROLE holder) to upgrade", async () => {
      const { cube, admin } = await deployCube();
      const cubeAddress = await cube.getAddress();
      const CubeNFTFactory = await ethers.getContractFactory("CubeNFT", admin);

      await upgradesApi.upgradeProxy(cubeAddress, CubeNFTFactory);
      // still functions correctly post-upgrade
      expect(await cube.MAX_TOKEN_ID()).to.equal(CUBE_NFT_MAX_TOKEN_ID);
    });
  });

  describe("no burn function exists", function () {
    it("the compiled ABI does not expose a burn function", async () => {
      const CubeNFTFactory = await ethers.getContractFactory("CubeNFT");
      const fragment = CubeNFTFactory.interface.fragments.find(
        (f) =>
          f.type === "function" &&
          "name" in f &&
          typeof f.name === "string" &&
          f.name.toLowerCase().includes("burn"),
      );
      expect(fragment).to.equal(undefined);
    });
  });
});
