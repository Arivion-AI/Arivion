// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MintableToken} from "../src/MintableToken.sol";
import {DualityAmm} from "../src/DualityAmm.sol";

// Deploys the Duality LP demo on Arbitrum Sepolia: two test tokens (dWETH/dUSDC) + a constant-product
// pool seeded with liquidity (10 dWETH / 30,000 dUSDC ⇒ ~$3,000 price). The agent then swaps + LPs here.
//   forge script script/DeployAmm.s.sol:DeployAmm --rpc-url arbitrum_sepolia --broadcast --private-key $DEPLOY_PRIVATE_KEY
contract DeployAmm is Script {
    function run() external {
        vm.startBroadcast();
        MintableToken weth = new MintableToken("Duality Test WETH", "dWETH");
        MintableToken usdc = new MintableToken("Duality Test USDC", "dUSDC");
        DualityAmm amm = new DualityAmm(address(weth), address(usdc), "dWETH/dUSDC", 30);

        address me = msg.sender;
        weth.mint(me, 10 ether);
        usdc.mint(me, 30000 ether);
        weth.approve(address(amm), 10 ether);
        usdc.approve(address(amm), 30000 ether);
        uint256 shares = amm.addLiquidity(10 ether, 30000 ether);

        console.log("dWETH", address(weth));
        console.log("dUSDC", address(usdc));
        console.log("DualityAmm", address(amm));
        console.log("seedShares", shares);
        vm.stopBroadcast();
    }
}
