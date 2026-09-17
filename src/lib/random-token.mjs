// LFOwn — a coin for someone who has no idea for one.
//
// The launch page's "Random" button. One idea per click: a ticker that is also the
// name, a description that is about that ticker, and a picture of the same thing. The
// three are written together, by one model call, so they belong to each other — and
// the picture is drawn from the prompt that call wrote, not from the name alone.
//
// Two requests rather than one: the words come back in about a second and fill the
// form, the picture takes a few more and drops in behind them. The picture is asked
// for by the id of an idea this Worker wrote, never by a prompt the browser sends —
// an endpoint that draws whatever it is told would be a free image generator for
// anyone who found it.

const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell'

/** How long an idea waits for its picture to be asked for. */
const IDEA_TTL = 15 * 60

/**
 * A whole site's worth of ideas per day. Each one is a model call and a picture;
 * together they are cheap, but a loop left running is not, and past this the button
 * says to try tomorrow rather than running up the bill.
 */
export const DAILY_CAP = 1500

// Nudges, drawn at random and handed to the model. Asked for "a memecoin" with nothing
// else, a model hands back the same five dogs and frogs; two unrelated words make it
// invent. Nothing here is a real person, brand or group.
const THINGS = [
  'raccoon', 'toaster', 'octopus', 'cactus', 'penguin', 'volcano', 'snail', 'robot', 'banana', 'wizard',
  'hamster', 'rocket', 'mushroom', 'goblin', 'jellyfish', 'pickle', 'owl', 'meteor', 'sloth', 'dragon',
  'crab', 'cloud', 'axolotl', 'traffic cone', 'pigeon', 'moai statue', 'donut', 'yeti', 'lobster', 'ghost',
  'capybara', 'anvil', 'narwhal', 'teapot', 'gorilla', 'lighthouse', 'shrimp', 'bonsai', 'walrus', 'cyborg',
]
const MOODS = [
  'furious', 'sleepy', 'rich', 'confused', 'heroic', 'tiny', 'enormous', 'cursed', 'wholesome', 'unhinged',
  'royal', 'haunted', 'caffeinated', 'stoic', 'dramatic', 'lucky', 'feral', 'retired', 'galactic', 'suspicious',
]
const STYLES = [
  'bold flat vector mascot, thick outlines', 'glossy 3D render, studio lighting', 'retro 90s cartoon',
  'pixel art, 32-bit', 'claymation figure', 'sticker with white border', 'comic book pop art', 'cute chibi illustration',
]

const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length]

/** Upper-case letters and digits only, 2 to 10 of them — what a ticker field accepts. */
export function cleanTicker(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
}

/**
 * What the model returned, reduced to something safe to put in a form and on chain.
 * Null when there is not enough left of it to be a coin.
 */
export function cleanIdea(raw) {
  const ticker = cleanTicker(raw?.ticker)
  const description = String(raw?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 280)
  const image = String(raw?.image_prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
  if (ticker.length < 2 || !description || !image) return null
  return { ticker, description, image }
}

const SCHEMA = {
  type: 'object',
  properties: {
    ticker: { type: 'string', description: 'One word, 3 to 8 letters, A-Z only. It is both the name and the ticker.' },
    description: { type: 'string', description: 'One or two short, funny sentences about the coin, under 200 characters.' },
    image_prompt: { type: 'string', description: 'A visual description of the mascot for an image model.' },
  },
  required: ['ticker', 'description', 'image_prompt'],
}

/**
 * The words: ticker, description and the picture's prompt, written together.
 *
 * The backing coin is left out on purpose. Given "META", the model wrote about the
 * metaverse every time; a meme about its own mascot reads better than a wrong joke.
 */
export async function writeIdea(ai) {
  const thing = pick(THINGS)
  const mood = pick(MOODS)
  const style = pick(STYLES)

  const out = await ai.run(TEXT_MODEL, {
    messages: [
      {
        role: 'system',
        content: 'You invent memecoins. Funny, punchy, internet-native, never hateful, sexual, political or about real people, brands or tragedies. No promises of profit. Answer with JSON only.',
      },
      {
        role: 'user',
        content: `Invent a memecoin whose mascot is a ${mood} ${thing}. ` +
          'The ticker is a single invented or punny word, 3 to 8 letters, and it is also the coin\'s name. ' +
          'The description is one or two short sentences in English. ' +
          `The image prompt describes the mascot alone, centred, on a plain bright background, in this style: ${style}. No text, letters or logos in the image.`,
      },
    ],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    temperature: 1.1,
    max_tokens: 300,
  })

  let parsed = out?.response
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { parsed = null }
  }
  return cleanIdea(parsed)
}

/** The picture for an idea, as JPEG bytes. */
export async function drawIdea(ai, prompt) {
  const out = await ai.run(IMAGE_MODEL, { prompt, steps: 6 })
  if (!out?.image) throw new Error('the image model returned nothing')
  return Uint8Array.from(atob(out.image), (c) => c.charCodeAt(0))
}

/** Counts one idea against today's cap. False once the cap is reached. */
export async function takeFromCap(kv) {
  if (!kv) return true
  const key = `random:day:${new Date().toISOString().slice(0, 10)}`
  const used = Number(await kv.get(key)) || 0
  if (used >= DAILY_CAP) return false
  // Not atomic: two requests in the same instant can both pass at the edge of the cap.
  // A handful over is fine; the cap bounds a runaway loop, not a single request.
  await kv.put(key, String(used + 1), { expirationTtl: 2 * 86400 })
  return true
}

export const ideaKey = (id) => `random:idea:${id}`
export { IDEA_TTL }
