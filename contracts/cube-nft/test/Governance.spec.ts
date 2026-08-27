import { expect } from "chai";
import hre, { network } from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

import {
  assertValidGovernanceConfig,
  InvalidMainnetGovernanceConfigError,
  MAINNET_TIMELOCK_DELAY_SECONDS,
} from "../src/governance-config.js";

const CONTRACT_NAME = "ARZONE CUBE NFT";
const CONTRACT_SYMBOL = "CUBE";
const SAFE_THRESHOLD = 2;

describe("assertValidGovernanceConfig", function () {
  it("allows any admin/delay on a non-Mainnet-track network", () => {
    expect(() =>
      assertValidGovernanceConfig({ networkName: "amoy", adminIsContract: false, minDelaySeconds: 0 }),
    ).to.not.throw();
  });

  it("rejects an EOA admin on Mainnet", () => {
    expect(() =>
      assertValidGovernanceConfig({
        networkName: "mainnet",
        adminIsContract: false,
        minDelaySeconds: MAINNET_TIMELOCK_DELAY_SECONDS,
      }),
    ).to.throw(InvalidMainnetGovernanceConfigError);
  });

  it("rejects a Timelock delay other than 48h on Mainnet", () => {
    expect(() =>
      assertValidGovernanceConfig({ networkName: "mainnet", adminIsContract: true, minDelaySeconds: 3600 }),
    ).to.throw(InvalidMainnetGovernanceConfigError);
  });

  it("accepts a contract admin with exactly a 48h delay on Mainnet", () => {
    expect(() =>
      assertValidGovernanceConfig({
        networkName: "mainnet",
        adminIsContract: true,
        minDelaySeconds: MAINNET_TIMELOCK_DELAY_SECONDS,
      }),
    ).to.not.throw();
  });
});

