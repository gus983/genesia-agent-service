import express from 'express';
import { getPool } from '../db/index.js';
import { llmReply } from '../lib/llm.js';

function inferMarketFromWaId(wa_id = '') {
  const s = String(wa_id).replace(/^\+/, '');
  if (s.startsWith('57')) return 'CO';
  if (s.startsWith('51')) return 'PE';
  if (s.startsWith('54')) return 'AR';
  return null;
}

function classifyContactType(text = '') {
  const t = String(text).toLowerCase();
  if (/\b(dra\.?|dr\.?|doctora|doctor|obstetra|ginec(o|ó)logo)\b/.test(t)) return 'medico';
  if (/\b(cl[ií]nica|hospital|instituci(o|ó)n|laboratorio|centro m(e|é)dico)\b/.test(t)) return 'institucion';
  if (/\b(embarazad|mi embarazo|estoy embarazada|paciente|mi beb(e|é))\b/.test(t)) return 'paciente';
  return 'unknown';
}

function contextDays() {
  const n = Number(process.env.CONTEXT_DAYS || 60);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 60;
}

function contextMaxMessages() {
  const n = Number(process.env.CONTEXT_MAX_MESSAGES || 40);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 40;
}

async function fetchRecentTranscript(client, wa_id) {
  const days = contextDays();
  const max = contextMaxMessages();

  const { rows } = await client.query(
    `SELECT direction, text, created_at
     FROM messages
     WHERE wa_id = $1
       AND created_at >= now() - ($2 || ' days')::interval
     ORDER BY created_at DESC
     LIMIT $3`,
    [wa_id, String(days), max]
  );

  // rows are newest-first; reverse to chronological
  return rows.reverse().map((r) => {
    const role = r.direction === 'out' ? 'Valeria' : 'Contacto';
    const t = String(r.text || '').replace(/\s+/g, ' ').trim();
    return `${role}: ${t}`;
  });
}

function classifyInterest(text = '') {
  const t = String(text).toLowerCase();
  if (/\b(nipt|trisom(i|í)a|down|tamiz|aneuploid|cfdna)\b/.test(t)) return 'nipt';
  if (/\b(c(a|á)ncer|oncolog)\b/.test(t)) return 'cancer';
  return 'unknown';
}

function extractIntent(text = '') {
  const t = String(text).toLowerCase();
  if (/\b(precio|precios|cu[aá]nto|cuanto|valor|costo|costos|tarifa|arancel)\b/.test(t)) return 'pricing';
  if (/\b(opciones|opci(o|ó)n|tests?|men[uú]|alternativas)\b/.test(t)) return 'options';
  if (/\b(proceso|procedimiento|log[ií]stica|pasos|turno|muestra|toma|resultado|entrega)\b/.test(t)) return 'procedure';
  if (/\b(honorario|honorarios|comisi(o|ó)n|comisiones)\b/.test(t)) return 'honorarium';
  return 'general';
}

async function fetchKnowledgeItem(client, { domain, kind, market, key }) {
  const { rows } = await client.query(
    `SELECT data, updated_at
     FROM knowledge_items
     WHERE domain=$1 AND kind=$2 AND key=$3 AND market IS NOT DISTINCT FROM $4
     LIMIT 1`,
    [domain, kind, key, market]
  );
  return rows[0] || null;
}

const SYSTEM_PROMPT = [
  "Sos Valeria, especialista en implementación de NIPT para obstetras (Genesia).",
  "Tono: breve, profesional, claro. Un bloque conceptual por mensaje.",
  "Objetivo: ayudar a incorporar NIPT de forma simple, segura y profesional; mover 1 etapa por conversación con 1 pregunta concreta.",
  "Nunca prometas certezas: NIPT es screening, no diagnóstico.",
  "Si no tenés un dato específico, decilo con honestidad y pedí 1 dato para poder confirmarlo (ej. ciudad).",
].join('\n');

function kbMaxItems() {
  const n = Number(process.env.KB_MAX_ITEMS || 50);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
}

function kbMaxJsonChars() {
  const n = Number(process.env.KB_MAX_JSON_CHARS || 25000);
  return Number.isFinite(n) && n > 1000 ? Math.min(n, 200000) : 25000;
}

async function fetchIncludeKinds(client, { domain }) {
  const { rows } = await client.query(
    `SELECT data
     FROM knowledge_items
     WHERE domain=$1 AND kind='config' AND key='kb.include_kinds' AND market IS NULL
     LIMIT 1`,
    [domain]
  );

  const kinds = rows?.[0]?.data?.kinds;
  if (Array.isArray(kinds) && kinds.length) return kinds.map(k => String(k).trim()).filter(Boolean);

  // safe default if config missing
  return ['pricing', 'product_specs', 'logistics', 'faq', 'scripts'];
}

async function fetchKnowledgeBundle(client, { domain, market }) {
  const kinds = await fetchIncludeKinds(client, { domain });
  const maxItems = kbMaxItems();

  const { rows } = await client.query(
    `SELECT domain, kind, market, key, data, updated_at
     FROM knowledge_items
     WHERE domain=$1
       AND kind = ANY($2::text[])
       AND (market IS NULL OR market = $3)
     ORDER BY updated_at DESC
     LIMIT $4`,
    [domain, kinds, market, maxItems]
  );

  return rows;
}

