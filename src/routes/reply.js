import express from 'express';
import { getPool } from '../db/index.js';
import { llmReply } from '../lib/llm.js';
import { notifyAdmin } from '../lib/notify.js';

function inferMarketFromWaId(wa_id = '') {
  const s = String(wa_id).replace(/^\+/, '');
  if (s.startsWith('57')) return 'CO';
  if (s.startsWith('51')) return 'PE';
  if (s.startsWith('54')) return 'AR';
  return null;
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

  // safe default — no scripts: principles live in system prompt, not DB
  return ['pricing', 'product_specs', 'logistics', 'faq'];
}

function kbMaxItems() {
  const n = Number(process.env.KB_MAX_ITEMS || 50);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
}

function kbMaxJsonChars() {
  const n = Number(process.env.KB_MAX_JSON_CHARS || 25000);
  return Number.isFinite(n) && n > 1000 ? Math.min(n, 200000) : 25000;
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

function formatKnowledgeBundle(rows) {
  if (!rows.length) return '(sin información disponible)';
  const maxChars = kbMaxJsonChars();

  let result = rows.map(k => {
    const scope = k.market || 'global';
    const header = `### ${k.kind} / ${k.key} [${scope}]`;
    const body =
      typeof k.data?.text === 'string' ? k.data.text :
      typeof k.data?.content === 'string' ? k.data.content :
      JSON.stringify(k.data, null, 2);
    return `${header}\n${body}`;
  }).join('\n\n');

  if (result.length > maxChars) result = result.slice(0, maxChars) + '\n... (truncado)';
  return result;
}

const SYSTEM_PROMPT = [
  'Sos Valeria, asesora clínica de Genesia especializada en NIPT y oncología molecular.',
  '',
  'ROL: Especialista par, no vendedora. Con médicos: de igual a igual, lenguaje clínico. Con pacientes: cálida y directa, sin tecnicismos.',
  '',
  'OBJETIVO POR MENSAJE: avanzar exactamente 1 etapa en la conversación. Cerrar con exactamente 1 pregunta concreta. Nunca dos preguntas en el mismo mensaje.',
  '',
  'COMPORTAMIENTO SEGÚN TIPO DE CONTACTO:',
  '- medico_derivador (verificado): logística, derivación, cobertura, honorarios si el médico los menciona.',
  '- medico_derivador (no verificado): igual, pero el sistema ya bloqueó la consulta de honorarios — no menciones ese tema.',
  '- paciente: explicar NIPT en lenguaje simple, orientar a consultar con su obstetra.',
  '- institucion: convenio, volumen, integración operativa.',
  '- unknown: entender primero quién es y qué busca antes de dar información.',
  '',
  'PRINCIPIOS CLÍNICOS:',
  '- NIPT es screening, no diagnóstico. Nunca garantizar resultados.',
  '- Ante incertidumbre, pedir exactamente 1 dato para poder confirmar.',
  '- Usar el historial para no repetir preguntas ya respondidas.',
  '',
  'TONO Y FORMATO:',
  '- Respuestas de 2-4 líneas + 1 pregunta.',
  '- Sin frases vacías: "¡Claro!", "Por supuesto", "¿En qué más puedo ayudarte?".',
  '- Sin emojis salvo que el contacto los use primero.',
  '',
  'NUNCA:',
  '- Prometer certezas clínicas.',
  '- Revelar honorarios o comisiones a contactos no verificados.',
  '- Hacer dos preguntas en el mismo mensaje.',
  '- Afirmar que algo ocurrió (envío de credenciales, llamadas, correos) si no hay evidencia explícita en el historial. En caso de duda, usar [ESCALAR].',
  '',
  'ESCALACIÓN:',
  'Si el Conocimiento disponible no tiene los datos necesarios para responder con precisión, iniciá tu respuesta con exactamente `[ESCALAR]` (sin espacio después). Luego respondé igual de forma honesta ("No tengo esa información ahora, pero lo voy a consultar"). Nunca uses [ESCALAR] si podés responder con lo que tenés.',
].join('\n');

export function replyRouter() {
  const r = express.Router();

  r.post('/', async (req, res) => {
    const { wa_id, text, country } = req.body || {};
    if (!wa_id) return res.status(400).json({ ok: false, error: 'missing_wa_id' });

    const pool = getPool();
    const client = await pool.connect();

    const userText = String(text || '').trim();
    const inferredMarket = inferMarketFromWaId(wa_id);
    const inferredInterest = classifyInterest(userText);
    const intent = extractIntent(userText);

    try {
      await client.query('BEGIN');

      // Upsert contact (minimal — classification is done by wa-bridge)
      await client.query(
        `INSERT INTO contacts (wa_id, country, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (wa_id) DO UPDATE SET
           country = COALESCE(EXCLUDED.country, contacts.country),
           updated_at = now()`,
        [wa_id, country || inferredMarket || null]
      );

      // Read contact state once — reuse for gate + facts
      const ctRes = await client.query(
        `SELECT contact_type, verified_doctor FROM contacts WHERE wa_id = $1 LIMIT 1`,
        [wa_id]
      );
      const contactType = ctRes.rows?.[0]?.contact_type || 'unknown';
      const verifiedDoctor = ctRes.rows?.[0]?.verified_doctor === true;

      // Honorarium hard guardrail — must be verified doctor
      if (intent === 'honorarium' && !verifiedDoctor) {
        const replyText = '¿Sos obstetra/ginecólogo/médico?';

        await client.query(
          `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'out',$2,$3)`,
          [wa_id, replyText, { provider: 'rule', rule: 'honorarium_gate_v2' }]
        );

        await client.query('COMMIT');
        return res.json({ ok: true, reply: replyText, action: { kind: 'text' } });
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
      const market = inferredMarket || (country ? String(country).toUpperCase() : null);

      await client.query(
        `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'in',$2,$3)`,
        [wa_id, userText, { source: 'wa-bridge', intent, inferredMarket, inferredInterest }]
      );

      // Fetch KB (market-specific + global)
      const domain = inferredInterest === 'cancer' ? 'cancer' : 'nipt';
      const knowledgeRows = await fetchKnowledgeBundle(client, { domain, market });
      const knowledgeMarkdown = formatKnowledgeBundle(knowledgeRows);

      // Fetch transcript
      const transcriptLines = await fetchRecentTranscript(client, wa_id);

      // Build user prompt as clean sections
      const contactLabel = contactType === 'unknown' ? 'desconocido' : contactType;
      const doctorLabel = verifiedDoctor ? 'sí (verificado)' : 'no';

      const userPrompt = [
        '## Contacto',
        `- Tipo: ${contactLabel}`,
        `- Médico verificado: ${doctorLabel}`,
        `- Market: ${market || 'desconocido'}`,
        `- Interés detectado: ${inferredInterest}`,
        '',
        `## Historial reciente (últimos ${contextDays()} días, máx ${contextMaxMessages()} mensajes)`,
        transcriptLines.length ? transcriptLines.join('\n') : '(sin historial previo)',
        '',
        '## Conocimiento disponible',
        knowledgeMarkdown,
        '',
        '## Mensaje actual',
        userText,
        '',
        '---',
        'Respondé según tu rol y el historial. Cerrá con exactamente 1 pregunta. Sin frases vacías.',
      ].join('\n');

      const out = await llmReply({ system: SYSTEM_PROMPT, user: userPrompt });
      let rawText = String(out?.text || '').trim();

      // Detect escalation signal and strip it before sending to user
      const shouldEscalate = rawText.startsWith('[ESCALAR]');
      const replyText = shouldEscalate
        ? rawText.replace(/^\[ESCALAR\]\s*/, '').trim()
        : rawText || '¿En qué puedo ayudarte hoy?';

      // Fire-and-forget admin notification
      if (shouldEscalate) {
        notifyAdmin({ wa_id, userText, replyText }).catch(e =>
          console.error('notifyAdmin failed:', e?.message || e)
        );
      }

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
