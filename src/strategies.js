/**
 * Strategy profiles — loaded from strategy.json (project root, user-editable,
 * gitignored — copy strategy.example.json to get started).
 *
 * Each strategy (including "myself") is fully self-contained: section,
 * complete screener.filters, llmEnabled, darwinEnabled, autoEvolve. No
 * partial-override/merge with a base config — this avoids fields silently
 * leaking in from elsewhere (the class of bug that motivated this rewrite).
 *
 * Management variables (TP, SL, trailing, position size, LLM model/tuning,
 * Darwin population/mutation tuning) stay in live-config.json and are NEVER
 * touched here — only screener.filters/section + llm.enabled + darwin.enabled
 * + darwin.autoEvolve are strategy-owned.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const STRATEGY_FILE = path.join(ROOT_DIR, 'strategy.json');

const log = createLogger('strategies');

// Bootstrap default — written to strategy.json on first run if the file is
// missing, mirroring live-config.json's ensureConfigFiles() pattern.
const DEFAULT_STRATEGIES = {
  myself: {
    section: 'completed',
    llmEnabled: true,
    darwinEnabled: true,
    autoEvolve: false,
    filters: {
      launchpads: ['Pump.fun', 'Moonshoot', 'Bonk', 'Bags', 'Believe', 'Liquid'],
      minVolume24h: 30000, maxVolume24h: null,
      minLiquidity: 15000, maxLiquidity: null,
      minMarketCap: 15000, maxMarketCap: 20000000,
      minHolders: 150, maxHolders: null,
      minSwaps24h: 200, maxSwaps24h: null,
      minAgeMinutes: 60, maxAgeMinutes: 5760,
      minProgress: 0, maxProgress: 100,
      maxRugRatio: 0.3, maxBundlerRate: 0.9, maxInsiderRate: 0.3,
      minTotalFee: null, maxTotalFee: null,
      maxBotDegenRate: null, maxTop10HolderRate: 45, maxDevHoldRate: 10,
      minSmartDegenCount: null, maxFreshWalletRate: null,
      blockHoneypot: true, blockWashTrading: true,
    },
  },
  sniper: {
    section: 'new_creation',
    llmEnabled: true,
    darwinEnabled: false,
    autoEvolve: false,
    filters: {
      launchpads: null,
      minVolume24h: null, maxVolume24h: null,
      minLiquidity: null, maxLiquidity: null,
      minMarketCap: 7000, maxMarketCap: 200000,
      minHolders: null, maxHolders: null,
      minSwaps24h: null, maxSwaps24h: null,
      minAgeMinutes: 0, maxAgeMinutes: 60,
      minProgress: 0, maxProgress: 100,
      maxRugRatio: 0.3, maxBundlerRate: 0.5, maxInsiderRate: 0.3,
      minTotalFee: null, maxTotalFee: null,
      maxBotDegenRate: null, maxTop10HolderRate: 80, maxDevHoldRate: 20,
      minSmartDegenCount: null, maxFreshWalletRate: 0.9,
      blockHoneypot: true, blockWashTrading: true,
    },
  },
  degen: {
    section: 'new_creation',
    llmEnabled: true,
    darwinEnabled: false,
    autoEvolve: false,
    filters: {
      launchpads: null,
      minVolume24h: null, maxVolume24h: null,
      minLiquidity: null, maxLiquidity: null,
      minMarketCap: 5000, maxMarketCap: 100000,
      minHolders: null, maxHolders: null,
      minSwaps24h: null, maxSwaps24h: null,
      minAgeMinutes: 0, maxAgeMinutes: 60,
      minProgress: 0, maxProgress: 100,
      maxRugRatio: 0.5, maxBundlerRate: 0.7, maxInsiderRate: 0.5,
      minTotalFee: null, maxTotalFee: null,
      maxBotDegenRate: null, maxTop10HolderRate: 100, maxDevHoldRate: 40,
      minSmartDegenCount: null, maxFreshWalletRate: null,
      blockHoneypot: true, blockWashTrading: true,
    },
  },
  wait_for_dip: {
    section: 'completed',
    llmEnabled: true,
    darwinEnabled: true,
    autoEvolve: false,
    filters: {
      launchpads: ['Pump.fun', 'Moonshoot', 'Bonk', 'Bags', 'Believe', 'Liquid'],
      minVolume24h: 15000, maxVolume24h: null,
      minLiquidity: 18000, maxLiquidity: null,
      minMarketCap: 25000, maxMarketCap: 500000,
      minHolders: 150, maxHolders: null,
      minSwaps24h: 100, maxSwaps24h: null,
      minAgeMinutes: 30, maxAgeMinutes: 1440,
      minProgress: 0, maxProgress: 100,
      maxRugRatio: 0.3, maxBundlerRate: 0.9, maxInsiderRate: 0.3,
      minTotalFee: null, maxTotalFee: null,
      maxBotDegenRate: null, maxTop10HolderRate: 55, maxDevHoldRate: 10,
      minSmartDegenCount: null, maxFreshWalletRate: null,
      blockHoneypot: true, blockWashTrading: true,
    },
  },
  smart_money: {
    section: 'completed',
    llmEnabled: true,
    darwinEnabled: true,
    autoEvolve: false,
    filters: {
      launchpads: ['Pump.fun', 'Moonshoot', 'Bonk', 'Bags', 'Believe', 'Liquid'],
      minVolume24h: 25000, maxVolume24h: null,
      minLiquidity: 25000, maxLiquidity: null,
      minMarketCap: 30000, maxMarketCap: 1000000,
      minHolders: 1000, maxHolders: null,
      minSwaps24h: 100, maxSwaps24h: null,
      minAgeMinutes: 60, maxAgeMinutes: 1440,
      minProgress: 0, maxProgress: 100,
      maxRugRatio: 0.2, maxBundlerRate: 0.3, maxInsiderRate: 0.2,
      minTotalFee: null, maxTotalFee: null,
      maxBotDegenRate: null, maxTop10HolderRate: 50, maxDevHoldRate: 5,
      minSmartDegenCount: 2, maxFreshWalletRate: null,
      blockHoneypot: true, blockWashTrading: true,
    },
  },
};

export function strategyFilePath() {
  return STRATEGY_FILE;
}

/** Tulis strategy.json dgn default bootstrap kalau belum ada — dipanggil dari config.js:loadConfig(). */
export function ensureStrategyFile() {
  if (!fs.existsSync(STRATEGY_FILE)) {
    fs.writeFileSync(STRATEGY_FILE, JSON.stringify(DEFAULT_STRATEGIES, null, 2));
    log.info('strategy.json missing — created with default values');
  }
}

