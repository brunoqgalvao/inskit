// Builds the installable plugin folder: plugin/dist (bundled JS) + plugin/node_modules/playwright-core.
import { cp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve('.');
const plugin = path.join(root, 'plugin');
const dist = path.join(plugin, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const buildId = String(Date.now());
const banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
for (const [entry, file] of [['src/server.ts', 'server.js'], ['src/daemon.ts', 'daemon.js'], ['src/cli.ts', 'cli.js']]) {
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: path.join(dist, file),
    external: ['playwright-core'], banner: { js: banner }, define: { __BUILD_ID__: JSON.stringify(buildId) }, logLevel: 'warning',
  });
}
await chmod(path.join(dist, 'cli.js'), 0o755);

// playwright-core has no dependencies; vendor it so the plugin needs no npm install.
await rm(path.join(plugin, 'node_modules'), { recursive: true, force: true });
await cp(path.join(root, 'node_modules/playwright-core'), path.join(plugin, 'node_modules/playwright-core'), { recursive: true });
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'inskit', version, private: true, type: 'module', engines: { node: '>=22.13' } }, null, 2) + '\n');
console.log(`built plugin ${version} (build ${buildId}) in ${plugin}`);

