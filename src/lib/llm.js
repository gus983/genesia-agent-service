function pickTextFromClaude(data) {
  const parts = Array.isArray(data?.content) ? data.content : [];
  return parts
    .filter(p => p && p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('')
    .trim();
}

export async function claudeReply({ system, user, model }) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) throw new Error('Missing env: ANTHROPIC_API_KEY');
  const m = model || process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: m,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    const err = new Error(`Claude error ${resp.status}: ${msg}`);
    err.status = resp.status;
    err.meta = data;
    throw err;
  }

  return pickTextFromClaude(data);
}

function pickTextFromOpenAIResponses(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const out = Array.isArray(data.output) ? data.output : [];
  let text = '';
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
      if (c?.type === 'text' && typeof c.text === 'string') text += c.text;
    }
  }
  return (text || '').trim();
}

export async function openaiReply({ system, user, model }) {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) throw new Error('Missing env: OPENAI_API_KEY');
  const m = model || process.env.OPENAI_MODEL || 'gpt-5.2';

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: m,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_output_tokens: 600,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    const err = new Error(`OpenAI error ${resp.status}: ${msg}`);
    err.status = resp.status;
    err.meta = data;
    throw err;
  }

  return pickTextFromOpenAIResponses(data);
}

export async function llmReply({ system, user, model }) {
  const t0 = Date.now();
  try {
    const out = await claudeReply({ system, user, model });
    return { ok: true, provider: 'anthropic', ms: Date.now() - t0, text: out };
  } catch (e) {
    // fallback
    const out = await openaiReply({ system, user });
    return { ok: true, provider: 'openai', ms: Date.now() - t0, text: out };
  }
}