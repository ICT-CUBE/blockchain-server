#!/bin/sh
set -eu

REPO_ROOT="/workspace"
HARDHAT_LOG="/tmp/hardhat-node.log"
HARDHAT_PID=""

cleanup() {
  if [ -n "$HARDHAT_PID" ] && kill -0 "$HARDHAT_PID" 2>/dev/null; then
    kill "$HARDHAT_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

cd "$REPO_ROOT"

# This image is exclusively for the shared development server. Always use Hardhat's public,
# pre-funded development accounts instead of any Amoy role or signer configuration left in Azure.
unset AMOY_DEPLOYER_PRIVATE_KEY
unset AMOY_RPC_URL_PRIMARY
unset CUBE_NFT_ADMIN_ADDRESS
unset CUBE_NFT_MINTER_ADDRESS
unset CUBE_NFT_RELAYER_ADDRESS
unset CUBE_NFT_PAUSER_ADDRESS
unset MINT_SIGNER_PRIVATE_KEY
unset RELAYER_SIGNER_PRIVATE_KEY

export CUBE_NFT_NETWORK="localhost"
export TRANSACTION_RPC_URL_PRIMARY="http://127.0.0.1:8545"

echo "==> Start the internal Hardhat chain"
rm -f contracts/deployments/localhost.json
npm run node --workspace=contracts/cube-nft -- --hostname 127.0.0.1 >"$HARDHAT_LOG" 2>&1 &
HARDHAT_PID=$!

attempt=1
while [ "$attempt" -le 60 ]; do
  if ! kill -0 "$HARDHAT_PID" 2>/dev/null; then
    echo "Hardhat node exited during startup."
    cat "$HARDHAT_LOG"
    exit 1
  fi

  if node -e "fetch('http://127.0.0.1:8545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})}).then(r=>r.json()).then(v=>process.exit(v.result==='0x7a69'?0:1)).catch(()=>process.exit(1))"; then
    break
  fi

  if [ "$attempt" -eq 60 ]; then
    echo "Hardhat RPC did not become ready."
    cat "$HARDHAT_LOG"
    exit 1
  fi

  attempt=$((attempt + 1))
  sleep 1
done

echo "==> Deploy CubeNFT to the internal Hardhat chain"
(
  cd contracts/cube-nft
  ../../node_modules/.bin/hardhat run --no-compile scripts/deploy.ts --network localhost
)

echo "==> Run Blockchain DB migrations"
node node_modules/typeorm/cli.js migration:run -d server/dist/shared/database/data-source.js

echo "==> Start Blockchain Server"
node server/dist/main.js &
SERVER_PID=$!

set +e
wait "$SERVER_PID"
SERVER_EXIT_CODE=$?
set -e

cleanup
wait "$HARDHAT_PID" 2>/dev/null || true
exit "$SERVER_EXIT_CODE"
