// web3.js still reaches for Node's Buffer; give it one in the browser.
import { Buffer } from 'buffer'
globalThis.Buffer = globalThis.Buffer ?? Buffer
globalThis.global = globalThis

// Some Solana packages read `process.env` at load time even in browser builds.
globalThis.process = globalThis.process ?? { env: {}, browser: true, version: '', versions: {} }
