/**
 * Runs the visitor-notes example.
 *
 *   NOTES_DATA=./data/notes.db NOTES_SECRET=<32+ random characters> \
 *   node node_modules/jiti/lib/jiti-cli.mjs packages/memory/examples/visitor-notes/main.ts
 *
 * Prints "listening <url>". Keep NOTES_SECRET out of source control.
 */
import { createVisitorNotesApp } from './app.ts'

const dataFile = process.env.NOTES_DATA
const secret = process.env.NOTES_SECRET
if (!dataFile || !secret) {
  process.stderr.write('Set NOTES_DATA and NOTES_SECRET.\n')
  process.exit(2)
}
const app = createVisitorNotesApp({ dataFile, secret, port: Number(process.env.NOTES_PORT) || 0 })
await app.publish('The shop is open from 9 to 5 on weekdays', 'opening-hours')
await app.publish('Returns are accepted within 30 days with a receipt', 'returns')
process.stdout.write(`listening ${await app.listen()}\n`)
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)) })
