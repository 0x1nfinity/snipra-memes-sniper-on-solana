# Bug Report — End-to-End Codebase Audit

## Date
2026-08-08

## Metode
Audit menyeluruh seluruh `src/` (screener, positions, trade, llm, darwin, telegram, db, config, utils) via 4 agent paralel per-subsistem, tiap temuan diverifikasi ulang manual dengan membaca kode aslinya sebelum dicatat di sini. Status semua: **belum diperbaiki** (dokumentasi saja, sesuai permintaan).

---

# 1. Darwin GENE_SPACE unit mismatch — genome bisa membunuh hampir semua kandidat

## Status
✅ **FIXED** (2026-08-08) — `minProgress`/`maxProgress`/`maxTop10HolderRate`/`maxDevHoldRate` di `GENE_SPACE` (`darwin.js`) diubah ke skala persentase 0-100, konsisten dengan `config.js` & `filters.js:evaluate()`.

## Severity
**High** — aktif secara default (`darwin.enabled: true`), dan sekarang makin sering ke-trigger karena GMGN path juga sudah pakai client-side `evaluate()` (fix hari ini).

## Root Cause
`darwin.js:GENE_SPACE` mendefinisikan beberapa gen dalam skala fraksi 0-1:
```js
maxTop10HolderRate: { min: 0.1, max: 0.95, sigma: 0.15 },
maxDevHoldRate:     { min: 0.01, max: 0.5, sigma: 0.2 },
minProgress:        { min: 0, max: 0.9, sigma: 0.2 },
maxProgress:        { min: 0.1, max: 1, sigma: 0.2 },
```
Tapi field yang sama di `config.js` default & yang dibaca `evaluate()` (`filters.js`) memakai skala persentase 0-100:
```js
maxTop10HolderRate: 85,
minProgress: 0,   // bonding curve % (0-100)
maxProgress: 100,
```
dan `c.top10HolderRate` / `c.devHoldRate` / `c.bondingProgress` (`gmgn-discovery.js:108-115`) semua dikali 100 saat normalisasi (skala persentase juga).

`mergeGenome()` (`screener.js`) memakai `Math.min(baseFilters[f], genes[f])` untuk field MAX (dan `Math.max` untuk MIN). Karena genes ada di skala 0-1 sedangkan baseFilters di skala 0-100, hasil merge selalu didominasi nilai genome yang jauh lebih kecil — mis. `maxTop10HolderRate` merged jadi ~0.95 padahal candidate asli punya `top10HolderRate` puluhan persen → SELALU gagal filter. Sama untuk `maxProgress` (merged ~1, padahal bondingProgress asli jauh di atas 1).

## Dampak
~7/8 genome hasil seed (`_seed()` mutasi rate=1.0 dari baseline) kena mismatch ini. `pickGenome()` memilih genome "untested" 50% kesempatan tiap siklus screening → mayoritas siklus screening pakai genome yang secara efektif menolak semua kandidat via client-side filter, meski server-side (GMGN) tetap pakai `baseFilters` yang benar. Rejection log akan terlihat generik ("top10 55% > 0.95%") — mudah terlewat karena kelihatan seperti kandidat memang buruk, bukan bug unit.

## Fix yang disarankan
Samakan skala: baik ubah `GENE_SPACE` untuk 4 gen ini ke skala 0-100 (konsisten dgn config & candidate), atau normalisasi di `mergeGenome`/`evaluate()` sebelum dibandingkan. `minProgress`/`maxProgress` juga kena masalah yang sama.

---

# 2. `buildServerFilters` tidak konversi `maxDevHoldRate` ke fraksi utk GMGN API

## Status
✅ **FIXED** (2026-08-08) — `gmgn-discovery.js:buildServerFilters()` sekarang juga membagi `max_creator_balance_rate` dgn 100, pola sama seperti `max_top_holder_rate`.

## Severity
Medium — default `maxDevHoldRate: null` (tidak aktif), tapi begitu user set nilai atau genome mengisinya, request server-side ke GMGN salah skala.

## Root Cause
`gmgn-discovery.js:buildServerFilters()` mengonversi `max_top_holder_rate` dari persen ke fraksi sebelum kirim ke GMGN:
```js
if (server.max_top_holder_rate != null) server.max_top_holder_rate = server.max_top_holder_rate / 100;
```
Tapi `max_creator_balance_rate` (dari `maxDevHoldRate`) TIDAK dapat perlakuan sama, padahal field mentahnya (`raw.dev_team_hold_rate`) di-scale `*100` persis seperti `top_10_holder_rate` — indikasi kuat GMGN API mengharapkan fraksi 0-1 juga utk field ini.

## Fix yang disarankan
Tambahkan `server.max_creator_balance_rate = server.max_creator_balance_rate / 100` dgn pola sama seperti `max_top_holder_rate`.

---

# 3. `maxBuyThisCycle` bisa 0/negatif saat force-screening dengan posisi penuh — blokir semua buy walau slot terbuka di tengah siklus

## Status
✅ **FIXED** (2026-08-08) — `loops.js`: `maxBuyThisCycle` sekarang `availSlots > 0 ? Math.min(availSlots, candidates.length) : candidates.length` — kalau `availSlots<=0` di awal (hanya reachable via `force=true`), cap awal di-skip sepenuhnya, fallback ke cek real-time (`openPositions().length >= effMax`) yang sudah ada di loop.

## Severity
Low-Medium — hanya kena saat `/screen` manual (`force=true`) dijalankan ketika posisi sedang penuh.

## Root Cause
`loops.js:screeningCycle()` — early-return "positions full" (baris ~56) di-skip kalau `force=true`. Tapi `maxBuyThisCycle = Math.min(availSlots, candidates.length)` (baris ~78) tetap dihitung dari `availSlots` yang bisa ≤0 di titik itu. Akibatnya `bought.length >= maxBuyThisCycle` (0) langsung true utk kandidat pertama → semua kandidat ditolak "cycle buy limit reached", walau posisi lain ditutup monitor loop di tengah siklus dan real-time check (`openPositions().length >= effMax`) seharusnya lolos.

## Fix yang disarankan
Kalau `availSlots <= 0` tapi `force=true`, jangan pakai `Math.min(availSlots, ...)` sbg hard cap di awal — biarkan cap dievaluasi ulang tiap iterasi berdasarkan `effMax - openPositions().length` real-time, atau set floor minimum 0 dan skip logic limitnya sepenuhnya kalau `availSlots<=0` di awal (fallback ke real-time check saja).

---

# 4. Race condition: posisi bisa di-close dua kali (double-close / double-count stats)

