import fs from 'fs';
import path from 'path';
import { DATA_DIR, getConfig } from '../config.js';
import { clamp, randBetween, pick } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('darwin');
const FILE = path.join(DATA_DIR, 'darwin.json');

/**
 * Gen yang dievolusi + range mutasinya.
 * Hanya parameter numerik screening — filter security tetap hard-coded aman.
 */
export const GENE_SPACE = {
  minVolume24h: { min: 5000, max: 500000, sigma: 0.25 },
  minLiquidity: { min: 5000, max: 200000, sigma: 0.25 },
  minMarketCap: { min: 10000, max: 1000000, sigma: 0.3 },
  maxMarketCap: { min: 500000, max: 50000000, sigma: 0.3 },
  minHolders: { min: 50, max: 2000, sigma: 0.3 },
  minSwaps24h: { min: 50, max: 2000, sigma: 0.3 },
  minAgeMinutes: { min: 1, max: 720, sigma: 0.3 },
  maxAgeMinutes: { min: 720, max: 20160, sigma: 0.25 },
  minProgress: { min: 0, max: 0.9, sigma: 0.2 },
  maxProgress: { min: 0.1, max: 1, sigma: 0.2 },
  maxRugRatio: { min: 0.1, max: 0.9, sigma: 0.2 },
  maxBundlerRate: { min: 0.05, max: 0.8, sigma: 0.2 },
  maxInsiderRate: { min: 0.05, max: 0.8, sigma: 0.2 },
  maxTop10HolderRate: { min: 0.1, max: 0.95, sigma: 0.15 },
  maxBotDegenRate: { min: 0.05, max: 0.5, sigma: 0.2 },
  maxFreshWalletRate: { min: 0.1, max: 0.9, sigma: 0.2 },
  maxDevHoldRate: { min: 0.01, max: 0.5, sigma: 0.2 },
  maxTotalFee: { min: 0.1, max: 100, sigma: 0.3 },
  minSmartDegenCount: { min: 0, max: 10, sigma: 0.3 },
  stopLossPct: { min: -60, max: -15, sigma: 0.2 },
  trailingActivateGainPct: { min: 5, max: 40, sigma: 0.25 },
  trailingTrailPct: { min: 3, max: 15, sigma: 0.25 },
};

export const GENE_CONFIG_PATH = {
  minVolume24h: 'screener.filters.minVolume24h',
  minLiquidity: 'screener.filters.minLiquidity',
  minMarketCap: 'screener.filters.minMarketCap',
  maxMarketCap: 'screener.filters.maxMarketCap',
  minHolders: 'screener.filters.minHolders',
  minSwaps24h: 'screener.filters.minSwaps24h',
  minAgeMinutes: 'screener.filters.minAgeMinutes',
  maxAgeMinutes: 'screener.filters.maxAgeMinutes',
  minProgress: 'screener.filters.minProgress',
  maxProgress: 'screener.filters.maxProgress',
  maxRugRatio: 'screener.filters.maxRugRatio',
  maxBundlerRate: 'screener.filters.maxBundlerRate',
  maxInsiderRate: 'screener.filters.maxInsiderRate',
  maxTop10HolderRate: 'screener.filters.maxTop10HolderRate',
  maxBotDegenRate: 'screener.filters.maxBotDegenRate',
  maxFreshWalletRate: 'screener.filters.maxFreshWalletRate',
  maxDevHoldRate: 'screener.filters.maxDevHoldRate',
  maxTotalFee: 'screener.filters.maxTotalFee',
  minSmartDegenCount: 'screener.filters.minSmartDegenCount',
  stopLossPct: 'trading.stopLossPct',
  trailingActivateGainPct: 'trailing.activateGainPct',
  trailingTrailPct: 'trailing.trailPct',
};

export function readGeneBaseline(cfg, name) {
  return GENE_CONFIG_PATH[name].split('.').reduce((o, k) => o?.[k], cfg);
}

