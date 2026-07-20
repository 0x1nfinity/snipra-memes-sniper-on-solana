const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

const recent = []; // ring buffer untuk /logs di telegram
const MAX_RECENT = 50;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, tag, ...args) {
  if (LEVELS[level] < minLevel) return;
  const line = `[${stamp()}] [${level.toUpperCase()}] [${tag}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  recent.push(line);
  if (recent.length > MAX_RECENT) recent.shift();
  (level === 'error' ? console.error : console.log)(line);
}

export function createLogger(tag) {
  return {
    debug: (...a) => write('debug', tag, ...a),
    info: (...a) => write('info', tag, ...a),
    warn: (...a) => write('warn', tag, ...a),
    error: (...a) => write('error', tag, ...a),
  };
}

export function recentLogs(n = 20) {
  return recent.slice(-n);
}
