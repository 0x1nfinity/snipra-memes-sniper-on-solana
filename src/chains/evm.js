import { ethers } from 'ethers';
import { createLogger } from '../logger.js';

const log = createLogger('evm');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
];

const V3_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

const V2_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
];

const V3_FEES = [500, 3000, 10000];
// SwapRouter02: recipient sentinel address(2) = router sendiri (untuk multicall unwrap)
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';

export class EvmChain {
  constructor(chainKey, chainCfg, { dryRun }) {
    this.key = chainKey;
    this.cfg = chainCfg;
    this.dryRun = dryRun;
    const rpc = process.env[chainCfg.rpcEnv];
    if (!rpc) log.warn(`${chainCfg.rpcEnv} kosong utk chain ${chainKey}`);
    this.provider = new ethers.JsonRpcProvider(rpc, chainCfg.chainIdNum);
    this.wallet = process.env.EVM_PRIVATE_KEY
      ? new ethers.Wallet(process.env.EVM_PRIVATE_KEY, this.provider)
      : null;
    if (this.wallet) log.info(`[${chainKey}] wallet: ${this.wallet.address}`);
    else log.warn(`EVM_PRIVATE_KEY kosong — chain ${chainKey} hanya bisa dry-run`);

    this.v3Router = new ethers.Contract(chainCfg.v3SwapRouter02, V3_ROUTER_ABI, this.wallet || this.provider);
    this.v3Quoter = new ethers.Contract(chainCfg.v3QuoterV2, V3_QUOTER_ABI, this.provider);
    this.v2Router = new ethers.Contract(chainCfg.v2Router, V2_ROUTER_ABI, this.wallet || this.provider);
    this._decimalsCache = new Map();
  }

  get address() {
    return this.wallet?.address || null;
  }

  async nativeBalance() {
    if (!this.wallet) return 0;
    return Number(ethers.formatEther(await this.provider.getBalance(this.wallet.address)));
  }

  async tokenDecimals(token) {
    if (this._decimalsCache.has(token)) return this._decimalsCache.get(token);
    const c = new ethers.Contract(token, ERC20_ABI, this.provider);
    const d = Number(await c.decimals());
    this._decimalsCache.set(token, d);
    return d;
  }

  async tokenBalance(token) {
    const decimals = await this.tokenDecimals(token);
    if (!this.wallet) return { raw: 0n, decimals, ui: 0 };
    const c = new ethers.Contract(token, ERC20_ABI, this.provider);
    const raw = await c.balanceOf(this.wallet.address);
    return { raw, decimals, ui: Number(ethers.formatUnits(raw, decimals)) };
  }

  /** Coba quote V3 di semua fee tier → {fee, out} terbaik, atau null */
  async _bestV3Quote(tokenIn, tokenOut, amountIn) {
    let best = null;
    for (const fee of V3_FEES) {
      try {
        const [out] = await this.v3Quoter.quoteExactInputSingle.staticCall({
          tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n,
        });
        if (out > 0n && (!best || out > best.out)) best = { fee, out };
      } catch { /* pool fee tier ini tidak ada */ }
    }
    return best;
  }

  async _v2Quote(path, amountIn) {
    try {
      const amounts = await this.v2Router.getAmountsOut(amountIn, path);
      return amounts[amounts.length - 1];
    } catch {
      return null;
    }
  }

  _minOut(out, slippageBps) {
    return (out * BigInt(10000 - slippageBps)) / 10000n;
  }

  /**
   * Pilih rute terbaik antara Uniswap V3 dan V2 untuk tokenIn→tokenOut.
   * pairInfo.labels dari DexScreener dipakai sebagai hint prioritas.
   */
  async _route(tokenIn, tokenOut, amountIn, labels = []) {
    const preferV2 = labels.includes('v2');
    const [v3, v2out] = await Promise.all([
      this._bestV3Quote(tokenIn, tokenOut, amountIn),
      this._v2Quote([tokenIn, tokenOut], amountIn),
    ]);
    if (v3 && v2out) {
      if (preferV2 && v2out >= (v3.out * 95n) / 100n) return { kind: 'v2', out: v2out };
      return v3.out >= v2out ? { kind: 'v3', ...v3 } : { kind: 'v2', out: v2out };
    }
    if (v3) return { kind: 'v3', ...v3 };
    if (v2out) return { kind: 'v2', out: v2out };
    throw new Error(`tidak ada rute Uniswap v2/v3 utk ${tokenOut}`);
  }