let strategies = DEFAULT_STRATEGIES;

/** Baca strategy.json dari disk. Dipanggil di setiap buildConfig() (mirip live/paper-config.json). */
export function loadStrategies() {
  try {
    strategies = JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8'));
  } catch (e) {
    log.error('strategy.json corrupted or unreadable, using bootstrap defaults:', e.message);
    strategies = DEFAULT_STRATEGIES;
  }
  return strategies;
}

export function getStrategies() {
  return strategies;
}

export function getStrategy(name) {
  return strategies[name];
}

/**
 * Apply a strategy's full config on top of a config clone.
 * Overrides (wholesale, self-contained — no partial merge):
 *   screener.filters, screener.section, llm.enabled, darwin.enabled, darwin.autoEvolve
 * Everything else (TP/SL/trailing/position size/LLM model/Darwin population
 * tuning) stays as-is from live-config.json.
 *
 * @param {object} config — fully merged config (DEFAULTS + JSON files)
 * @param {string} strategyName — key into strategy.json (e.g. "myself", "sniper", ...)
 * @returns {object} new config (shallow clone)
 */
export function applyStrategy(config, strategyName) {
  let strat = strategies[strategyName];
  if (!strat) {
    log.warn(`strategy "${strategyName}" not found in strategy.json, falling back to "myself"`);
    strat = strategies.myself;
  }
  if (!strat) return config; // strategy.json completely empty/corrupted — leave config untouched

  return {
    ...config,
    screener: {
      ...config.screener,
      filters: structuredClone(strat.filters),
      section: strat.section,
      source: 'gmgn',
    },
    llm: { ...config.llm, enabled: strat.llmEnabled },
    darwin: { ...config.darwin, enabled: strat.darwinEnabled, autoEvolve: strat.autoEvolve },
  };
}
