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
 * Decide which runner handles a queued command: the 5-tool LLM_TOOL_DEFS
 * surface (get_positions/screen_now/buy_token/sell_token/close_all_positions
 * — object-shaped args, shared with chat tool-calling) or the broader
 * Telegram-command-registry surface via Telegram#runCommand (array-shaped
 * positional args, mirrors `/command arg1 arg2`). Exported standalone so
 * routing can be unit-tested without spinning up the real bot/DB stack.
 */
export async function routeCommand(name, args, { runLlmTool, runCommand, toolNames }) {
  if (toolNames.has(name)) {
    return runLlmTool(name, args && typeof args === 'object' && !Array.isArray(args) ? args : {});
  }
  return runCommand(name, Array.isArray(args) ? args : []);
}

/**
 * Polling folder inbox tiap intervalMs, eksekusi tiap .cmd.json lewat
 * routeCommand() (tool atau command Telegram), tulis .result.json. `.cmd.json`
 * di-rename ke `.processing.json` SEBELUM eksekusi (supaya tool yang lambat
 * tidak ke-pickup dua kali oleh tick berikutnya — file itu keluar dari glob
 * `.cmd.json`), lalu dihapus SETELAH `.result.json` berhasil ditulis — supaya
 * ada jejak di disk kalau proses crash di tengah eksekusi.
 * Proses satu per satu (bukan Promise.all) — sama seperti satu pesan
 * Telegram ditangani satu per satu hari ini.
 *
 * `name: 'stop'` adalah kasus khusus: TIDAK melalui routeCommand/runCommand,
 * karena handler /stop asli memicu process.exit() (lewat deps.shutdown) —
 * kalau di-await apa adanya, proses bisa exit SEBELUM .result.json ditulis,
 * bikin scripts/skill-command.js nunggu penuh 30s utk command yg sebenarnya
 * sukses. Di sini: tulis result DULU, baru trigger shutdown (deferred lewat
 * setImmediate, tidak di-await) — caller command-queue selalu dapat respons
 * cepat, shutdown tetap jalan setelahnya.
 */
export function startCommandQueueLoop({ runLlmTool, runCommand, shutdown }, { dir = commandQueueDir(), intervalMs = 2000, toolNames } = {}) {
  const names = toolNames || new Set();
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
      const processingPath = path.join(dir, `${cmd.id}.processing.json`);
      try { fs.renameSync(cmdPath, processingPath); } catch { /* sudah hilang */ }

      const finish = (out) => {
        try {
          fs.writeFileSync(path.join(dir, `${cmd.id}.result.json`), JSON.stringify(out));
        } catch (e) {
          log.error(`gagal tulis result utk ${cmd.id}:`, e.message);
        }
        try { fs.unlinkSync(processingPath); } catch { /* sudah hilang */ }
      };

      if (cmd.name === 'stop') {
        finish({ id: cmd.id, ok: true, result: { text: 'shutting down' }, completedAt: Date.now() });
        setImmediate(() => shutdown('skill-command stop'));
        continue;
      }

      let out;
      try {
        const result = await routeCommand(cmd.name, cmd.args, { runLlmTool, runCommand, toolNames: names });
        out = { id: cmd.id, ok: true, result, completedAt: Date.now() };
      } catch (e) {
        out = { id: cmd.id, ok: false, error: e.message, completedAt: Date.now() };
      }
      finish(out);
    }
  }, intervalMs);
}