  /** Buy: ETH → token. amountNative dalam ETH. */
  async buy(tokenAddress, amountNative, slippageBps, pairInfo = {}) {
    const weth = this.cfg.weth;
    const amountIn = ethers.parseEther(String(amountNative));
    const route = await this._route(weth, tokenAddress, amountIn, pairInfo.labels);
    const minOut = this._minOut(route.out, slippageBps);

    if (this.dryRun) {
      log.info(`[DRY] [${this.key}] buy ${tokenAddress.slice(0, 8)} via ${route.kind} out=${route.out}`);
      return { txid: `dry-${Date.now()}`, spentNative: amountNative, tokensRaw: route.out };
    }
    if (!this.wallet) throw new Error('wallet EVM belum diset');

    let tx;
    if (route.kind === 'v3') {
      tx = await this.v3Router.exactInputSingle(
        {
          tokenIn: weth, tokenOut: tokenAddress, fee: route.fee,
          recipient: this.wallet.address, amountIn,
          amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
        },
        { value: amountIn, gasLimit: this.cfg.gasLimitSwap }
      );
    } else {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      tx = await this.v2Router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        minOut, [weth, tokenAddress], this.wallet.address, deadline,
        { value: amountIn, gasLimit: this.cfg.gasLimitSwap }
      );
    }
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`buy tx revert: ${tx.hash}`);
    const bal = await this.tokenBalance(tokenAddress);
    log.info(`BUY [${this.key}] ${tokenAddress.slice(0, 8)} ${amountNative} ETH via ${route.kind} tx ${tx.hash}`);
    return { txid: tx.hash, spentNative: amountNative, tokensRaw: bal.raw };
  }

  async _ensureApproval(token, spender, amount) {
    const c = new ethers.Contract(token, ERC20_ABI, this.wallet);
    const current = await c.allowance(this.wallet.address, spender);
    if (current >= amount) return;
    const tx = await c.approve(spender, ethers.MaxUint256);
    await tx.wait();
    log.info(`approved ${token.slice(0, 8)} utk ${spender.slice(0, 8)}`);
  }

  /** Sell: token → ETH. pct = persen dari balance (0-100). */
  async sell(tokenAddress, pct, slippageBps, pairInfo = {}) {
    const weth = this.cfg.weth;
    let raw;
    if (this.dryRun && !this.wallet) {
      raw = ethers.parseUnits('1000', 18);
    } else {
      const bal = await this.tokenBalance(tokenAddress);
      raw = (bal.raw * BigInt(Math.floor(pct * 100))) / 10000n;
    }
    if (raw <= 0n) throw new Error(`balance ${tokenAddress.slice(0, 8)} = 0`);

    const route = await this._route(tokenAddress, weth, raw, pairInfo.labels);
    const minOut = this._minOut(route.out, slippageBps);

    if (this.dryRun) {
      log.info(`[DRY] [${this.key}] sell ${pct}% ${tokenAddress.slice(0, 8)} via ${route.kind} out=${route.out}`);
      return { txid: `dry-${Date.now()}`, soldRaw: raw, receivedNative: Number(ethers.formatEther(route.out)) };
    }
    if (!this.wallet) throw new Error('wallet EVM belum diset');

    // Approvals first (separated from swap tx so ethBefore captures after approval gas)
    if (route.kind === 'v3') {
      await this._ensureApproval(tokenAddress, this.cfg.v3SwapRouter02, raw);
    } else {
      await this._ensureApproval(tokenAddress, this.cfg.v2Router, raw);
    }

    // Capture balance AFTER approval (so approval gas doesn't leak into receivedNative).
    // Best-effort: jika query saldo gagal, fallback ke quote.
    let ethBefore = 0n;
    try {
      ethBefore = await this.provider.getBalance(this.wallet.address);
    } catch (e) {
      log.warn(`[${this.key}] gagal baca saldo ETH sebelum swap: ${e.message}`);
    }

    let tx;
    if (route.kind === 'v3') {
      const swapData = this.v3Router.interface.encodeFunctionData('exactInputSingle', [{
        tokenIn: tokenAddress, tokenOut: weth, fee: route.fee,
        recipient: ADDRESS_THIS, amountIn: raw,
        amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
      }]);
      const unwrapData = this.v3Router.interface.encodeFunctionData('unwrapWETH9', [minOut, this.wallet.address]);
      tx = await this.v3Router.multicall([swapData, unwrapData], { gasLimit: this.cfg.gasLimitSwap });
    } else {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      tx = await this.v2Router.swapExactTokensForETHSupportingFeeOnTransferTokens(
        raw, minOut, [tokenAddress, weth], this.wallet.address, deadline,
        { gasLimit: this.cfg.gasLimitSwap }
      );
    }
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`sell tx revert: ${tx.hash}`);

    // Compute actual ETH received (balance delta), accounting for gas spent.
    // ⚠️ Swap SUDAH sukses di titik ini — jangan pernah throw.
    // Jika query saldo setelah swap gagal (RPC down/timeout), fallback ke quote.
    let receivedNative;
    try {
      const ethAfter = await this.provider.getBalance(this.wallet.address);
      const gasUsed = receipt.gasUsed * receipt.gasPrice;  // ethers v6: gasUsed and gasPrice are bigints
      receivedNative = Number(ethers.formatEther(ethAfter - ethBefore + gasUsed));
    } catch (e) {
      // Fallback: pakai quote outAmount (tanpa koreksi gas — estimasi terbaik)
      receivedNative = Number(ethers.formatEther(route.out));
      log.warn(`[${this.key}] gagal baca saldo ETH setelah swap, fallback ke quote: ${receivedNative.toFixed(6)} ETH (${e.message})`);
    }

    log.info(`SELL [${this.key}] ${pct}% ${tokenAddress.slice(0, 8)} via ${route.kind} tx ${tx.hash} → ${receivedNative.toFixed(6)} ETH`);
    return { txid: tx.hash, soldRaw: raw, receivedNative };
  }
}
