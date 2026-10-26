// Cloudflare Worker: receives a guest's {name, message} and commits it to
// messages.json in the GitHub repo. The commit message is the guest's name.
//
// Secrets (wrangler secret put): GITHUB_TOKEN
// Vars (wrangler.toml): GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, FILE_PATH, ALLOWED_ORIGIN

const MAX_NAME = 80;
const MAX_MESSAGE = 2000;
const MAX_ATTEMPTS = 6;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
    // Blocks other websites from posting via browsers. Not a hard security
    // boundary (curl can fake Origin), but filters casual abuse.
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
      return json({ error: 'Forbidden' }, 403, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid request' }, 400, cors);
    }

    // Honeypot: real guests never see this field. Pretend success for bots.
    if (body.website) return json({ ok: true }, 200, cors);

    const name = clean(body.name, MAX_NAME).replace(/\s+/g, ' '); // single line, used as commit message
    const message = clean(body.message, MAX_MESSAGE);
    if (!name || !message) {
      return json({ error: 'Please add your name and a message.' }, 400, cors);
    }

    const entry = {
      id: crypto.randomUUID(),
      name,
      message,
      createdAt: new Date().toISOString(),
    };

    try {
      await appendEntry(env, entry);
    } catch (err) {
      console.error('Failed to save message', err);
      return json({ error: 'Could not save your message. Please try again.' }, 502, cors);
    }
    return json({ ok: true }, 200, cors);
  },
};

// Read messages.json, append, write back. If another guest committed in
// between, GitHub rejects the stale SHA (409) and we retry with backoff.
export async function appendEntry(env, entry) {
  const branch = env.GITHUB_BRANCH || 'main';
  const path = env.FILE_PATH || 'messages.json';
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wedding-messages-worker',
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
    let messages = [];
    let sha;
    if (getRes.status === 200) {
      const file = await getRes.json();
      sha = file.sha;
      messages = JSON.parse(decodeBase64(file.content));
      if (!Array.isArray(messages)) throw new Error(`${path} is not a JSON array`);
    } else if (getRes.status !== 404) {
      throw new Error(`GET ${path} failed: ${getRes.status} ${await getRes.text()}`);
    }

    messages.push(entry);

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: entry.name, // commit message = guest's name
        content: encodeBase64(JSON.stringify(messages, null, 2) + '\n'),
        sha,
        branch,
        author: { name: entry.name, email: 'guest@wedding.invalid' },
      }),
    });

    if (putRes.ok) return;
    if (putRes.status === 409 || putRes.status === 422) {
      await sleep(200 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    throw new Error(`PUT ${path} failed: ${putRes.status} ${await putRes.text()}`);
  }
  throw new Error('Gave up after repeated write conflicts');
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '') // strip control chars, keep \t and \n
    .trim()
    .slice(0, max);
}

// UTF-8 safe base64 (names/messages may contain emoji or non-Latin scripts)
function encodeBase64(str) {
  let bin = '';
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
}
function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
