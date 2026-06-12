// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * Mintable test stablecoin for the Duality stock-vault demo on Robinhood testnet.
 * Real USDG is Paxos-controlled; this self-contained mock lets the mint/redeem loop run end-to-end
 * without faucet dependencies. TESTNET ONLY — no value, freely mintable by anyone for demos.
 */
contract MockUSDG {
    string public constant name = "Duality Test USDG";
    string public constant symbol = "tUSDG";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "BALANCE");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    /// Open faucet — anyone can mint test collateral for the demo.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        unchecked { balanceOf[to] += amount; }
        emit Transfer(address(0), to, amount);
    }
}
