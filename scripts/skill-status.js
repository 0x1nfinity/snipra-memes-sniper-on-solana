import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db.js';
import { loadState, statsSummary } from '../src/positions/state.js';
import { Darwin } from '../src/darwin/darwin.js';
import { createBotContext } from '../src/llm/loops.js';

loadConfig();
initDb();
loadState();

const darwin = new Darwin().load();
const botContext = createBotContext({ darwin, statsSummary });
console.log(botContext());
