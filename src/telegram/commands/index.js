import * as statusCmds from './status.js';
import * as tradingCmds from './trading.js';
import * as configCmds from './config.js';
import * as darwinCmds from './darwin.js';
import * as systemCmds from './system.js';

/**
 * Build command registry: Map<commandName, handlerFunction>
 * Each handler: async (args: string[], msg: TelegramMessage, deps: object) => void
 */
export function buildRegistry(deps) {
  // Destructure non-command exports so they don't get registered as commands
  const { handleMenuCallback: _cb, ...cmds } = {
    ...statusCmds, ...tradingCmds, ...configCmds, ...darwinCmds, ...systemCmds,
  };
  const registry = new Map();
  for (const [name, fn] of Object.entries(cmds)) {
    registry.set('/' + name, (args, msg) => fn(args, msg, deps));
  }
  return registry;
}
