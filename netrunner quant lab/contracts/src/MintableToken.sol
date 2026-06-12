// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal 18-decimal ERC-20 with an open faucet mint — testnet pool tokens for the Duality LP demo
// on Arbitrum Sepolia. No value; anyone can mint for demos.
contract MintableToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transfer(address to, uint256 a) external returns (bool) { _xfer(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) { require(al >= a, "ALLOWANCE"); allowance[f][msg.sender] = al - a; }
        _xfer(f, to, a); return true;
    }
    function _xfer(address f, address to, uint256 a) internal {
        require(balanceOf[f] >= a, "BALANCE");
        unchecked { balanceOf[f] -= a; balanceOf[to] += a; }
        emit Transfer(f, to, a);
    }
    function mint(address to, uint256 a) external { totalSupply += a; unchecked { balanceOf[to] += a; } emit Transfer(address(0), to, a); }
}