## Status
✅ **FIXED** (2026-08-08) — Idempotency guard ditambahkan di awal `closePosition()` (`state.js`): return `null` kalau `pos` sudah tidak ada di `state.open`. Semua caller (`manager.js` reconcile/TP-ladder/_closeAll, `trade/helpers.js` sellToken) diupdate untuk skip notify/`onTradeClosed` kalau `trade` null. Ditemukan & ditutup juga jalur ke-5 yang terlewat di audit awal: `moveToMoonbag()` (`state.js`) memanggil `closePosition()` internal tanpa cek return-nya — ditambahkan guard yang sama + caller (`manager.js:_exitToMoonbag`) diupdate skip notify kalau `null`. Mencegah double-count stats/trade records meski race timing-nya sendiri (bug sekunder `closeAllPositions()` busy-wait non-atomik) belum dieliminasi — sesuai catatan di root cause section, guard ini cukup untuk mencegah kerusakan data.

## Severity
**High** — tidak butuh timing yang aneh, cukup user menjalankan `/sell` atau `/status` manual saat monitor loop sedang eksekusi swap utk token yang sama.

## Root Cause
`PositionManager.tick()` (`manager.js:101-111`) pakai flag `_busy` sbg lock supaya tidak overlap dgn dirinya sendiri. Tapi dua jalur lain memanggil operasi yang memutasi/menutup posisi yang sama TANPA cek/set `_busy` sama sekali:
- `reconcileNow()` (`manager.js:63-65`, dipanggil dari `/status` & `/positions`) → `_reconcileAll()` → bisa memanggil `closePosition()`.
- `sellToken()` (`trade/helpers.js`, dipanggil dari `/sell` & LLM tool `sell`) → bisa memanggil `closePosition()`.

Karena `executor.sell()` di dalam `_applyRules()` (TP ladder/trailing/SL) itu `await`ed (round-trip RPC/HTTP), event loop bebas menjalankan `/sell` atau `/status` manual di tengah-tengah, beroperasi di objek `pos` yang sama yang masih ada di `state.open`. Kalau jalur manual selesai duluan dan memanggil `closePosition(pos, ...)`, lalu `tick()` melanjutkan dan JUGA memanggil `closePosition(pos, ...)` pada objek yang sama:

`state.js:closePosition()` (baris 194-232) TIDAK ADA guard idempotency — tidak cek apakah `pos` masih ada di `state.open` sebelum jalan. Akibatnya kalau dipanggil dua kali pada posisi yang sama: `state.stats.totalTrades`/`wins`/`losses`/`totalPnlPct` ke-increment DUA KALI, record trade duplikat masuk ke `state.closed` dan SQLite (`recordTradeDb`), `recordCooldown` dipanggil dua kali — merusak win-rate, riwayat trade, dan data training Darwin (`onTradeClosed` → `darwin.recordTrade`).

Bug sekunder terkait: `closeAllPositions()` (`manager.js:352-371`) busy-wait `while (this._busy) await sleep(200)` lalu set `this._busy = true` — dua baris terpisah, bukan atomik. `setInterval`'s `tick()` bisa fire tepat di celah itu dan juga lolos cek `_busy===false`, jalan bareng. Window sempit tapi bukan nol.

## Fix yang disarankan
- Tambahkan guard idempotency di `closePosition()`: `if (!state.open.some(p => p.id === pos.id)) return null;` di awal fungsi — ini mencegah double-count meski race-nya sendiri belum dieliminasi.
- Idealnya juga: `reconcileNow()` dan `sellToken()` ikut menghormati/menunggu `_busy` lock yang sama dgn `tick()`, atau pakai lock per-posisi (bukan lock global) supaya `/status` tidak perlu menunggu seluruh tick selesai.

---

# 5. Auto-close saat reconcile (balance on-chain = 0) selalu mencatat PnL -100% palsu

## Status
✅ **FIXED** (2026-08-08) — `evolve.js:onTradeClosed()` sekarang exclude trade dgn `closeReason === 'auto-close: on-chain balance 0 (reconcile)'` dari `darwin.recordTrade`/`llm.recordTradeLesson` (minimal fix yang disarankan — reason sudah unik, tinggal di-filter di titik training). Real PnL retrieval (fix yang lebih ideal) tidak diimplementasi krn butuh tx history lookup yang lebih kompleks; excluding dari training data sudah cukup untuk menghentikan poisoning data.

## Severity
Medium — butuh precondition spesifik (sell di luar bot, atau swap sukses tapi konfirmasi gagal) tapi plausible, dan mencemari data fitness/lessons secara diam-diam.

## Root Cause
`manager.js:_reconcilePosition()` (baris 77-94): kalau saldo token on-chain = 0 tapi posisi masih tercatat terbuka, langsung `closePosition(pos, { reason: 'auto-close: on-chain balance 0 (reconcile)', receivedNative: 0, ... })` — `receivedNative` di-hardcode 0 tanpa pernah mengecek berapa yang sebenarnya diterima (kalau swap sebenarnya sukses tapi bot gagal mengonfirmasi tx). `realizedPnlPct()` (`state.js`) = `(realizedNative - amountNative) / amountNative * 100` → selalu ≈ -100% terlepas dari kenyataan.

Trade palsu ini lolos ke `onTradeClosed` → meracuni EMA fitness genome terkait (`darwin.recordTrade`) dan menghasilkan "lesson" palsu ke LLM (`llm.recordTradeLesson`).

## Fix yang disarankan
Sebelum auto-close karena balance 0, coba ambil harga jual efektif riil (mis. dari tx history/last known price) alih-alih hardcode `receivedNative: 0`. Minimal, beri tag/flag khusus (`reason` sudah unik: `auto-close: ...`) supaya `darwin.recordTrade`/`llm.recordTradeLesson` bisa memilih untuk mengecualikan trade dgn reason ini dari training data, karena PnL-nya tidak bisa dipercaya.

---

# 6. `stdio-backend.js` hardcode fail-open, mengabaikan `cfg.llm.failOpen: false`

## Status
✅ **FIXED** (2026-08-08) — `assessBatch()` sekarang `throw` saat respons invalid/gagal, bukan fabricate verdict "buy". `screener.js` (baris ~276) yang memutuskan fail-open/fail-closed berdasarkan `cfg.llm.failOpen`, konsisten dgn `http-backend.js`.

## Severity
**High** — bypass langsung terhadap safety setting yang eksplisit di-set user, reachable di operasi normal (timeout/hiccup agent), dan persis kelas bug yang sudah pernah terjadi di project ini (mass-buy saat LLM gagal).

