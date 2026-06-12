// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * Duality tokenized-stock sleeve — oracle-priced mint/redeem for Robinhood Chain testnet (46630).
 *
 * Robinhood's testnet ships stock-token balances but NO DEX/orderbook/oracle, so to "trade" them we
 * deploy this self-contained venue: per-symbol mintable ERC-20 stock tokens, an owner-pushed USD
 * price oracle, and a vault that mints/redeems those tokens against a USDG-style collateral token at
 * the oracle price. TESTNET DEMO ONLY — no production stock rights, value, or settlement.
 *
 * Honesty constraints encoded: long-only (you can only mint/redeem, never short), 1x (no leverage),
 * and an optional regular-trading-hours gate the owner can toggle. Prices are owner-pushed from an
 * off-chain feed; staleness is enforced on-chain.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// Minimal ERC-20 whose supply is controlled solely by its vault (mint/burn). 18 decimals.
contract DualityStockToken is IERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable vault;

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    modifier onlyVault() {
        require(msg.sender == vault, "ONLY_VAULT");
        _;
    }

    constructor(string memory _name, string memory _symbol, address _vault) {
        name = _name;
        symbol = _symbol;
        vault = _vault;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
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

    function mint(address to, uint256 amount) external onlyVault {
        totalSupply += amount;
        unchecked { balanceOf[to] += amount; }
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        require(balanceOf[from] >= amount, "BALANCE");
        unchecked {
            balanceOf[from] -= amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }
}

contract DualityStockVault {
    struct Stock {
        DualityStockToken token;
        uint256 priceUsd1e8;   // USD price, 8 decimals (e.g. TSLA $250.00 -> 25000000000)
        uint64 updatedAt;      // last oracle push
        bool listed;
    }

    address public owner;
    IERC20 public immutable collateral;     // USDG-style 18-decimal stablecoin
    uint256 public maxPriceStaleness = 1 hours;
    bool public rthOnly;                     // if true, mint/redeem only during owner-declared open window
    bool public marketOpen = true;          // owner toggles to reflect regular trading hours

    mapping(string => Stock) public stocks;
    string[] public symbols;

    event StockListed(string symbol, address token);
    event PriceUpdated(string symbol, uint256 priceUsd1e8, uint64 at);
    event Minted(address indexed user, string symbol, uint256 collateralIn, uint256 stockOut, uint256 priceUsd1e8);
    event Redeemed(address indexed user, string symbol, uint256 stockIn, uint256 collateralOut, uint256 priceUsd1e8);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    constructor(address _collateral) {
        owner = msg.sender;
        collateral = IERC20(_collateral);
    }

    // --- admin ---
    function listStock(string calldata symbol, string calldata name) external onlyOwner returns (address) {
        require(!stocks[symbol].listed, "LISTED");
        DualityStockToken token = new DualityStockToken(name, string.concat("d", symbol), address(this));
        stocks[symbol] = Stock({token: token, priceUsd1e8: 0, updatedAt: 0, listed: true});
        symbols.push(symbol);
        emit StockListed(symbol, address(token));
        return address(token);
    }

    function setPrice(string calldata symbol, uint256 priceUsd1e8) external onlyOwner {
        Stock storage s = stocks[symbol];
        require(s.listed, "NOT_LISTED");
        require(priceUsd1e8 > 0, "BAD_PRICE");
        s.priceUsd1e8 = priceUsd1e8;
        s.updatedAt = uint64(block.timestamp);
        emit PriceUpdated(symbol, priceUsd1e8, s.updatedAt);
    }

    function setPrices(string[] calldata syms, uint256[] calldata prices) external onlyOwner {
        require(syms.length == prices.length, "LEN");
        for (uint256 i = 0; i < syms.length; i++) {
            Stock storage s = stocks[syms[i]];
            require(s.listed, "NOT_LISTED");
            require(prices[i] > 0, "BAD_PRICE");
            s.priceUsd1e8 = prices[i];
            s.updatedAt = uint64(block.timestamp);
            emit PriceUpdated(syms[i], prices[i], s.updatedAt);
        }
    }

    function setMarketOpen(bool open) external onlyOwner { marketOpen = open; }
    function setRthOnly(bool on) external onlyOwner { rthOnly = on; }
    function setMaxStaleness(uint256 secs) external onlyOwner { maxPriceStaleness = secs; }

    // --- views ---
    function symbolCount() external view returns (uint256) { return symbols.length; }

    function priceOf(string calldata symbol) public view returns (uint256 priceUsd1e8, uint64 updatedAt, bool fresh) {
        Stock storage s = stocks[symbol];
        require(s.listed, "NOT_LISTED");
        fresh = s.updatedAt != 0 && block.timestamp - s.updatedAt <= maxPriceStaleness;
        return (s.priceUsd1e8, s.updatedAt, fresh);
    }

    function tokenOf(string calldata symbol) external view returns (address) {
        return address(stocks[symbol].token);
    }

    function quoteMint(string calldata symbol, uint256 collateralIn) external view returns (uint256 stockOut) {
        (uint256 p,, bool fresh) = priceOf(symbol);
        require(fresh, "STALE_PRICE");
        // collateral and stock are both 18-decimal; price is 1e8 USD. collateral is treated as $1.
        return (collateralIn * 1e8) / p;
    }

    // --- user mint/redeem (long-only, 1x, oracle-priced) ---
    function mint(string calldata symbol, uint256 collateralIn) external returns (uint256 stockOut) {
        require(marketOpen || !rthOnly, "MARKET_CLOSED");
        Stock storage s = stocks[symbol];
        require(s.listed, "NOT_LISTED");
        require(s.updatedAt != 0 && block.timestamp - s.updatedAt <= maxPriceStaleness, "STALE_PRICE");
        require(collateralIn > 0, "ZERO");
        require(collateral.transferFrom(msg.sender, address(this), collateralIn), "COLLATERAL_IN");
        stockOut = (collateralIn * 1e8) / s.priceUsd1e8;
        s.token.mint(msg.sender, stockOut);
        emit Minted(msg.sender, symbol, collateralIn, stockOut, s.priceUsd1e8);
    }

    function redeem(string calldata symbol, uint256 stockIn) external returns (uint256 collateralOut) {
        require(marketOpen || !rthOnly, "MARKET_CLOSED");
        Stock storage s = stocks[symbol];
        require(s.listed, "NOT_LISTED");
        require(s.updatedAt != 0 && block.timestamp - s.updatedAt <= maxPriceStaleness, "STALE_PRICE");
        require(stockIn > 0, "ZERO");
        s.token.burn(msg.sender, stockIn);
        collateralOut = (stockIn * s.priceUsd1e8) / 1e8;
        require(collateral.balanceOf(address(this)) >= collateralOut, "VAULT_LIQUIDITY");
        require(collateral.transfer(msg.sender, collateralOut), "COLLATERAL_OUT");
        emit Redeemed(msg.sender, symbol, stockIn, collateralOut, s.priceUsd1e8);
    }
}
