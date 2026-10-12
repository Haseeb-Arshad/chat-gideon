import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
for(const path of ['.env','.env.local'])if(existsSync(path))process.loadEnvFile(path);
const cache=resolve('node_modules/.cache/gideon-plan-b');mkdirSync(cache,{recursive:true});
const output=resolve(cache,'cli.mjs');
await build({entryPoints:['scripts/memory-plan-b-cli.ts'],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',logLevel:'warning'});
await import(pathToFileURL(output).href);
