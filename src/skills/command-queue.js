import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('cmd-queue');

/**
 * Antrian command berbasis file — agent (platform host, mis. Claude Code)
 * menulis file .cmd.json ke sini via scripts/skill-command.js, proses
 * runner.js yang SUDAH JALAN yang polling & eksekusi (satu-satunya penulis
 * state posisi tetap runner.js — lihat docs/superpowers/specs/2026-08-03-skill-mode-agent-control-design.md).
 */
export function commandQueueDir() {
  const dir = path.join(DATA_DIR, 'skill-commands');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Bersihkan file .cmd.json/.result.json yatim (mis. sesi agent yang crash) yang lebih tua dari maxAgeMs. */
export function sweepStaleCommandFiles(dir = commandQueueDir(), maxAgeMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {
      // sudah dihapus proses lain di antara readdir dan statSync — abaikan
    }
  }
}

/**
 * Polling folder inbox tiap intervalMs, eksekusi tiap .cmd.json lewat
 * runLlmTool, tulis .result.json. `.cmd.json` di-rename ke `.processing.json`
 * SEBELUM eksekusi (supaya tool yang lambat tidak ke-pickup dua kali oleh
 * tick berikutnya — file itu keluar dari glob `.cmd.json`), lalu dihapus
 * SETELAH `.result.json` berhasil ditulis — supaya ada jejak di disk kalau
 * proses crash di tengah eksekusi.
 * Proses satu per satu (bukan Promise.all) — sama seperti satu pesan
 * Telegram ditangani satu per satu hari ini.
 */
export function startCommandQueueLoop(runLlmTool, { dir = commandQueueDir(), intervalMs = 2000 } = {}) {
  return setInterval(async () => {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.cmd.json')).sort();
    } catch (e) {
      log.warn('readdir gagal:', e.message);
      return;
    }
    for (const f of files) {
      const cmdPath = path.join(dir, f);
      let cmd;
      try {
        cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8'));
      } catch (e) {
        log.warn(`command ${f} rusak, dibuang:`, e.message);
        try { fs.unlinkSync(cmdPath); } catch { /* sudah hilang */ }
        continue;
      }
      // Rename (bukan hapus) ke `.processing.json` — keluar dari glob `.cmd.json`
      // (mencegah tick berikutnya pickup dua kali) TAPI tetap ada jejak di disk
      // kalau proses crash di tengah eksekusi (bug #20: file command hilang
      // total kalau di-unlink sebelum result ditulis).
      const processingPath = path.join(dir, `${cmd.id}.processing.json`);
      try { fs.renameSync(cmdPath, processingPath); } catch { /* sudah hilang */ }
      let out;
      try {
        const result = await runLlmTool(cmd.name, cmd.args || {});
        out = { id: cmd.id, ok: true, result, completedAt: Date.now() };
      } catch (e) {
        out = { id: cmd.id, ok: false, error: e.message, completedAt: Date.now() };
      }
      try {
        fs.writeFileSync(path.join(dir, `${cmd.id}.result.json`), JSON.stringify(out));
      } catch (e) {
        log.error(`gagal tulis result utk ${cmd.id}:`, e.message);
      }
      try { fs.unlinkSync(processingPath); } catch { /* sudah hilang */ }
    }
  }, intervalMs);
}