function mutateGene(name, value, mutationRate) {
  const spec = GENE_SPACE[name];
  if (!spec || Math.random() > mutationRate) return value;
  const factor = 1 + randBetween(-spec.sigma, spec.sigma);
  return clamp(Math.round(value * factor * 100) / 100, spec.min, spec.max);
}

let db = {
  generation: 1,
  genomes: [], // { id, genes, trades: number, totalPnlPct: number, born: generation }
  tradesSinceEvolve: 0,
  history: [], // ringkasan tiap generasi
};

export class Darwin {
  load() {
    if (fs.existsSync(FILE)) {
      try {
        db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        log.info(`darwin loaded: gen ${db.generation}, ${db.genomes.length} genomes`);
      } catch (e) {
        log.error('darwin.json corrupted:', e.message);
      }
    }
    if (db.genomes.length === 0) this._seed();
    return this;
  }

  _persist() {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  }

  _seed() {
    const cfg = getConfig();
    const n = cfg.darwin.populationSize;
    db.genomes = [];
    // Genome 0 = baseline persis config; sisanya mutasi acak dari baseline
    for (let i = 0; i < n; i++) {
      const genes = {};
      for (const name of Object.keys(GENE_SPACE)) {
        const baseVal = readGeneBaseline(cfg, name) ?? (GENE_SPACE[name].min + GENE_SPACE[name].max) / 2;
        genes[name] = i === 0 ? baseVal : mutateGene(name, baseVal, 1.0);
      }
      db.genomes.push(this._newGenome(genes));
    }
    this._persist();
    log.info(`darwin seeded: ${n} genomes`);
  }

  _newGenome(genes) {
    return {
      id: `g${db.generation}-${Math.random().toString(36).slice(2, 7)}`,
      genes,
      trades: 0,
      totalPnlPct: 0,
      born: db.generation,
    };
  }

  fitness(g) {
    const { minTradesForFitness } = getConfig().darwin;
    if (g.trades === 0) return 0;
    // Use EMA when available for recency-weighted fitness;
    // fall back to simple average for genomes from older darwin.json
    const avg = g._emaPnlPct != null ? g._emaPnlPct : (g.totalPnlPct / g.trades);
    // Penalti sampel kecil: genome dg sedikit trade belum terbukti
    const confidence = Math.min(g.trades / minTradesForFitness, 1);
    return avg * confidence;
  }

  /** Pilih genome utk siklus screening: epsilon-greedy explore/exploit */
  pickGenome() {
    const { exploreRate } = getConfig().darwin;
    const untested = db.genomes.filter((g) => g.trades === 0);
    if (untested.length > 0 && Math.random() < 0.5) return pick(untested);
    if (Math.random() < exploreRate) return pick(db.genomes);
    return [...db.genomes].sort((a, b) => this.fitness(b) - this.fitness(a))[0];
  }

  getGenome(id) {
    return db.genomes.find((g) => g.id === id);
  }

  /**
   * Dipanggil tiap trade close — update fitness.
   * Return true bila kuota evolveEveryNTrades tercapai (orchestrator yang
   * memutuskan evolve, karena bisa melibatkan LLM async).
   */
  recordTrade(trade) {
    if (!trade.genomeId) return false;
    const g = this.getGenome(trade.genomeId);
    if (g) {
      g.trades += 1;
      g.totalPnlPct += trade.finalPnlPct;
      // EMA (exponential moving average) for recency-weighted fitness.
      // Alpha = 0.2 gives ~80% weight to the last ~10 trades,
      // preventing historically-great genomes from dominating when
      // market regime shifts.
      if (g._emaPnlPct == null) g._emaPnlPct = trade.finalPnlPct;
      else g._emaPnlPct = g._emaPnlPct * 0.8 + trade.finalPnlPct * 0.2;
    }
    db.tradesSinceEvolve += 1;
    this._persist();
    const every = getConfig().darwin.evolveEveryNTrades;
    if (!every || every <= 0) return false; // 0/null = auto-evolve disabled
    return db.tradesSinceEvolve >= every;
  }

