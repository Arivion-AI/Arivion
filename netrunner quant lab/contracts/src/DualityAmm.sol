// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal constant-product (x*y=k) AMM for the Duality LP-execution demo on Arbitrum Sepolia. Real
// on-chain liquidity provision + swaps the agent can execute when a plan calls for an LP sleeve.
// LP shares tracked internally. TESTNET DEMO — not audited, not for real funds.
interface IERC20 {
    function transfer(address to, uint256 a) external returns (bool);
    function transferFrom(address f, address to, uint256 a) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract DualityAmm {
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    string public pair;
    uint16 public immutable feeBps; // swap fee in bps (e.g. 30 = 0.3%)
    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public totalShares;
    mapping(address => uint256) public shares;

    event LiquidityAdded(address indexed who, uint256 amount0, uint256 amount1, uint256 sharesMinted);
    event LiquidityRemoved(address indexed who, uint256 amount0, uint256 amount1, uint256 sharesBurned);
    event Swapped(address indexed who, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    constructor(address t0, address t1, string memory _pair, uint16 _feeBps) {
        token0 = IERC20(t0);
        token1 = IERC20(t1);
        pair = _pair;
        feeBps = _feeBps;
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) { z = y; uint256 x = y / 2 + 1; while (x < z) { z = x; x = (y / x + x) / 2; } }
        else if (y != 0) { z = 1; }
    }
    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }

    function addLiquidity(uint256 a0, uint256 a1) external returns (uint256 minted) {
        require(a0 > 0 && a1 > 0, "ZERO");
        require(token0.transferFrom(msg.sender, address(this), a0), "T0_IN");
        require(token1.transferFrom(msg.sender, address(this), a1), "T1_IN");
        minted = totalShares == 0 ? _sqrt(a0 * a1) : _min((a0 * totalShares) / reserve0, (a1 * totalShares) / reserve1);
        require(minted > 0, "ZERO_SHARES");
        shares[msg.sender] += minted;
        totalShares += minted;
        reserve0 += a0;
        reserve1 += a1;
        emit LiquidityAdded(msg.sender, a0, a1, minted);
    }

    function removeLiquidity(uint256 s) external returns (uint256 a0, uint256 a1) {
        require(s > 0 && shares[msg.sender] >= s, "SHARES");
        a0 = (s * reserve0) / totalShares;
        a1 = (s * reserve1) / totalShares;
        shares[msg.sender] -= s;
        totalShares -= s;
        reserve0 -= a0;
        reserve1 -= a1;
        require(token0.transfer(msg.sender, a0), "T0_OUT");
        require(token1.transfer(msg.sender, a1), "T1_OUT");
        emit LiquidityRemoved(msg.sender, a0, a1, s);
    }

    // zeroForOne: true = sell token0 for token1.
    function swap(bool zeroForOne, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        require(amountIn > 0 && totalShares > 0, "BAD");
        (IERC20 tin, IERC20 tout, uint256 rin, uint256 rout) =
            zeroForOne ? (token0, token1, reserve0, reserve1) : (token1, token0, reserve1, reserve0);
        require(tin.transferFrom(msg.sender, address(this), amountIn), "IN");
        uint256 amountInAfterFee = (amountIn * (10000 - feeBps)) / 10000;
        amountOut = (amountInAfterFee * rout) / (rin + amountInAfterFee);
        require(amountOut >= minOut && amountOut < rout, "SLIPPAGE");
        if (zeroForOne) { reserve0 += amountIn; reserve1 -= amountOut; }
        else { reserve1 += amountIn; reserve0 -= amountOut; }
        require(tout.transfer(msg.sender, amountOut), "OUT");
        emit Swapped(msg.sender, zeroForOne, amountIn, amountOut);
    }

    function quote(bool zeroForOne, uint256 amountIn) external view returns (uint256) {
        (uint256 rin, uint256 rout) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (rin == 0) return 0;
        uint256 aof = (amountIn * (10000 - feeBps)) / 10000;
        return (aof * rout) / (rin + aof);
    }
}
