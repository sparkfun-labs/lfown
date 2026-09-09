// Anchor's utf8 helper reaches for Node's `util` in a branch the browser never runs,
// but a bundler resolves both branches. The browser has these natively.
export const TextDecoder = globalThis.TextDecoder
export const TextEncoder = globalThis.TextEncoder
export default { TextDecoder, TextEncoder }
