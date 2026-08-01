# snipra v2 — Solana Meme Sniper

Bot automation memecoin untuk **Solana**. (Versi Robinhood Chain/EVM sudah diekstrak ke
proyek terpisah — lihat `robinhood/` sebelum dipindahkan keluar dari root ini.)

## Mode: paper vs live

- **`paper` (default)** — papertest: trade berjalan persis seperti live (screening → open posisi → TP ladder/trailing/SL → close) memakai harga real-time + simulasi slippage, tapi dengan **saldo virtual** (`paper.startBalance`), tanpa menyentuh saldo on-chain. Semua trade yang close dicatat ke **SQLite** (`data/snipra.db`, tabel `trades`) lengkap dengan PnL. Darwin & LLM tetap belajar dari hasilnya.
- **`live`** — transaksi on-chain sungguhan (Jupiter/GMGN di Solana).

Ganti via `config.json` → `"mode"` atau Telegram `/mode paper|live`. Lihat hasil papertest: `/papertrades`, reset saldo virtual: `/paperreset`.

## Fitur

| # | Fitur | Implementasi |
|---|-------|--------------|
| 1 | Screening meme Solana | DexScreener (discovery + data pair) + GoPlus (holders, honeypot, tax) |
| 2 | Swap SOL↔meme | **Jupiter** lite-api (opsional **GMGN** trading API) |
| 3 | TP Ladder | Tier bertingkat, `sellPct` dihitung dari sisa posisi |
| 4 | Trailing profit | Aktif setelah `activateGainPct`, jual semua saat turun `trailPct` dari puncak |
| 5 | Telegram | Semua config bisa diubah via `/set`, posisi & PnL dipantau real-time |
| 6 | Darwin system | Populasi genome filter → fitness dari PnL trade → seleksi + crossover + mutasi otomatis |
| 7 | LLM | OpenRouter / DeepSeek — gate sebelum buy + lessons post-mortem yang diinject balik ke prompt |

## Filter Screening (wajib + tambahan)

Wajib: `minVolume24hUsd`, `minAgeMinutes`/`maxAgeHours`, `minLiquidityUsd`, `minMarketCapUsd`/`maxMarketCapUsd`, `minHolders`, `minTraders24h`.
Tambahan: buy/sell ratio, anti-dump 1 jam, rasio volume/likuiditas, socials, honeypot/freezable (GoPlus), buy/sell tax maksimum.

Parameter numerik filter **dievolusi otomatis** oleh Darwin system; filter security tidak pernah dilonggarkan oleh evolusi.

## Konfigurasi

Semua setting ada di **`config.json` di root project** — edit langsung dengan editor apa pun, atau ubah runtime via Telegram `/set` (perubahan dipersist balik ke file yang sama). Field yang tidak ada di file otomatis memakai nilai default.

## Setup

```bash
npm install
cp .env.example .env   # isi kunci-kunci
# sesuaikan config.json bila perlu
npm run dev            # DRY RUN (default, aman)
```

Minimal yang perlu diisi di `.env`:
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — buat bot via @BotFather
- `SOLANA_PRIVATE_KEY` — hanya untuk mode live
- `OPENROUTER_API_KEY` atau `DEEPSEEK_API_KEY` — hanya jika `llm.enabled=true`

Coba screening tanpa menjalankan bot penuh:

```bash
npm run screen
```

## Go live

```bash
# 1. Jalankan papertest dulu sampai win rate & PnL meyakinkan (/papertrades)
# 2. Ganti mode:
#    - config.json: "mode": "live", atau
#    - telegram: /mode live
npm start
```

⚠️ **Mulai dengan nominal kecil** (`chains.solana.buyAmount`). Memecoin sangat berisiko — bot ini bukan jaminan profit.

## Perintah Telegram

`/status` `/config` `/get` `/set` `/screen` `/buy` `/sell` `/positions` `/stats` `/papertrades` `/paperreset` `/pause` `/resume` `/mode` `/darwin` `/evolve` `/lessons` `/logs` `/stop`

Contoh ubah config runtime:

```
/set screener.filters.minLiquidityUsd 30000
/set trailing.trailPct 15
/set tpLadder [{"gainPct":50,"sellPct":30},{"gainPct":150,"sellPct":50}]
/set llm.enabled true
```

## Chain aktif

- **Solana** — dexscreenerId `solana`, executor Jupiter (atau GMGN).

## Arsitektur

```
src/
  index.js              # wiring, screening loop, auto-buy, graceful shutdown
  config.js             # config + persist + /set path
  screener/
    dexscreener.js      # discovery + data pair + batch harga
    goplus.js           # holders + honeypot + tax (Solana)
    filters.js          # evaluasi filter + scoring
    screener.js         # orkestrasi (darwin genome + LLM gate)
  chains/
    solana.js           # Jupiter (default) / GMGN executor
  trade/executor.js     # interface buy/sell lintas mode (paper/live)
  trade/paper.js        # paper engine: saldo virtual, fill harga real + slippage
  db.js                 # SQLite: riwayat trades, paper wallet & holdings
  positions/
    state.js            # persist posisi, cooldown, stats
    manager.js          # monitor: TP ladder → trailing → stop loss → reconcile on-chain
  darwin/darwin.js      # evolusi genome filter
  llm/llm.js            # OpenRouter/DeepSeek: gate + lessons
  telegram/bot.js       # command handler
config.paper.json       # config mode paper (root, editable)
config.live.json        # config mode live (root, editable)
data/                   # snipra.db (SQLite), positions.*.json, darwin.json, lessons.json
```

## Sumber API (docs resmi)

- DexScreener: `https://docs.dexscreener.com/api/reference`
- Jupiter Swap: `https://developers.jup.ag` (lite-api gratis: `lite-api.jup.ag/swap/v1`)
- GMGN Cooperation API: `https://docs.gmgn.ai` (butuh approval, header `x-route-key`)
- GoPlus Security: `https://api.gopluslabs.io`
