import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatUpgrades from "@openzeppelin/hardhat-upgrades";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin, hardhatUpgrades],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Connects over HTTP to a separately-running `npx hardhat node` (or `npm run node`), unlike
    // hardhatMainnet's in-process EDR simulation — needed by anything outside this package (e.g.
    // the server's TASK-10 integration tests) that submits transactions against a real JSON-RPC
    // endpoint. Accounts are Hardhat's well-known dev mnemonic ("test test test ... junk"),
    // public/non-secret, matching the local fallback `deploy.ts` and the server's own
    // `LOCAL_DEV_*_PRIVATE_KEY` constants use.
    localhost: {
      type: "http",
      chainType: "l1",
      chainId: 31337,
      url: "http://127.0.0.1:8545",
      accounts: [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
        "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
      ],
    },
    amoy: {
      type: "http",
      chainType: "l1",
      chainId: 80002,
      url: configVariable("AMOY_RPC_URL_PRIMARY"),
      accounts: [configVariable("AMOY_DEPLOYER_PRIVATE_KEY")],
    },
  },
});
