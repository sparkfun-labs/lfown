// LFOwn — the agent API as an MCP server, at /mcp.
//
// Claude, ChatGPT (developer mode and apps), Cursor and most agent frameworks connect
// to remote MCP servers by URL alone, so this is the way "launch a token on LFOwn"
// works in a chat without anyone pasting an API description first.
//
// Streamable HTTP, stateless, JSON responses only — nothing here streams. It speaks
// both eras of the protocol, because clients will be on both for a long while:
//
//   modern (2026-07-28)  no handshake; every request names its version in
//                        `_meta`, echoed in the MCP-Protocol-Version header, and the
//                        server answers `server/discover`.
//   legacy (≤2025-11-25) an `initialize` handshake first, then plain requests. No
//                        session id is issued, which the legacy transport allows.
//
// The tools are thin: each one is the matching /api/agent handler, so the HTTP API
// and MCP can never disagree about what a launch is.

import { AgentError, agentOptions, prepareLaunch, submitLaunch, DEFAULT_HOLDER_PCT } from './agent.mjs'
import { HOLDER_MAX_PCT } from './lib/fee-split.mjs'
import { TIERS } from './lib/config.mjs'

const MODERN = ['2026-07-28']
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const SERVER_INFO = { name: 'lfown', title: 'LFOwn', version: '1.0.0' }

const INSTRUCTIONS = `LFOwn launches memecoins on Solana, each paired with a MetaDAO ownership coin instead of SOL.
To launch: call list_launch_options, pick an ownership coin with the user, then prepare_launch.
If you cannot sign Solana transactions (you have no wallet), call prepare_launch without "creator" and give the user the launchUrl it returns: they review and sign on the site.
If you control a wallet, pass it as "creator", sign every returned transaction unchanged, and call submit_launch within about a minute.
Nothing is ever signed for the creator, and the creator's wallet is the one that earns the fees.`