  /** Reset penghitung kuota evolve (dipanggil setelah usulan dikirim). */
  resetEvolveCounter() {
    db.tradesSinceEvolve = 0;
    this._persist();
  }

  /** Genome fitness tertinggi yang sudah cukup teruji (>= minTradesForFitness). */
  bestProven() {
    const { minTradesForFitness } = getConfig().darwin;
    const proven = db.genomes.filter((g) => g.trades >= minTradesForFitness);
    if (proven.length === 0) return null;
    return [...proven].sort((a, b) => this.fitness(b) - this.fitness(a))[0];
  }

  /** clamp nilai gen ke range GENE_SPACE (dipakai juga utk usulan LLM) */
  _clampGene(name, value) {
    const spec = GENE_SPACE[name];
    if (!spec || typeof value !== 'number' || isNaN(value)) return null;
    return clamp(value, spec.min, spec.max);
  }

  /**
   * Satu generasi evolusi: elitism + seleksi paruh atas + crossover + mutasi.
   * injectGenes: array set-gen usulan LLM — masuk sebagai genome "guided"
   * menggantikan offspring acak terakhir (dibatasi 2).
   * Return ringkasan utk notifikasi.
   */
  evolve({ injectGenes = [] } = {}) {
    const fullCfg = getConfig();
    const cfg = fullCfg.darwin;
    const ranked = [...db.genomes].sort((a, b) => this.fitness(b) - this.fitness(a));
    const survivors = ranked.slice(0, Math.max(2, Math.floor(ranked.length / 2)));
    const best = ranked[0];

    const next = [];
    // Elite: juara bertahan tidak diubah
    next.push(best);

    // Genome "guided" dari LLM (max 2), gen di-clamp ke GENE_SPACE.
    // Batas keras config user tetap ditegakkan saat screening (mergeGenome).
    for (const genes of injectGenes.slice(0, 2)) {
      if (next.length >= cfg.populationSize) break;
      const base = { ...best.genes };
      for (const [name, val] of Object.entries(genes)) {
        const clamped = this._clampGene(name, Number(val));
        if (clamped != null) base[name] = clamped;
      }
      const g = this._newGenome(base);
      g.llmGuided = true;
      next.push(g);
    }

    while (next.length < cfg.populationSize) {
      const a = pick(survivors);
      const b = pick(survivors);
      const genes = {};
      for (const name of Object.keys(GENE_SPACE)) {
        const inherited = (Math.random() < 0.5 ? a.genes[name] : b.genes[name])
          ?? readGeneBaseline(fullCfg, name)
          ?? (GENE_SPACE[name].min + GENE_SPACE[name].max) / 2;
        genes[name] = mutateGene(name, inherited, cfg.mutationRate);
      }
      next.push(this._newGenome(genes));
    }

    const summary = {
      generation: db.generation,
      bestId: best.id,
      bestFitness: this.fitness(best),
      bestAvgPnl: best.trades > 0 ? best.totalPnlPct / best.trades : 0,
      bestTrades: best.trades,
      survivors: survivors.map((g) => ({ id: g.id, fitness: this.fitness(g), trades: g.trades })),
    };
    db.history.push(summary);
    if (db.history.length > 100) db.history = db.history.slice(-100);
    db.generation += 1;
    db.genomes = next;
    db.tradesSinceEvolve = 0;
    this._persist();
    log.info(`EVOLVED → gen ${db.generation}, best ${best.id} fitness ${summary.bestFitness.toFixed(2)}`);
    return summary;
  }

  status() {
    const ranked = [...db.genomes].sort((a, b) => this.fitness(b) - this.fitness(a));
    return {
      generation: db.generation,
      tradesSinceEvolve: db.tradesSinceEvolve,
      genomes: ranked.map((g) => ({
        id: g.id,
        fitness: this.fitness(g),
        trades: g.trades,
        avgPnl: g.trades > 0 ? g.totalPnlPct / g.trades : 0,
        genes: g.genes,
      })),
      lastEvolution: db.history[db.history.length - 1] || null,
    };
  }
}
