/**
 * Strategy presets — pre-configured filter profiles for different trading styles.
 *
 * Each preset ONLY overrides screener.filters.* fields that GMGN can actually
 * provide. Management variables (TP, SL, trailing, position size, LLM settings,
 * max positions, max hold) stay in the config file and are NEVER touched here.
 *
 * Strategy "myself" = full config.json control, no overrides.
 */

// Mapping: strategy preset field → config screener.filters key
const FIELD_MAP = {
  min_mcap_usd: 'minMarketCap',
  max_mcap_usd: 'maxMarketCap',
  token_age_max_ms: 'maxAgeMinutes',           // ms → minutes conversion
  min_holders: 'minHolders',                   // 0 = disabled (null)
  max_top20_holder_percent: 'maxTop10HolderRate', // 100 = no filter
  trending_min_volume_usd: 'minVolume24h',      // 0 = disabled (null)
  trending_min_swaps: 'minSwaps24h',            // 0 = disabled (null)
  trending_max_rug_ratio: 'maxRugRatio',
  trending_max_bundler_rate: 'maxBundlerRate',
};

// Strategy preset values — only the 9 screening filter fields above.
// All other config (trading, trailing, LLM, monitor, etc.) comes from the config file.
export const PRESETS = {
  sniper: {
    // Low-cap gems just created, highest risk/reward
    min_mcap_usd: 7000,
    max_mcap_usd: 200000,
    token_age_max_ms: 3_600_000,          // 60 min max age
    min_holders: 0,                        // no minimum
    max_top20_holder_percent: 100,         // no holder concentration filter
    trending_min_volume_usd: 0,            // no volume floor
    trending_min_swaps: 0,                 // no swaps floor
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
  },
  wait_for_dip: {
    // Established tokens that may have dipped, moderate risk
    min_mcap_usd: 25000,
    max_mcap_usd: 500000,
    token_age_max_ms: 86_400_000,          // 24h max age
    min_holders: 0,
    max_top20_holder_percent: 100,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
  },
  smart_money: {
    // Follow smart money — high holder count, strong volume, low risk
    min_mcap_usd: 10000,
    max_mcap_usd: 1_000_000,
    token_age_max_ms: 86_400_000,          // 24h max age
    min_holders: 1000,                      // high holder requirement
    max_top20_holder_percent: 50,           // tight concentration cap
    trending_min_volume_usd: 5000,          // require real volume
    trending_min_swaps: 100,                // require real activity
    trending_max_rug_ratio: 0.2,            // stricter
    trending_max_bundler_rate: 0.3,         // stricter
  },
  degen: {
    // Ultra-aggressive, widest risk tolerances
    min_mcap_usd: 5000,
    max_mcap_usd: 100000,
    token_age_max_ms: 3_600_000,           // 60 min max age
    min_holders: 0,
    max_top20_holder_percent: 100,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.5,            // loose
    trending_max_bundler_rate: 0.7,         // loose
  },
};

/**
 * Apply a strategy preset's filter overrides on top of a deep-cloned config.
 * Only screener.filters.* fields are touched — everything else stays as-is.
 *
 * @param {object} config — fully merged config (DEFAULTS + JSON files)
 * @param {string} strategyName — "myself" | "sniper" | "wait_for_dip" | "smart_money" | "degen"
 * @returns {object} new config (shallow clone, filters replaced)
 */
export function applyStrategy(config, strategyName) {
  if (!strategyName || strategyName === 'myself') return config;

  const preset = PRESETS[strategyName];
  if (!preset) return config;

  // Shallow clone + replace filters with a new object
  const merged = {
    ...config,
    screener: {
      ...config.screener,
      filters: { ...config.screener.filters },
    },
  };

  for (const [stratField, value] of Object.entries(preset)) {
    const configKey = FIELD_MAP[stratField];
    if (!configKey) continue;

    if (stratField === 'token_age_max_ms') {
      merged.screener.filters[configKey] = Math.round(value / 60_000);
    } else if (stratField.endsWith('_usd') || stratField === 'max_top20_holder_percent') {
      merged.screener.filters[configKey] = value;
    } else if (stratField.startsWith('trending_min_') || stratField === 'min_holders') {
      // 0 means "no minimum" — disable the filter
      merged.screener.filters[configKey] = value === 0 ? null : value;
    } else {
      merged.screener.filters[configKey] = value;
    }
  }

  return merged;
}