const TOOLS = [
  {
    name: 'list_launch_options',
    title: 'List launch options',
    description: 'Ownership coins a new coin can be paired with, the tiers open for each (how much the curve must raise to graduate), the trading-fee split and the limits on names, images and dev buys.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'prepare_launch',
    title: 'Prepare a coin launch',
    description: 'Stores the coin\'s image and metadata and prepares its launch. Without "creator": returns launchUrl, a link where a person reviews everything and signs with their own wallet — use this when you have no wallet. With "creator": returns base64 transactions already signed by the new mint, for that wallet to sign unchanged and pass to submit_launch.',
    inputSchema: {
      type: 'object',
      required: ['name', 'symbol', 'quote'],
      properties: {
        name: { type: 'string', maxLength: 32, description: 'Coin name' },
        symbol: { type: 'string', maxLength: 10, description: 'Ticker, without $' },
        quote: { type: 'string', description: 'Symbol or mint of the ownership coin to pair with, from list_launch_options' },
        tier: { type: 'string', enum: TIERS.map((t) => t.id), description: 'Graduation tier; defaults to the first open one' },
        description: { type: 'string', maxLength: 500 },
        imageUrl: { type: 'string', description: 'http(s) URL of a png, jpeg, webp or gif under 2 MB' },
        imageData: { type: 'string', description: 'The image as a base64 data URL, if there is no URL for it' },
        website: { type: 'string' },
        twitter: { type: 'string', description: 'X handle or URL' },
        holderPct: { type: 'integer', minimum: 0, maximum: HOLDER_MAX_PCT, default: DEFAULT_HOLDER_PCT, description: 'Points of the whole trading fee given to holders out of the creator\'s half; paid hourly, pro rata. Fixed at launch.' },
        devBuyPercent: { type: 'number', minimum: 0, maximum: 50, default: 0, description: 'Percent of supply the creator buys at launch, paid in the ownership coin' },
        creator: { type: 'string', description: 'Solana wallet that signs and earns the fees. Leave out to get a signing link for a person.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'submit_launch',
    title: 'Submit a signed launch',
    description: 'Sends the transactions from prepare_launch, signed by the creator, in order, waiting for each to confirm. Only transactions this server prepared are accepted.',
    inputSchema: {
      type: 'object',
      required: ['id', 'transactions'],
      properties: {
        id: { type: 'string', description: 'The id prepare_launch returned' },
        transactions: { type: 'array', items: { type: 'string' }, description: 'Each transaction, signed by the creator, base64, in the order returned' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
]

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
}

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, authorization',
  'access-control-expose-headers': 'mcp-protocol-version',
}

const send = (body, status = 200) => new Response(JSON.stringify(body), { status, headers })
const failure = (id, code, message, data, status = 200) =>
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }, status)

/**
 * A browser page on another site must not drive this endpoint through a visitor's
 * network position — the rebinding attack the transport spec asks servers to stop.
 * Server-side clients send no Origin at all; browser-based ones are on https.
 */
function originAllowed(request, url) {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    const o = new URL(origin)
    return o.protocol === 'https:' || o.origin === url.origin
  } catch {
    return false
  }
}

async function callTool(name, args, ctx) {
  const { env, origin, deps } = ctx
  try {
    let result
    if (name === 'list_launch_options') result = await agentOptions(env, deps)
    else if (name === 'prepare_launch') result = await prepareLaunch(env, origin, args ?? {}, deps)
    else if (name === 'submit_launch') result = await submitLaunch(env, origin, args ?? {}, deps)
    else return null
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }
  } catch (e) {
    // A refused launch is something the model should read and act on — a symbol too
    // long, a coin not open — so it comes back as a tool result, not a protocol error.
    const message = e instanceof AgentError ? e.message : `something went wrong: ${e.message}`
    if (!(e instanceof AgentError)) console.error(`mcp ${name}: ${e.stack ?? e.message}`)
    const details = e instanceof AgentError && e.details ? `\n${JSON.stringify(e.details)}` : ''
    return { content: [{ type: 'text', text: message + details }], isError: true }
  }
}

/** One JSON-RPC message in, one Response out. */
async function handleMessage(msg, request, ctx) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return failure(msg?.id, ERR.invalidRequest, 'expected a JSON-RPC 2.0 request', null, 400)
  }
  const { id, method, params } = msg
  const isNotification = id === undefined

  // Headers the modern transport requires to mirror the body, so a gateway can route
  // without parsing it. When present they must agree.
  const hMethod = request.headers.get('mcp-method')
  if (hMethod && hMethod !== method) {
    return failure(id, ERR.headerMismatch, `Mcp-Method header "${hMethod}" does not match method "${method}"`, null, 400)
  }
  const hName = request.headers.get('mcp-name')
  if (hName && method === 'tools/call' && params?.name && hName !== params.name) {
    return failure(id, ERR.headerMismatch, `Mcp-Name header "${hName}" does not match tool "${params.name}"`, null, 400)
  }

  const bodyVersion = params?._meta?.['io.modelcontextprotocol/protocolVersion']
  const headerVersion = request.headers.get('mcp-protocol-version')
  if (bodyVersion && headerVersion && bodyVersion !== headerVersion) {
    return failure(id, ERR.headerMismatch, `MCP-Protocol-Version header "${headerVersion}" does not match _meta protocolVersion "${bodyVersion}"`, null, 400)
  }

  // ── legacy handshake ──
  if (method === 'initialize') {
    const asked = params?.protocolVersion
    const protocolVersion = LEGACY.includes(asked) ? asked : LEGACY[0]
    return send({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
    })
  }

  const version = bodyVersion ?? headerVersion
  const modern = Boolean(bodyVersion) || MODERN.includes(headerVersion)
  if (version && !MODERN.includes(version) && !LEGACY.includes(version)) {
    return failure(id, ERR.unsupportedVersion, `unsupported protocol version "${version}"`, { supported: [...MODERN, ...LEGACY] }, 400)
  }
  if (bodyVersion && !MODERN.includes(bodyVersion)) {
    return failure(id, ERR.unsupportedVersion, `protocol version "${bodyVersion}" uses the initialize handshake, not _meta`, { supported: MODERN }, 400)
  }

  if (isNotification) return new Response(null, { status: 202, headers })

  const ok = (result) => send({ jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result } : result })

  switch (method) {
    case 'server/discover':
      return ok({
        supportedVersions: MODERN,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: 'public',
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOLS })
    case 'tools/call': {
      if (!params?.name) return failure(id, ERR.invalidParams, 'tools/call needs a tool name', null, 400)
      if (params.name !== 'list_launch_options' && await ctx.deps.limited(ctx.env.HEAVY_LIMITER, request)) {
        return ok({ content: [{ type: 'text', text: 'Too many requests from this address; try again in a minute.' }], isError: true })
      }
      const result = await callTool(params.name, params.arguments, ctx)
      if (!result) return failure(id, ERR.invalidParams, `unknown tool "${params.name}"`, null, 400)
      return ok(result)
    }
    default:
      return failure(id, ERR.methodNotFound, `method "${method}" is not supported`, null, 404)
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function landingPage(origin) {
  const o = escapeHtml(origin)
  const endpoint = `${o}/mcp`
  const block = (text) => `<pre><code>${escapeHtml(text)}</code></pre>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LFOwn MCP server</title>
<meta name="robots" content="noindex">
<style>
  :root{--ink:#141414;--paper:#f4efe6;--red:#e0342b;--mute:#5d5850}
  @media (prefers-color-scheme:dark){:root{--ink:#f4efe6;--paper:#141414;--mute:#a39d93}}
  body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,sans-serif}
  main{max-width:720px;margin:0 auto;padding:48px 20px 64px}
  h1{font-size:clamp(28px,6vw,44px);line-height:1;margin:0 0 12px;text-transform:uppercase;letter-spacing:-.02em}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;margin:36px 0 8px}
  p{margin:0 0 12px}.mute{color:var(--mute)}
  .url{display:flex;gap:8px;align-items:center;border:1.5px solid var(--ink);box-shadow:6px 6px 0 var(--ink);padding:14px 16px;margin:24px 0;font:600 17px ui-monospace,monospace;overflow-x:auto}
  .url span{color:var(--red)}
  pre{border:1.5px solid var(--ink);padding:12px 14px;overflow-x:auto;margin:8px 0 12px;font:13px/1.5 ui-monospace,monospace}
  a{color:var(--red)}
</style></head><body><main>
<h1>LFOwn MCP server</h1>
<p>This URL is for AI agents, not browsers. Add it to Claude, ChatGPT, Cursor or any MCP client and ask it to <b>launch a token on LFOwn</b>.</p>
<div class="url"><span>●</span>${endpoint}</div>
<p class="mute">Remote MCP over Streamable HTTP · no key, no login · tools: list_launch_options, prepare_launch, submit_launch. Nothing is ever signed for you: the agent hands you a link, or a wallet you control signs.</p>

<h2>Claude</h2>
<p>Settings → Connectors → Add custom connector → paste the URL, leave OAuth empty.</p>
<p>Claude Code:</p>${block(`claude mcp add --transport http lfown ${origin}/mcp`)}

<h2>ChatGPT</h2>
<p>Settings → Apps &amp; Connectors → Advanced settings → Developer mode, then create a connector with the URL and no authentication.</p>

<h2>Cursor</h2>${block(`{ "mcpServers": { "lfown": { "url": "${origin}/mcp" } } }`)}

<h2>VS Code</h2>${block(`{ "servers": { "lfown": { "type": "http", "url": "${origin}/mcp" } } }`)}

<h2>Anything else</h2>
<p>Use the URL as a remote HTTP MCP server. For stdio-only clients:</p>${block(`npx -y mcp-remote ${origin}/mcp`)}
<p>No MCP? Read <a href="${o}/llms.txt">/llms.txt</a> or the <a href="${o}/api/agent/openapi.json">OpenAPI spec</a>.</p>
<p class="mute"><a href="${o}/">← letsfuckingown.fun</a></p>
</main></body></html>`
}

export async function handleMcp(url, request, env, ctx, deps) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (!originAllowed(request, url)) return failure(null, ERR.invalidRequest, 'origin not allowed', null, 403)
  // Someone pasted the URL into a browser. MCP clients probe with GET and
  // `Accept: text/event-stream` and must get the 405 below; a person should get a page
  // that says what the URL is for, not an error.
  if ((request.method === 'GET' || request.method === 'HEAD') && (request.headers.get('accept') ?? '').includes('text/html')) {
    const origin = env.PUBLIC_ORIGIN || url.origin
    return new Response(request.method === 'HEAD' ? null : landingPage(origin), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
    })
  }
  // Nothing here streams or keeps a session, so there is no stream to open and none to end.
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...headers, allow: 'POST, OPTIONS' } })
  }

  let msg
  try {
    msg = await request.json()
  } catch {
    return failure(null, ERR.parse, 'body is not JSON', null, 400)
  }
  if (Array.isArray(msg)) return failure(null, ERR.invalidRequest, 'batched requests are not supported', null, 400)

  const context = { env, origin: env.PUBLIC_ORIGIN || url.origin, deps }
  try {
    return await handleMessage(msg, request, context)
  } catch (e) {
    console.error(`mcp: ${e.stack ?? e.message}`)
    return failure(msg?.id, ERR.internal, 'internal error', null, 500)
  }
}

export { TOOLS }