## Root Cause
`stdio-backend.js:assessBatch()` (baris ~69-72): kalau respons dari agent stdio gagal/malformed/timeout, fungsi langsung `return` verdict buatan sendiri:
```js
return candidates.map(() => ({ action: 'buy', confidence: 0.5, risk: 'medium', reason: 'LLM unavailable (failOpen)' }));
```
— bukan `throw`. Karena backend ini yang dipakai di skill mode (`skills/runner.js:47`), try/catch di `screener.js` (baris ~272-283, yang SEHARUSNYA menghormati `cfg.llm.failOpen`) tidak pernah ke-trigger karena tidak ada exception yang dilempar. Confidence 0.5 juga lolos default `minConfidence: 0.35`, jadi kandidat tetap dibeli.

## Fix yang disarankan
Hapus fail-open hardcoded ini — `throw` error saat `!resp.ok || !Array.isArray(...)`, biarkan `screener.js` yang memutuskan fail-open/fail-closed berdasarkan `cfg.llm.failOpen`, konsisten dgn `http-backend.js` (perlu dicek apakah http-backend juga throw dgn benar).

---

# 7. Moonbag: exit tidak pernah dilaporkan ke Darwin fitness / LLM lessons

## Status
✅ **FIXED** (2026-08-08) — `genomeId` disimpan di moonbag snapshot saat konversi (`state.js:moveToMoonbag`). Saat moonbag dijual penuh (`pct>=100`, `trade/helpers.js:sellToken`), `onTradeClosed` dipanggil dgn trade record sintetis (PnL mark-based dari `mb.currentPrice` vs `mb.entryPrice`, konsisten dgn pola `currentPnlPct()` yg dipakai notifikasi lain). Partial moonbag sell tidak memicu report (scope: hanya exit penuh, sesuai bug report).

## Severity
Low — gap kelengkapan feedback loop, bukan salah data.

## Root Cause
`state.js:moveToMoonbag()` menutup posisi asli & memanggil `onTradeClosed` sekali dgn PnL saat konversi ke moonbag — itu benar. Tapi objek moonbag tidak membawa `genomeId`, dan saat moonbag itu sendiri dijual (`trade/helpers.js:sellToken()`, cabang `findMoonbag`), tidak ada pemanggilan `onTradeClosed`/`darwin.recordTrade` sama sekali — hanya `executor.sell()` + update/hapus record moonbag.

Akibat: PnL riil dari moonbag (bisa 10x atau ke nol) tidak pernah masuk ke fitness genome atau lesson LLM — understating/overstating nilai sebenarnya dari genome yang menghasilkan trade tsb.

## Fix yang disarankan
Simpan `genomeId` di record moonbag saat konversi, dan panggil `onTradeClosed`/`darwin.recordTrade` (dengan PnL tambahan dari moonbag) saat moonbag akhirnya terjual — atau, kalau moonbag memang dimaksud "di luar sistem evaluasi", dokumentasikan itu secara eksplisit di kode.

---

# 8. `/paperreset` menampilkan "undefined paper trades deleted"

## Status
✅ **FIXED** (2026-08-08) — `telegram/commands/system.js:paperreset()` tidak lagi destructure `tradesDeleted`/`lessonsDerived` (yang tidak pernah ada). Pesan diganti jadi `"💰 Balance reset · N positions closed · trade history kept"`, sesuai perilaku sebenarnya. Sekaligus menutup bug #9 (pesan "Realized PnL → 0" juga dihapus).

## Severity
Medium — 100% reproducible tiap kali `/paperreset` dijalankan, membingungkan user meski tidak berbahaya.

## Perilaku Seharusnya (dikonfirmasi user)
`/paperreset` seharusnya: (1) tutup semua posisi paper terbuka, (2) kembalikan saldo paper ke `startBalance`, (3) **riwayat trade paper TIDAK PERNAH dihapus** — sesuai fix terakhir (`a1c0422`). Ini persis yang dilakukan `executor.js:paperReset()` sekarang. Bug-nya murni di pesan Telegram yang belum diupdate mengikuti perubahan itu.

## Root Cause
`telegram/commands/system.js:paperreset()` (baris 94-99):
```js
const { balances, tradesDeleted, closedCount, lessonsDerived } = await deps.executor.paperReset({...});
```
`executor.js:paperReset()` (baris 111-131) cuma `return { balances, closedCount }` — tidak pernah punya `tradesDeleted`/`lessonsDerived` (memang sengaja, krn riwayat tidak dihapus). Destructuring di caller jadi `undefined` utk dua field itu, dan pesan Telegram menampilkan literal:
```
📊 Realized PnL → *0* · undefined paper trades deleted
```
`lessonsDerived > 0` juga selalu false, jadi baris "lessons saved" tidak pernah muncul walau lesson mungkin sebenarnya dihasilkan.

