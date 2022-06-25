// import { NSRVM } from 'nsrvm'
import { NSRVM } from '../src/index.mjs'
import { fileURLToPath } from 'url'
import path from 'path'

const SERVICES_DIR = 'services'

console.log('NSRVM')

const __dirname = fileURLToPath(path.dirname(import.meta.url))
const nsrvm = new NSRVM(__dirname, SERVICES_DIR)

nsrvm.init().catch(e => console.error(e))
