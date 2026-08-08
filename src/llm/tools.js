/**
 * Definisi + eksekutor tool LLM, dipakai bersama oleh standalone (src/index.js,
 * lewat Telegram chat-tool-calling) dan skill mode (src/skills/runner.js, lewat
 * command queue). Diekstrak supaya kedua entry point tidak lagi punya salinan
 * inline yang bisa ngedrift (lihat docs/superpowers/specs/2026-08-03-skill-mode-agent-control-design.md).
 */
export const LLM_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_positions',
      description: 'Get the current list of open positions + PnL + moonbag.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screen_now',
      description: 'Run one screening cycle now and immediately buy candidates that pass.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy_token',
      description: 'Buy a token. Needs chain and address; amount optional (native SOL).',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['solana'] },
          address: { type: 'string' },
          amount: { type: 'number', description: 'optional native amount; empty = default buyAmount' },
        },
        required: ['chain', 'address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sell_token',
      description: 'Sell a position/moonbag by token address. pct defaults to 100.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          pct: { type: 'number', description: 'percent of holdings 1-100' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_all_positions',
      description: 'Close ALL open positions now.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const LLM_TOOL_NAMES = new Set(LLM_TOOL_DEFS.map((d) => d.function.name));

export function inferChain(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? 'solana' : null;
}

/**
 * deps.screeningCycle dan deps.closeAllPositions HARUS thunk (mis. `(force) =>
 * screeningCycle(force)`), bukan nilai langsung — di kedua caller (index.js,
 * runner.js), const `screeningCycle`/`positionManager` didefinisikan SETELAH
 * titik di mana createToolRunner(...) perlu dipanggil, jadi thunk memastikan
 * binding di-resolve saat tool benar-benar dipanggil, bukan saat construct.
 */
export function createToolRunner(deps) {
  const { openPositions, currentPnlPct, moonbags, buyToken, sellToken, executor, onTradeClosed, screeningCycle, closeAllPositions } = deps;
  return async function runLlmTool(name, args) {
    switch (name) {
      case 'get_positions': {
        const pos = openPositions().map((p) => ({
          chain: p.chain, symbol: p.symbol, address: p.address,
          pnlPct: +currentPnlPct(p).toFixed(1), remainingPct: p.remainingPct,
        }));
        return { openCount: pos.length, positions: pos, moonbags: moonbags().length };
      }
      case 'screen_now': {
        await screeningCycle(true);
        return { ok: true, note: 'screening triggered; results sent as a separate notification' };
      }
      case 'buy_token': {
        const chain = args.chain || inferChain(args.address);
        if (!chain) return { error: 'unknown chain' };
        const pos = await buyToken(chain, args.address, args.amount, 'llm-tool', null, executor);
        return { ok: true, symbol: pos.symbol, chain, entryPrice: pos.entryPrice, tx: pos.txid };
      }
      case 'sell_token': {
        const res = await sellToken(args.address, args.pct ?? 100, executor, onTradeClosed);
        return { ok: true, receivedNative: res.receivedNative, tx: res.txid };
      }
      case 'close_all_positions': {
        const results = await closeAllPositions('llm-tool');
        return { ok: true, closed: results.filter((r) => !r.error).length, results };
      }
      default:
        return { error: `unknown tool: ${name}` };
    }
  };
}