function trimJsonForPrompt(obj) {
  const maxChars = kbMaxJsonChars();
  const s = JSON.stringify(obj, null, 2);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n... (truncated to ${maxChars} chars)`;
}


export function replyRouter() {
  const r = express.Router();

  r.post('/', async (req, res) => {
    const { wa_id, text, country } = req.body || {};
    if (!wa_id) return res.status(400).json({ ok: false, error: 'missing_wa_id' });

    const pool = getPool();
    const client = await pool.connect();

    const userText = String(text || '').trim();
    const inferredMarket = inferMarketFromWaId(wa_id);
    const inferredContactType = classifyContactType(userText);
    const inferredInterest = classifyInterest(userText);
    const intent = extractIntent(userText);

    try {
      await client.query('BEGIN');

      // Upsert contact
      await client.query(
        `INSERT INTO contacts (wa_id, country, contact_type, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (wa_id) DO UPDATE SET
           country = COALESCE(EXCLUDED.country, contacts.country),
           contact_type = CASE
             WHEN contacts.contact_type = 'unknown' AND EXCLUDED.contact_type <> 'unknown' THEN EXCLUDED.contact_type
             ELSE contacts.contact_type
           END,
           updated_at = now()`,
        [wa_id, country || inferredMarket || null, inferredContactType]
      );

      // If asking for honorarium and not confirmed as doctor: be subtle (no mention of honorarios/tables)
      if (intent === 'honorarium') {
        const ctRes = await client.query(`SELECT contact_type FROM contacts WHERE wa_id=$1`, [wa_id]);
        const contactType = ctRes.rows?.[0]?.contact_type || inferredContactType || 'unknown';

        if (contactType !== 'medico') {
          const replyText = 'Perfecto. Para ayudarte mejor: ¿sos profesional de la salud? ¿Tu nombre y ciudad?';

          // Log outbound
          await client.query(
            `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'out',$2,$3)`,
            [wa_id, replyText, { provider: 'rule', rule: 'honorarium_gate_v1' }]
          );

          await client.query('COMMIT');
          return res.json({ ok: true, reply: replyText, action: { kind: 'text' } });
        }
      }

      // Minimal state update
      if (inferredInterest !== 'unknown') {
        await client.query(
          `INSERT INTO contact_state (wa_id, product_interest, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (wa_id) DO UPDATE SET product_interest = EXCLUDED.product_interest, updated_at = now()`,
          [wa_id, inferredInterest]
        );
      }

      // Log inbound
      await client.query(
        `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'in',$2,$3)`,
        [wa_id, userText, { source: 'wa-bridge', intent, inferredMarket, inferredContactType, inferredInterest }]
      );

      // Fetch relevant facts (KB)
      const market = inferredMarket || (country ? String(country).toUpperCase() : null);

      const facts = {
        market,
        contact_type: inferredContactType,
        interest: inferredInterest,
        intent,
        knowledge: {}
      };

      // Pricing/options share same KB item
      if (intent === 'pricing' || intent === 'options' || intent === 'honorarium') {
        if (market) {
          const kb = await fetchKnowledgeItem(client, { domain: 'nipt', kind: 'pricing', market, key: 'nipt.pricing' });
          if (kb) facts.knowledge.nipt_pricing = kb;
        }
      }

      const facts = {
        market,
        contact_type: inferredContactType,
        interest: inferredInterest,
        intent,
      };

      // Generic KB bundle (market-specific + global)
      const domain = inferredInterest === 'cancer' ? 'cancer' : 'nipt';
      const knowledgeBundle = await fetchKnowledgeBundle(client, { domain, market });

      facts.knowledge_bundle = knowledgeBundle.map((k) => ({
        domain: k.domain,
        kind: k.kind,
        market: k.market,
        key: k.key,
        updated_at: k.updated_at,
        data: k.data
      }));

         // Build user prompt with facts + recent transcript
      const transcriptLines = await fetchRecentTranscript(client, wa_id);

      const userPrompt = [
        `Mensaje actual: ${userText}`,
        '',
        `Transcript reciente (últimos ${contextDays()} días, máx ${contextMaxMessages()} mensajes):`,
        transcriptLines.length ? transcriptLines.join('\n') : '(sin historial)',
        '',
        'Contexto (facts JSON):',
        trimJsonForPrompt(facts)
        '',
        'Instrucciones:',
        '- Respondé natural, breve y profesional.',
        '- Si el usuario pregunta precios u opciones: usar nipt_pricing si está presente.',
        '- Honorarios médicos: solo mencionarlos si contact_type == "medico". Si no, pedir confirmación sin mencionar honorarios/tablas.',
        '- Cerrá con 1 pregunta concreta para avanzar.'
      ].join('\n');

      const out = await llmReply({ system: SYSTEM_PROMPT, user: userPrompt });
      const replyText = String(out?.text || '').trim() || 'Gracias. ¿En qué ciudad estás y si es para una paciente o para tu práctica médica?';

      // Log outbound
      await client.query(
        `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'out',$2,$3)`,
        [wa_id, replyText, { provider: out.provider, ms: out.ms }]
      );

      await client.query('COMMIT');

      return res.json({ ok: true, reply: replyText, action: { kind: 'text' } });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('reply failed:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'reply_failed' });
    } finally {
      client.release();
    }
  });

  return r;
}