## Fix yang disarankan
Hapus `tradesDeleted`/`lessonsDerived` dari destructuring & pesan — ganti dgn teks yang sesuai perilaku seharusnya, mis. `"💰 Balance reset → ${startBalance} SOL · ${closedCount} positions closed · trade history kept"`. (Digabung dgn temuan #9 di bawah, satu fix yang sama menyelesaikan keduanya.)

---

# 9. `/paperreset` — pesan "Realized PnL → *0*" tidak akurat

## Status
✅ **FIXED** (2026-08-08) — Ditutup bareng fix #8, root cause sama (satu edit di `telegram/commands/system.js:paperreset()`).

## Severity
Low-Medium — terkait langsung dgn bug #8, root cause sama (pesan Telegram belum diupdate mengikuti fix `a1c0422`).

## Root Cause
Karena riwayat trade & realized PnL paper memang sengaja TIDAK direset (lihat konfirmasi di #8), hardcoded text di `system.js:106` yang bilang `"📊 Realized PnL → *0*"` sudah tidak benar — `/papertrades` & laporan periodik (`reports.js`) tetap menampilkan PnL historis dari sebelum reset, cuma balance & posisi terbuka yang benar-benar direset.

## Fix yang disarankan
Ganti teks pesan supaya jelas hanya balance & posisi terbuka yang direset, riwayat/stats tetap ada (mis. `"💰 Balance reset → ${startBalance} SOL (trade history kept)"`) — sama seperti fix #8.

---

## Klarifikasi User — Bukan Bug

**Darwin tidak auto-evolve (`darwin.js:evolve()` tidak pernah dipanggil otomatis)** — ini bukan bug, memang by design. Darwin hanya **menyarankan** perubahan nilai variabel di config JSON berdasarkan fitness genome; penerapan perubahan dilakukan manual oleh user (via command `/evolve` atau edit config langsung), bukan auto-apply. Ditemukan sebelumnya sbg "Bug: Darwin.evolve() tidak pernah dipanggil" — dicabut dari daftar bug setelah konfirmasi user.

---

## Ringkasan Prioritas

| # | Bug | Severity | Area | Status |
|---|-----|----------|------|--------|
| 1 | Darwin GENE_SPACE unit mismatch (top10/devHold/progress) | High | Screening + Darwin | ✅ Fixed |
| 6 | stdio-backend hardcoded fail-open bypasses failOpen=false | High | LLM | ✅ Fixed |
| 4 | Double-close race (tick vs manual sell/status) | High | Position Management | ✅ Fixed |
| 5 | Reconcile balance-zero fabricates -100% PnL into training data | Medium | Position Management + Darwin | ✅ Fixed |
| 2 | buildServerFilters missing /100 for maxDevHoldRate | Medium | Screening | ✅ Fixed |
| 8 | /paperreset shows "undefined ... trades deleted" | Medium | Telegram | ✅ Fixed |
| 3 | maxBuyThisCycle=0 blocks forced screening while full | Low-Medium | Screening | ✅ Fixed |
| 9 | /paperreset "Realized PnL → 0" message inaccurate | Low-Medium | Telegram | ✅ Fixed |
| 7 | Moonbag exits not reported to Darwin/LLM | Low | Darwin | ✅ Fixed |

Semua ditemukan via audit paralel per-subsistem (4 agent, babak pertama) + verifikasi manual baris-per-baris sebelum dicatat.

---
---

# BABAK 2 — Audit Terbuka (Seluruh Codebase, Tanpa Bias Pola Sebelumnya)

Permintaan user: jangan hanya cari bug di 3 area besar (screening/posisi/llm-darwin), cakup **seluruh** codebase. Babak ini pakai 5 agent paralel dgn instruksi open-ended (tidak diarahkan ke pola bug yang sudah ditemukan), mencakup file yang belum tersentuh di babak 1 (`scripts/`, `package.json`, perbandingan config aktif vs contoh). Semua temuan di bawah diverifikasi manual (baca kode asli, beberapa dgn trace matematika manual) sebelum dicatat.

---

# 10. `/set` pada field filter yang dikontrol strategy preset — bot konfirmasi "sukses" padahal nilai tidak pernah dipakai

## Status
✅ **FIXED** (2026-08-08, superseded oleh perubahan arsitektur) — Awalnya di-tandai fixed dgn pesan peringatan (lihat riwayat). Kemudian seluruh mekanisme preset di-redesign: `strategies.js:PRESETS` (hardcoded) diganti `strategy.json` (user-editable, per-strategi self-contained termasuk `myself`), dan `/set screener.filters.*`/`screener.section`/`llm.enabled`/`darwin.enabled`/`darwin.autoEvolve` sekarang route langsung ke strategy.json di bawah strategi yg SEDANG AKTIF (`config.js:strategyRoutedPath()`). Jadi `/set` field ini SEKARANG SELALU benar-benar berlaku utk strategi manapun yg aktif — bug root cause (nilai diam-diam diabaikan) tidak ada lagi, bukan cuma diberi peringatan. Warning message dihapus dari `set()` krn sudah tidak relevan.

## Klarifikasi User
Perilaku `applyStrategy()` sendiri **BUKAN bug** — memang by design: `live-config.json` (`screener.filters.*`) sepenuhnya dipakai HANYA oleh strategy `myself`. Strategy lain (`sniper`, `degen`, `wait_for_dip`, `smart_money`) memang tidak pernah pakai screening dari file config — nilainya langsung hardcode di `strategies.js:PRESETS`. Jadi `applyStrategy()` meng-override field filter saat strategy non-`myself` aktif itu SESUAI DESAIN.

## Severity (direvisi)
Medium (turun dari High) — bukan lagi soal "config penting diam-diam dibuang", murni soal **pesan konfirmasi yang menyesatkan**: `/set screener.filters.X <value>` saat strategy non-`myself` aktif tetap membalas `✅ path = value` seolah berhasil, padahal field itu memang tidak pernah dibaca dari config saat strategy preset aktif (fungsinya digantikan hardcoded preset). User yang tidak sadar strategy-nya bukan `myself` bisa bingung kenapa filter yang di-`/set` "tidak ada efek".

## Root Cause
`telegram/commands/config.js:set()` (baris 113,119) menampilkan `value` — hasil parse mentah dari `setPath`, bukan hasil `getPath(path)` setelah `applyStrategy()` jalan. Tidak ada pengecekan apakah field yang di-`/set` termasuk yang dikontrol strategy preset aktif (`FIELD_MAP` di `strategies.js`) — pesan sukses generik selalu tampil terlepas dari itu.

## Fix yang disarankan
Kalau `strategy != 'myself'` dan path yang di-`/set` termasuk field di `FIELD_MAP` (`strategies.js`), tambahkan catatan di pesan balasan (mis. `"⚠️ catatan: field ini di-override oleh strategy preset '{strategy}' — nilai tidak akan dipakai kecuali strategy diganti ke 'myself'"`) alih-alih membalas sukses polos. Perilaku inti (`applyStrategy` override) tidak perlu diubah.

---

# 11. `pct` pada `/sell` & LLM tool `sell_token` tidak divalidasi — nilai negatif/NaN merusak state paper secara permanen

## Status
✅ **FIXED** (2026-08-08) — Validasi terpusat ditambahkan di awal `sellToken()` (`trade/helpers.js`): `throw` kalau `!(pct > 0 && pct <= 100)`. Menutup kedua jalur (`/sell` manual & LLM tool `sell_token`) sekaligus, karena keduanya memanggil fungsi yang sama. Error di-propagate dgn baik: `bot.js` command handler catch (baris 286) mengirim pesan error ke user, `command-queue.js` (LLM tool path) menangkapnya jadi `{ok:false,error:...}`. Sekaligus menutup bug #24 (`pct=0` juga ditolak).

## Severity
**High** — reachable dari DUA jalur independen (command Telegram manual `/sell`, dan tool call LLM `sell_token`), tidak ada validasi di titik manapun sepanjang chain pemanggilan.

## Root Cause
`telegram/commands/trading.js` (`/sell`) dan `llm/tools.js:97-99` (`sell_token`, `args.pct ?? 100`) sama-sama meneruskan `pct` mentah ke `trade/helpers.js:sellToken()` tanpa validasi range. Hanya `pct >= 100` yang di-treat khusus (full close); nilai lain dipakai apa adanya.

**Skenario pct negatif** (mis. `-50`, dari LLM yang berhalusinasi atau user salah ketik) — mode paper: `paper.js:134`: `tokens = held * (Math.min(-50,100)/100) = held * -0.5` (negatif). `paperSetHolding(this.key, tokenAddress, held - tokens)` = `held - (-0.5*held) = 1.5*held` → **holdings token NAIK 50%** padahal berstatus "sell". `paperAdjustBalance(this.key, receivedNative - gasFee)` dgn `receivedNative` negatif → **saldo SOL berkurang** utk transaksi yang diklaim "jual". Kalau partial (`pct<100` branch di `helpers.js`): `state.js:recordPartialSell()` → `pos.remainingPct = pos.remainingPct * (1 - (-50/100)) = pos.remainingPct * 1.5` → **remainingPct permanen di atas 100%**, merusak invariant yang dipakai di seluruh math PnL/moonbag/display selanjutnya.

**Skenario pct non-numeric** (mis. `/sell <addr> abc` → `Number("abc") = NaN`): `pos.remainingPct = pos.remainingPct * (1 - NaN/100) = NaN` — posisi rusak permanen, `/status` menampilkan "NaN%" selamanya utk posisi itu, dan math turunan (`reports.js` invested calc, dst) ikut NaN.

Mode live (`chains/solana.js`) sedikit lebih aman: `BigInt(Math.floor(pct*100))` dgn pct negatif/NaN kemungkinan besar throw (`RangeError`/`raw<=0n` guard) — jadi korupsi silent ini spesifik mengenai **mode paper**, yaitu mode yang datanya dipakai training Darwin.

## Fix yang disarankan
Validasi `pct` di satu tempat sentral (awal `sellToken()` di `trade/helpers.js`, titik temu semua caller): `if (!(pct > 0 && pct <= 100)) throw new Error('pct must be 0 < pct <= 100')`.

---

# 12. DexScreener fallback: filter holder/security diam-diam ter-skip untuk kandidat di luar budget enrichment GoPlus

## Status
✅ **FIXED** (2026-08-08) — Loop filter di `screener.js` (jalur DexScreener fallback) sekarang eksplisit exclude kandidat yang bukan bagian dari `toEnrich` (belum dapat data GoPlus) sebelum `evaluate()`, alih-alih membiarkan mereka lolos filter holder/security karena `c.holders`/`c.security` masih null.

## Severity
High — bisa meloloskan token honeypot/wash-trading/holder rendah ke tahap LLM/buy tanpa terdeteksi, khusus di jalur fallback DexScreener (aktif kalau GMGN return 0 kandidat, atau `screener.source: 'dexscreener'`).

## Root Cause
`screener.js` — `toEnrich = cheap.slice(0, maxEnrich)` (default `maxEnrich` = `maxCandidatesPerCycle * 3`, bisa hanya ~9) cuma mengirim prefix `cheap` ke GoPlus (`tokenSecurity()`, mengisi `c.security`/`c.holders`). Tapi loop filter setelahnya (`for (const c of cheap) { evaluate(c, filters) ... }`) jalan di **SELURUH** `cheap`, bukan cuma `toEnrich`.

`filters.js:evaluate()` — cek holder (`if (c.holders != null) {...}`) dan security (`c.security?.honeypot`) DILEWATI (bukan digagalkan) kalau data `null`/`undefined`. Kandidat di luar `maxEnrich` (urutan sisa dari `cheap`, bukan diurutkan risiko) otomatis `c.holders == null` dan `c.security == null` → `minHolders`/`maxHolders`/`blockHoneypot`/`blockWashTrading` efektif NONAKTIF untuk mereka, meski konfigurasi mengharuskan aktif.

## Fix yang disarankan
Kandidat di luar `maxEnrich` (belum sempat di-enrich GoPlus) sebaiknya di-exclude eksplisit dari `candidates` (bukan lolos filter security by-default), atau naikkan/hapus batas enrichment, atau urutkan `cheap` by risk-relevant score sebelum slicing `toEnrich` supaya yang paling berisiko diprioritaskan utk enrichment.

---

# 13. Double-tap tombol "Buy" Telegram bisa memicu dua buy konkuren utk token yang sama

## Status
✅ **FIXED** (2026-08-08) — Lock in-memory per `chain:address` (`this._buyLocks` Set) ditambahkan di `bot.js`. Invocation kedua yang datang saat masih diproses langsung di-reject via `answerCallbackQuery` ("Already buying…"), lock dilepas di `finally`.

## Severity
High (live mode — dampak uang riil), meski butuh tap ganda cepat atau duplicate webhook delivery utk trigger.

## Root Cause
`telegram/bot.js:248-263` — callback `buy:<chain>:<address>` langsung memanggil `deps.buyToken(...)`, keyboard baru di-clear (`editMessageReplyMarkup`) SETELAH `buyToken` resolve. Tidak ada lock/debounce di level callback berdasarkan `callback_data`/`address`.

`trade/helpers.js:buyToken()` — guard duplikat (`findOpen(chainKey, c.address)`, baris 35) adalah cek sinkron SEBELUM `await resolveCandidate/executor.buy`. Kalau user tap dua kali cepat (atau Telegram mengirim webhook duplikat — pernah terjadi di practice), kedua invocation lolos `findOpen` check sebelum salah satu sempat memanggil `addPosition` — dua buy riil tereksekusi utk satu tap logis.

## Fix yang disarankan
Tambahkan lock in-memory per `address` (atau per `callback_data`) di `bot.js` sebelum memanggil `buyToken`, dilepas di `finally`, supaya invocation kedua yang datang saat masih diproses langsung ditolak/di-ignore.

---

# 14. `paper.js:sell()` — realizedNative yang disimpan pre-gas, wallet didebit post-gas → PnL paper systematically overstated

## Status
✅ **FIXED** (2026-08-08) — `paper.js:sell()` sekarang `return`s `receivedNative - gasFee`, konsisten dgn semantik `buy()` (nilai yang dilaporkan = yang benar-benar mempengaruhi saldo).

## Severity
Medium — bias kecil per-trade tapi sistematis di SETIAP sell paper, mencemari data training Darwin & lesson LLM (keduanya dilatih dari data paper).

## Root Cause
`paper.js:150-159`: `receivedNative = tokens * fillPrice` (sebelum gas) — inilah yang di-`return` dan disimpan sbg `pos.realizedNative`/PnL via `recordPartialSell`/`closePosition` (`state.js`). Tapi saldo wallet paper didebit `receivedNative - gasFee` (baris 155). Jadi PnL yang tercatat/ditampilkan selalu lebih tinggi dari perubahan saldo riil sebesar `gasFee`, utk SETIAP sell. Bandingkan dgn `buy()` (baris 121) yang benar: `spentNative` (dilaporkan) TIDAK termasuk gas, saldo didebit `amountNative + gasFee` — asimetris, sell yang salah.

## Fix yang disarankan
`return { txid, soldRaw: tokens, receivedNative: receivedNative - gasFee }` — konsisten dgn semantik `buy()` (nilai yang dilaporkan = yang benar-benar mempengaruhi saldo).

---

# 15. `fmtUsd()` — harga di bawah $1 dirender scientific notation, bukan desimal

## Status
✅ **FIXED** (2026-08-08) — `utils.js:fmtUsd()` untuk `0 < n < 1` sekarang format manual ke desimal penuh (`toFixed` dgn presisi dihitung dari `Math.floor(Math.log10(n))`, ~4 significant digits) alih-alih `toPrecision(4)` yang beralih ke notasi eksponensial di bawah 1e-6. Diverifikasi manual: `0.00000012345` → `$0.0000001235`.

## Severity
Medium — kosmetik/UX tapi mempengaruhi SETIAP notifikasi buy/sell/status utk memecoin (target utama bot ini), karena hampir semua harga token yang di-snipe < $1.

## Root Cause
`utils.js:11`: `return \`$${n.toPrecision(4)}\`;` — utk `n < 1`. `Number.prototype.toPrecision` otomatis pakai notasi eksponensial kalau exponent < -6. Harga token baru umum seperti `0.00000012345` → `toPrecision(4)` = `"1.235e-7"`, jadi pesan Telegram menampilkan `$1.235e-7` — tidak terbaca oleh user awam, tidak konsisten dgn cara harga memecoin biasa ditampilkan (desimal penuh).

## Fix yang disarankan
Untuk `n < 1`, format manual ke desimal (mis. cari jumlah leading zero lalu `toFixed` dgn presisi signifikan yg sesuai) alih-alih `toPrecision` mentah.

---

# 16. Retry buy setelah `sendRawTransaction` gagal transient bisa mengirim tx kedua walau tx pertama sudah tersiar (risiko double-buy)

## Status
✅ **FIXED** (2026-08-08) — `chains/solana.js`: error dari `sendRawTransaction()` sekarang ditandai (`"tx broadcast uncertain: ..."`) sebelum di-throw. `trade/helpers.js` retry loop diperluas untuk mengenali marker ini (sama seperti `"not confirmed"`) — `throw` langsung tanpa retry, tidak lagi lolos ke `TRANSIENT_BUY_ERROR_RE` blind-retry.

## Severity
Medium-High — dampak uang riil di mode live, tapi butuh window waktu spesifik (RPC sempat broadcast tx tapi response HTTP-nya sendiri timeout/gagal) — plausible saat RPC endpoint flaky/rate-limited (kondisi umum saat sniping).

## Root Cause
`trade/helpers.js:59-70` (`buyToken` retry loop) cuma treat khusus error dari tahap KONFIRMASI (`/not confirmed/i.test(e.message)` → langsung `throw`, tidak retry, dgn comment eksplisit "tx sudah tersiar ke jaringan — jangan retry, risiko beli ganda"). Tapi error dari `connection.sendRawTransaction()` sendiri (`chains/solana.js:192-198`) — yang JUGA bisa terjadi SETELAH RPC node menerima & mulai broadcast tx, kalau response call-nya sendiri yang timeout/connection-reset — tidak dapat perlakuan sama. Kalau pesan errornya cocok `TRANSIENT_BUY_ERROR_RE` (mis. `ECONNRESET`, `ETIMEDOUT`), retry loop menganggapnya aman untuk retry & mengirim TRANSAKSI BARU yang independen, padahal transaksi pertama bisa saja tetap landed on-chain.

## Fix yang disarankan
Perlakukan error dari `sendRawTransaction` dgn kehati-hatian yang sama seperti error konfirmasi — kalau memungkinkan, cek status tx via `txid` (kalau RPC sempat mengembalikan satu) sebelum memutuskan retry, atau minimal jangan auto-retry error yang terjadi setelah `sendRawTransaction` dipanggil tanpa verifikasi eksplisit bahwa tx BENAR-BENAR belum tersiar.

---

# 17. Moonbag partial sell memutasi state tanpa `persist()` — window kehilangan data saat crash

## Status
✅ **FIXED** (2026-08-08) — Ditambahkan `recordMoonbagPartialSell(mb, pct)` di `state.js` (mutasi `moonPct` + `persist()`, pola sama seperti mutator lain), dipanggil dari `trade/helpers.js:sellToken()` menggantikan mutasi langsung.

## Severity
Low-Medium — biasanya "tertutupi" oleh `persist()` tick harga berikutnya, tapi ada window nyata di mana data bisa hilang.

## Root Cause
`trade/helpers.js:sellToken()`, cabang moonbag partial (`pct < 100`): `mb.moonPct = mb.moonPct * (1 - pct / 100);` — memutasi objek moonbag langsung TANPA memanggil `persist()`, tidak seperti mutator state lain (`recordPartialSell`, `removeMoonbag`, dst yang semuanya `persist()`/`persistNow()`). Kalau proses restart/crash sebelum tick price-refresh berikutnya yang tidak sengaja `persist()`, `moonPct` yang sudah dikurangi kembali ke nilai sebelum-sell setelah reload, padahal saldo on-chain/paper sudah mencerminkan penjualan itu.

## Fix yang disarankan
Tambahkan `persist()` di akhir cabang ini, sama seperti mutator lain di `state.js`.

---

# 18. `sanitizePromptField` tidak diterapkan ke `trade.symbol`/`closeReason` di `recordLesson()` — celah prompt-injection yang sudah dimitigasi di tempat lain tapi tidak di sini

## Status
✅ **FIXED** (2026-08-08) — `sanitizePromptField()` diterapkan ke `trade.symbol`/`t.symbol` di `recordLesson()` DAN `deriveLessons()`, kedua backend (`http-backend.js`, `stdio-backend.js`), konsisten dgn `assessBatch`.

## Severity
Medium — blast radius terbatas ke teks lesson/notifikasi advisory (bukan eksekusi trade langsung), tapi ini persis gap dari mitigasi yang sudah ada (`sanitizePromptField` dipakai konsisten di `assessBatch`, tapi bocor di jalur lesson).

## Root Cause
`llm/http-backend.js:136` & `llm/stdio-backend.js:94` (`recordLesson`): `\`- ${trade.symbol} on ${trade.chain}, held ...\`` — `trade.symbol` diselipkan mentah ke prompt LLM. `trade.symbol` berasal dari `c.symbol` (metadata token, sepenuhnya dikontrol siapa pun yang deploy token di on-chain) — persis data yang menurut docstring `sanitizePromptField` (`utils.js:19-33`) HARUS disanitasi sebelum masuk prompt. `assessBatch` di kedua backend sudah benar pakai `sanitizePromptField(c.symbol)`, tapi `recordLesson`/`deriveLessons` tidak.

## Fix yang disarankan
Bungkus `trade.symbol` (dan field string lain dari token metadata yang masuk prompt) dgn `sanitizePromptField()` di `recordLesson`/`deriveLessons` kedua backend, konsisten dgn `assessBatch`.

---

# 19. `/set` tidak validasi tipe/range nilai sebelum ditulis ke config

## Status
✅ **FIXED** (2026-08-08) — `config.js:setPath()` sekarang membandingkan tipe nilai baru (setelah koersi) dgn tipe nilai existing di path yg sama: kalau existing `number`/`boolean` tapi value baru tidak sesuai tipe, `throw` dgn pesan jelas alih-alih menyimpan string mentah diam-diam. Field yang sebelumnya `null` (mis. `maxDevHoldRate`) tidak kena restriksi ini — tetap bisa di-set pertama kali.

## Severity
Medium — tidak crash langsung (banyak konsumen sudah punya guard `>0`/`Number()` implisit), tapi tidak ada safety net di titik penulisan — kesalahan ketik user tersimpan diam-diam.

## Root Cause
`config.js:setPath()` (baris 484-495): koersi tipe cuma cek `true`/`false`/angka/JSON array-object; string lain (mis. `/set trading.buyAmount abc`) disimpan APA ADANYA sbg string, tanpa error, dan pesan Telegram tetap `✅ trading.buyAmount = "abc"`. Baru gagal diam-diam di titik pemakaian (mis. `chainCfg.buyAmount > 0` jadi `false`) — kalau ada konsumen config lain yang tidak punya guard serupa, bisa misbehave tanpa pesan error yang jelas ke user.

## Fix yang disarankan
Tambahkan validasi tipe per-field (atau minimal per top-level category: numeric fields harus lolos `!isNaN`, boolean fields harus true/false) di `setPath` sebelum menulis, tolak dgn pesan jelas kalau tidak sesuai.

---

# 20. `command-queue.js` — file command dihapus SEBELUM tool dieksekusi & result ditulis

## Status
✅ **FIXED** (2026-08-08) — `.cmd.json` di-`rename` (bukan `unlink`) ke `.processing.json` sebelum eksekusi — tetap keluar dari glob `.cmd.json` (mencegah double-pickup) tapi tetap ada jejak di disk. Baru di-`unlink` SETELAH `.result.json` berhasil ditulis. Kalau proses crash di tengah eksekusi, `.processing.json` bertahan sbg jejak (akan tersapu `sweepStaleCommandFiles` setelah `maxAgeMs`).

## Severity
Low-Medium — command bisa hilang tanpa jejak kalau proses crash tepat di tengah eksekusi (mis. saat `buy_token`/`sell_token` sedang jalan).

## Root Cause
`skills/command-queue.js` (baris ~59-68): file `.cmd.json` di-`unlink` SEBELUM `runLlmTool` dieksekusi dan `.result.json` ditulis. Kalau proses runner crash di antara dua titik itu, command hilang total — tidak ada file `.cmd.json` (sudah dihapus) maupun `.result.json` (belum sempat ditulis). Caller (`scripts/skill-command.js`) cuma timeout 30 detik dgn pesan generik, tidak tahu apakah command (mis. buy/sell) benar-benar sempat jalan atau tidak.

## Fix yang disarankan
Hapus `.cmd.json` SETELAH `.result.json` berhasil ditulis (atau pindahkan ke folder `processing/` dulu), supaya ada jejak kalau proses crash di tengah jalan.

---

# 21. `sweepStaleCommandFiles` hanya jalan sekali saat startup — file orphan menumpuk selama uptime panjang

## Status
✅ **FIXED** (2026-08-08) — `skills/runner.js` sekarang juga menjalankan `sweepStaleCommandFiles()` periodik via `setInterval` (tiap 30 menit), bukan cuma sekali di startup. Interval dibersihkan di `shutdown()`.

## Severity
Low.

## Root Cause
`skills/command-queue.js:sweepStaleCommandFiles` dipanggil sekali di `runner.js:63` (saat startup), tidak pernah lagi selama proses berjalan. File `.cmd.json`/`.result.json` orphan (dari command yang callernya sudah mati sebelum consume result, atau dari bug #20) akan menumpuk di disk sampai restart berikutnya.

## Fix yang disarankan
Jalankan `sweepStaleCommandFiles` secara periodik (mis. tiap beberapa menit via `setInterval`), bukan cuma sekali di startup.

---

# 22. Decision cache key (chain, address) tidak case-normalized

## Status
✅ **FIXED** (2026-08-08) — `db.js:checkDecisionCache()`/`storeDecisionCache()` sekarang `.toLowerCase()` address sebelum dipakai sbg cache key, konsisten dgn pola held-token filter di `screener.js`.

## Severity
Low — inefisiensi biaya (LLM call redundan), bukan salah hasil.

## Root Cause
`db.js` decision cache (`checkDecisionCache`/`storeDecisionCache`, dipanggil dari `screener.js`) memakai `c.address`/`candidate.address` apa adanya sbg bagian primary key, tanpa normalisasi case — beda dgn held-token filter di `screener.js` yang eksplisit `.toLowerCase()`. Kalau address token yang sama muncul dgn casing beda antar sumber (GMGN vs DexScreener), cache "skip" sebelumnya gagal match → LLM dipanggil ulang secara redundan (biaya, bukan salah verdict).

## Fix yang disarankan
Normalisasi `address` ke lowercase sebelum dipakai sbg cache key, konsisten dgn pola yang sudah dipakai di held-token filter.

---

# 23. GoPlus token-security cache diklaim "LRU" tapi eviction-nya FIFO murni

## Status
✅ **FIXED** (2026-08-08) — `cached()` (`goplus.js`) sekarang re-insert key ke akhir Map saat cache-hit (`cache.delete(k); cache.set(k, v)`), jadi eviction di `store()` (`cache.keys().next().value`) benar-benar LRU (buang paling lama tidak diakses).

## Severity
Low — bukan bug korektness, cuma lebih banyak re-fetch GoPlus dari yang diklaim komentar/nama.

## Root Cause
`screener/goplus.js` — fungsi cache-hit (`cached()`) tidak pernah re-insert/touch ordering saat hit, jadi eviction (`cache.keys().next().value`) selalu membuang entry yang paling lama DIMASUKKAN, bukan paling lama TIDAK DIAKSES (true LRU). Token yang sering dicek dekat batas 1000-entry bisa ke-evict duluan dibanding entry lama yang sudah tidak relevan.

## Fix yang disarankan
Kalau mau LRU asli: re-insert key ke akhir Map saat cache-hit (`cache.delete(k); cache.set(k, v);` — Map JS mempertahankan insertion order). Kalau tidak worth effort-nya, cukup ganti komentar/nama dari "LRU" ke "FIFO" biar tidak menyesatkan.

---

# 24. `/sell pct=0` tetap "berhasil" & membakar gas fee simulasi meski tidak menjual apa pun

## Status
✅ **FIXED** (2026-08-08) — Ditutup bareng fix #11: validasi terpusat di `sellToken()` (`trade/helpers.js`) menolak `pct <= 0` dgn error, sebelum sempat memanggil `executor.sell()`.

## Severity
Low.

## Root Cause
`paper.js:134-159`: `pct=0` → `tokens=0`, `receivedNative=0`, tapi `gasFee` tetap dikurangi dari saldo (baris 155) dan bot tetap balas `✅ SELL 0% ...` — transaksi kosong yang "berhasil" & membakar gas virtual tanpa efek nyata selain itu.

## Fix yang disarankan
Tolak `pct <= 0` di awal `sellToken()` (satu tempat sekaligus dgn fix #11) dgn pesan error, bukan diproses sbg "sukses".

---

# 25. `runScreening()` — field `scanned` sebenarnya jumlah LOLOS filter, bukan jumlah token yang di-scan

## Status
✅ **FIXED** (2026-08-08) — `screener.js`: variabel `scannedCount` baru ditambahkan, di-set dari jumlah kandidat mentah tiap jalur (`result.candidates.length` utk GMGN, `raw.length` utk DexScreener fallback) SEBELUM filter apapun. `return` akhir sekarang pakai `scanned: scannedCount`, terpisah dari `candidates.length` (jumlah akhir yang lolos).

## Severity
Low — telemetry/notifikasi menyesatkan, tidak mempengaruhi logic trading.

## Root Cause
`screener.js` — `return { candidates, genomeId, scanned: candidates.length }` — `scanned` diisi dari `candidates.length` (SETELAH semua filter/ranking/LLM gate), bukan jumlah token mentah yang benar-benar dievaluasi (`raw.length`/jumlah hasil GMGN awal). Notifikasi screening di Telegram (via `loops.js`) jadi selalu menampilkan "X scanned, X passed" — dua angka yang sama, padahal ratusan token mungkin sebenarnya dievaluasi.

## Fix yang disarankan
Track jumlah token mentah sebelum filter (mis. `result.candidates.length` dari GMGN atau `raw.length` dari DexScreener) sbg `scanned`, terpisah dari jumlah akhir yang lolos.

---

# 26. Tidak ada `process.on('uncaughtException')` — throw sinkron bisa crash proses tanpa graceful shutdown

## Status
✅ **FIXED** (2026-08-08) — `process.on('uncaughtException', ...)` ditambahkan, mirroring pola `SIGINT`/`SIGTERM` yang sudah ada, di KEDUA entry point: `index.js` dan `skills/runner.js` (skill mode punya gap yang sama).

## Severity
Low-Medium — sebagian besar path async sudah ada `.catch()`, tapi tidak ada jaring pengaman utk throw sinkron yang lolos dari semua try/catch.

## Root Cause
`index.js` cuma daftar handler `SIGINT`/`SIGTERM`/`unhandledRejection` (baris ~141-143) — tidak ada `process.on('uncaughtException', ...)`. Throw sinkron di luar konteks yang di-catch langsung crash proses, skip `shutdown()` (baris 130-139) — `telegram.stopPolling()` & teardown `positionManager`/screening loop tidak sempat jalan. `beforeExit` handler di `state.js:92` juga tidak fire pada crash (`beforeExit` cuma fire saat event loop natural drain, bukan saat proses di-terminate paksa) — state yang belum sempat di-`persist()` sejak periodic write terakhir bisa hilang.

## Fix yang disarankan
Tambahkan `process.on('uncaughtException', (e) => { log.error(...); shutdown(); })` di `index.js`, mirroring pola `SIGINT`/`SIGTERM` yang sudah ada.

---

## Ringkasan Prioritas — Babak 2

| # | Bug | Severity | Area | Status |
|---|-----|----------|------|--------|
| 11 | `pct` di `/sell`/`sell_token` tidak divalidasi → korupsi state paper | High | Trade/Position | ✅ Fixed |
| 12 | DexScreener fallback: filter holder/security ter-skip di luar budget enrichment | High | Screening | ✅ Fixed |
| 13 | Double-tap Buy button → double-buy konkuren | High | Telegram | ✅ Fixed |
| 16 | Retry buy setelah `sendRawTransaction` gagal transient → risiko double-buy on-chain | Medium-High | Trade | ✅ Fixed |
| 14 | `paper.js:sell()` realizedNative pre-gas vs wallet post-gas — PnL overstated | Medium | Trade/Darwin | ✅ Fixed |
| 15 | `fmtUsd()` harga <$1 jadi scientific notation | Medium | Utils/Display | ✅ Fixed |
| 18 | `sanitizePromptField` tidak dipakai di `recordLesson` — prompt-injection gap | Medium | LLM | ✅ Fixed |
| 19 | `/set` tanpa validasi tipe/range | Medium | Config | ✅ Fixed |
| 10 | `/set` field strategy-preset: pesan sukses tidak sebut nilai diabaikan (bukan bug inti, cuma UX) | Medium | Config | ✅ Fixed |
| 17 | Moonbag partial sell tanpa `persist()` | Low-Medium | Position | ✅ Fixed |
| 20 | command-queue: file command dihapus sebelum result ditulis | Low-Medium | Skills/IPC | ✅ Fixed |
| 26 | Tidak ada `uncaughtException` handler | Low-Medium | Infra | ✅ Fixed |
| 22 | Decision cache key tidak case-normalized | Low | Screening | ✅ Fixed |
| 23 | GoPlus cache "LRU" sebenarnya FIFO | Low | Screening | ✅ Fixed |
| 21 | `sweepStaleCommandFiles` cuma jalan sekali di startup | Low | Skills/IPC | ✅ Fixed |
| 24 | `/sell pct=0` "sukses" & bakar gas fee simulasi | Low | Trade | ✅ Fixed |
| 25 | `scanned` di notifikasi screening = jumlah lolos, bukan jumlah di-scan | Low | Screening | ✅ Fixed |

Babak 2 ditemukan via 5 agent paralel dgn instruksi open-ended (tidak diarahkan ke pola bug yang sudah diketahui) + verifikasi manual (baca kode asli, beberapa dgn trace matematika langsung) sebelum dicatat. Total keseluruhan (babak 1 + 2): **26 bug terkonfirmasi** (1 temuan awal, "Darwin.evolve() tidak dipanggil", dicabut setelah klarifikasi user — itu memang by design). Belum ada yang diperbaiki — dokumentasi murni sesuai permintaan.
