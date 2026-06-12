// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDG} from "../src/MockUSDG.sol";
import {DualityStockVault} from "../src/DualityStockVault.sol";

/*
 * Deploys the Duality tokenized-stock sleeve on Robinhood Chain testnet (46630):
 *   forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --private-key $DEPLOY_PRIVATE_KEY
 * Lists TSLA/AMZN/PLTR/NFLX/AMD and seeds initial oracle prices (the off-chain price pusher keeps
 * them fresh thereafter). Each stock token is a fresh `dSYMBOL` ERC-20 minted only by the vault.
 */
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        MockUSDG usdg = new MockUSDG();
        DualityStockVault vault = new DualityStockVault(address(usdg));

        string[5] memory syms = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
        string[5] memory names = ["Tesla", "Amazon", "Palantir", "Netflix", "AMD"];
        // seed prices (USD * 1e8) — overwritten by the live price pusher
        uint256[5] memory px = [uint256(250e8), 185e8, 42e8, 700e8, 160e8];

        for (uint256 i = 0; i < syms.length; i++) {
            address t = vault.listStock(syms[i], names[i]);
            vault.setPrice(syms[i], px[i]);
            console.log(syms[i], t);
        }

        console.log("MockUSDG:", address(usdg));
        console.log("DualityStockVault:", address(vault));
        vm.stopBroadcast();
    }
}