describe("Governance: Timelock + multisig on-chain", function () {
  let ethers: Awaited<ReturnType<typeof network.create>>["ethers"];
  let networkHelpers: Awaited<ReturnType<typeof network.create>>["networkHelpers"];
  let upgradesApi: Awaited<ReturnType<typeof upgrades>>;

  before(async () => {
    const connection = await network.create();
    ({ ethers, networkHelpers } = connection);
    upgradesApi = await upgrades(hre, connection);
  });

  async function deployGovernedSystem() {
    const [admin, minter, relayer, pauser, safeOwnerA, safeOwnerB, safeOwnerC] = await ethers.getSigners();

    const CubeNFTFactory = await ethers.getContractFactory("CubeNFT");
    const cube = await upgradesApi.deployProxy(
      CubeNFTFactory,
      [CONTRACT_NAME, CONTRACT_SYMBOL, admin.address, minter.address, relayer.address, pauser.address],
      { kind: "uups" },
    );
    await cube.waitForDeployment();
    const cubeAddress = await cube.getAddress();

    const MultisigFactory = await ethers.getContractFactory("GovernanceMultisigMock");
    const multisig = await MultisigFactory.deploy(
      [safeOwnerA.address, safeOwnerB.address, safeOwnerC.address],
      SAFE_THRESHOLD,
    );
    await multisig.waitForDeployment();
    const multisigAddress = await multisig.getAddress();

    // Stand-in for the real deployed Safe: on Mainnet, proposers/executors would be [safeAddress],
    // not individual EOAs. See scripts/transfer-governance.ts and GovernanceMultisigMock.sol.
    const TimelockFactory = await ethers.getContractFactory("GovernanceTimelock");
    const timelock = await TimelockFactory.deploy(
      MAINNET_TIMELOCK_DELAY_SECONDS,
      [multisigAddress],
      [multisigAddress],
      ethers.ZeroAddress,
    );
    await timelock.waitForDeployment();
    const timelockAddress = await timelock.getAddress();

    const upgraderRole: string = await cube.UPGRADER_ROLE();
    const defaultAdminRole = ethers.ZeroHash;

    await (await cube.connect(admin).grantRole(defaultAdminRole, timelockAddress)).wait();
    await (await cube.connect(admin).grantRole(upgraderRole, timelockAddress)).wait();
    await (await cube.connect(admin).renounceRole(upgraderRole, admin.address)).wait();
    await (await cube.connect(admin).renounceRole(defaultAdminRole, admin.address)).wait();

    return {
      cube,
      cubeAddress,
      multisig,
      timelock,
      timelockAddress,
      admin,
      pauser,
      safeOwnerA,
      safeOwnerB,
      safeOwnerC,
      defaultAdminRole,
      upgraderRole,
    };
  }

  /** Routes `data` to `target` through the multisig-gated Timelock: 2-of-3 approve + execute the
   * multisig call that invokes `timelock.schedule`, then (after the caller advances time as
   * needed) 2-of-3 approve + execute the multisig call that invokes `timelock.execute`. */
  async function scheduleThroughGovernance(
    ctx: Awaited<ReturnType<typeof deployGovernedSystem>>,
    target: string,
    data: string,
  ): Promise<{ executeViaGovernance: () => Promise<void> }> {
    const { multisig, timelock, timelockAddress, safeOwnerA, safeOwnerB } = ctx;
    const timelockSalt = ethers.hexlify(ethers.randomBytes(32));

    const scheduleData = timelock.interface.encodeFunctionData("schedule", [
      target,
      0,
      data,
      ethers.ZeroHash,
      timelockSalt,
      MAINNET_TIMELOCK_DELAY_SECONDS,
    ]);
    const scheduleMultisigSalt = ethers.hexlify(ethers.randomBytes(32));
    const scheduleCallHash = await multisig.callHashOf(timelockAddress, scheduleData, scheduleMultisigSalt);
    await multisig.connect(safeOwnerA).approve(scheduleCallHash);
    await multisig.connect(safeOwnerB).approve(scheduleCallHash);
    await multisig.connect(safeOwnerA).execute(timelockAddress, scheduleData, scheduleMultisigSalt);

    return {
      executeViaGovernance: async () => {
        const executeData = timelock.interface.encodeFunctionData("execute", [
          target,
          0,
          data,
          ethers.ZeroHash,
          timelockSalt,
        ]);
        const executeMultisigSalt = ethers.hexlify(ethers.randomBytes(32));
        const executeCallHash = await multisig.callHashOf(timelockAddress, executeData, executeMultisigSalt);
        await multisig.connect(safeOwnerA).approve(executeCallHash);
        await multisig.connect(safeOwnerB).approve(executeCallHash);
        await multisig.connect(safeOwnerA).execute(timelockAddress, executeData, executeMultisigSalt);
      },
    };
  }

  it("moves DEFAULT_ADMIN_ROLE and UPGRADER_ROLE fully to the Timelock, off the original EOA admin", async () => {
    const { cube, timelockAddress, admin, defaultAdminRole, upgraderRole } = await deployGovernedSystem();

    expect(await cube.hasRole(defaultAdminRole, timelockAddress)).to.equal(true);
    expect(await cube.hasRole(upgraderRole, timelockAddress)).to.equal(true);
    expect(await cube.hasRole(defaultAdminRole, admin.address)).to.equal(false);
    expect(await cube.hasRole(upgraderRole, admin.address)).to.equal(false);
  });

  it("the original EOA admin can no longer upgrade the contract directly", async () => {
    const { cube, admin } = await deployGovernedSystem();
    const NewImplFactory = await ethers.getContractFactory("CubeNFT");
    const newImpl = await NewImplFactory.deploy();
    await newImpl.waitForDeployment();

    await expect(cube.connect(admin).upgradeToAndCall(await newImpl.getAddress(), "0x")).to.be.revert(ethers);
  });

  it("a single Safe owner's approval is not enough to schedule a Timelock operation", async () => {
    const ctx = await deployGovernedSystem();
    const { cube, cubeAddress, multisig, timelock, timelockAddress, pauser, safeOwnerA } = ctx;

    await cube.connect(pauser).pause();
    const unpauseData = cube.interface.encodeFunctionData("unpause");
    const timelockSalt = ethers.hexlify(ethers.randomBytes(32));
    const scheduleData = timelock.interface.encodeFunctionData("schedule", [
      cubeAddress,
      0,
      unpauseData,
      ethers.ZeroHash,
      timelockSalt,
      MAINNET_TIMELOCK_DELAY_SECONDS,
    ]);
    const multisigSalt = ethers.hexlify(ethers.randomBytes(32));
    const callHash = await multisig.callHashOf(timelockAddress, scheduleData, multisigSalt);

    await multisig.connect(safeOwnerA).approve(callHash);

    await expect(multisig.connect(safeOwnerA).execute(timelockAddress, scheduleData, multisigSalt)).to.be.revert(
      ethers,
    );
  });

  it("rejects execution before the 48h delay elapses, and allows it after", async () => {
    const ctx = await deployGovernedSystem();
    const { cube, cubeAddress, pauser } = ctx;

    await cube.connect(pauser).pause();
    expect(await cube.paused()).to.equal(true);

    const unpauseData = cube.interface.encodeFunctionData("unpause");
    const { executeViaGovernance } = await scheduleThroughGovernance(ctx, cubeAddress, unpauseData);

    await expect(executeViaGovernance()).to.be.revert(ethers);
    expect(await cube.paused()).to.equal(true);

    await networkHelpers.time.increase(MAINNET_TIMELOCK_DELAY_SECONDS + 1);

    await executeViaGovernance();
    expect(await cube.paused()).to.equal(false);
  });

  it("a 2-of-3-approved upgrade succeeds once the Timelock delay has elapsed", async () => {
    const ctx = await deployGovernedSystem();
    const { cube, cubeAddress } = ctx;

    const NewImplFactory = await ethers.getContractFactory("CubeNFT");
    const newImpl = await NewImplFactory.deploy();
    await newImpl.waitForDeployment();
    const upgradeData = cube.interface.encodeFunctionData("upgradeToAndCall", [await newImpl.getAddress(), "0x"]);

    const { executeViaGovernance } = await scheduleThroughGovernance(ctx, cubeAddress, upgradeData);

    await networkHelpers.time.increase(MAINNET_TIMELOCK_DELAY_SECONDS + 1);
    await executeViaGovernance();

    // still functions correctly post-upgrade
    expect(await cube.MAX_TOKEN_ID()).to.equal(10000);
  });
});
