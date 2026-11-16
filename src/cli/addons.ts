/**
 * @fileoverview `foundryvtt-mcp addons [list | add <package|folder> | remove <name|folder>]`.
 *
 * Packages are installed in `<state dir>/addons` (their `foundryvtt-mcp` peer dependency is the
 * connector itself, never installed again); folders are used where they are. Either way the
 * addon is recorded in FOUNDRY_MCP_ADDONS in the configuration file. Restart the shared process
 * (`foundryvtt-mcp stop`) and the MCP client to load it.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addonsDir, handleListAddons, loadAddons } from '../addons/registry.js';
import { configFilePath, readConfigFile } from '../config/sources.js';

const KEY = 'FOUNDRY_MCP_ADDONS';

/** The package name of an npm spec: `@scope/name@1.2` → `@scope/name`. */
export function packageName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

const isPath = (s: string) => s.startsWith('/') || s.startsWith('.') || /^[A-Za-z]:[\\/]/.test(s);

/** Writes FOUNDRY_MCP_ADDONS in the configuration file, keeping every other line. */
export function writeAddonsSetting(file: string, list: string[]): void {
  const value = list.join(',');
  const line = `${KEY}='${value}'`;
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (new RegExp(`^${KEY}=.*$`, 'm').test(text)) {
    text = text.replace(new RegExp(`^${KEY}=.*$`, 'm'), list.length ? line : '');
  } else if (list.length) {
    text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows, or not ours to change.
  }
}

function npm(args: string[]): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit' });
  return r.status === 0;
}

export async function runAddons(argv: string[]): Promise<number> {
  const [cmd = 'list', target] = argv;
  const file = configFilePath();
  const current = (readConfigFile(file).values[KEY] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (cmd === 'list') {
    await loadAddons();
    const r = handleListAddons();
    const first = r.content[0];
    process.stdout.write(`${first && first.type === 'text' ? first.text : ''}\n`);
    return 0;
  }
  if (!target) {
    process.stderr.write(
      'Usage: foundryvtt-mcp addons [list | add <package|folder> | remove <name|folder>]\n',
    );
    return 2;
  }
  if (cmd === 'add') {
    let entry: string;
    if (isPath(target)) {
      entry = path.resolve(target);
      if (
        !existsSync(path.join(entry, 'package.json')) &&
        !existsSync(path.join(entry, 'index.js'))
      ) {
        process.stderr.write(`${entry} has no package.json nor index.js\n`);
        return 1;
      }
    } else {
      const dir = addonsDir();
      mkdirSync(dir, { recursive: true });
      if (!existsSync(path.join(dir, 'package.json'))) {
        writeFileSync(
          path.join(dir, 'package.json'),
          '{ "name": "foundryvtt-mcp-addons", "private": true }\n',
        );
      }
      // The connector is the addons' peer dependency: never install a second copy.
      if (!npm(['install', '--prefix', dir, '--omit=peer', '--no-audit', '--no-fund', target])) {
        return 1;
      }
      entry = packageName(target);
    }
    const list = [...current.filter((s) => s !== entry), entry];
    writeAddonsSetting(file, list);
    process.stdout.write(
      `Added ${entry} to ${KEY} in ${file}.\nRun \`foundryvtt-mcp stop\` and restart your MCP client to load it; check with \`foundryvtt-mcp addons list\`.\n`,
    );
    return 0;
  }
  if (cmd === 'remove') {
    const entry = isPath(target) ? path.resolve(target) : packageName(target);
    if (!isPath(target) && existsSync(path.join(addonsDir(), 'node_modules', entry))) {
      npm(['uninstall', '--prefix', addonsDir(), '--no-audit', '--no-fund', entry]);
    }
    writeAddonsSetting(
      file,
      current.filter((s) => s !== entry),
    );
    process.stdout.write(
      `Removed ${entry} from ${KEY}. Run \`foundryvtt-mcp stop\` to unload it.\n`,
    );
    return 0;
  }
  process.stderr.write(`Unknown addons command: ${cmd}\n`);
  return 2;
}
