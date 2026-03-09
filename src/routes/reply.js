import express from 'express';
import { getPool } from '../db/index.js';
import { llmReply } from '../lib/llm.js';
import { notifyAdmin, notifyAdminReport } from '../lib/notify.js';
import { parseMetaLead, leadToContactUpdate } from '../lib/parseMetaLead.js';

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
  // case_status before honorarium: "no me pagaron" on a specific case should escalate, not hit the gate
  if (/\b(mi paciente|la paciente|su resultado|los resultados|se hizo|se lo hizo|se realiz[oó]|hizo el test|su test|estado del caso|cu[aá]ndo sale|cu[aá]ndo est[aá]|ya tiene|ya sali[oó]|consult[ao] por un caso|por un caso|un caso|les? deriv[eé]|deriv[eé] a|no me lleg[oó]|no lleg[oó]|no me pag[ao]ron|no me mandaron)\b/.test(t)) return 'case_status';
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
     ORDER BY
       CASE kind
         WHEN 'pricing'       THEN 1
         WHEN 'product_specs' THEN 2
         WHEN 'logistics'     THEN 3
         WHEN 'faq'           THEN 4
         WHEN 'facts'         THEN 5
         ELSE 6
       END,
       updated_at DESC
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
  'OBJETIVO POR MENSAJE: avanzar 1 etapa en la conversación.',
  '',
  'COMPORTAMIENTO SEGÚN TIPO DE CONTACTO:',
  '- medico_derivador (verificado): logística, derivación, cobertura, honorarios y comisiones si el médico los menciona.',
  '- medico_derivador (no verificado): igual que verificado, excepto honorarios/comisiones — el sistema ya bloqueó esa consulta.',
  '- paciente: NIPT en lenguaje simple, orientar a su obstetra. Precios de paneles sí podés darlos (son públicos). Nunca mencionés honorarios ni comisiones médicas.',
  '- institucion: convenio, volumen, integración operativa. Precios de lista sí; descuentos o condiciones especiales → [ESCALAR].',
  '- unknown: entender primero quién es y qué busca. Precios de paneles sí podés darlos. Si pide honorarios/comisiones y no está verificado, pedile que confirme su especialidad antes de dar esa información.',
  '',
  'REGLA DE ORO — PRECIOS vs. HONORARIOS:',
  '- Precios de paneles (lo que paga el paciente): PÚBLICOS. Informarlos a cualquier contacto con la moneda del mercado correcto.',
  '- Honorarios/comisiones de derivación (lo que cobra el médico): RESTRINGIDOS. Solo a médicos verificados.',
  '- Descuentos por volumen, convenios institucionales: SIEMPRE [ESCALAR], sin excepción.',
  '',
  'REGLA OPERATIVA — HONORARIOS (anti-loop):',
  '- Si el contacto es médico verificado y pregunta por honorarios/comisiones, NO digas "lo verifico", "lo gestiono", "te aviso" ni ninguna variante de "voy a chequear".',
  '- Si te falta el país/mercado para mostrar el esquema correcto, hacé UNA sola pregunta corta: "¿País (AR/CO/PE)?".',
  '- Si el país está claro (en el historial o en el mensaje) y el dato está en el Conocimiento disponible, respondé con el esquema en ese mismo mensaje, sin pasos intermedios.',
  '',
  'LENGUAJE SEGÚN MERCADO:',
  '- AR: tuteo con voseo ("¿querés?", "contame", "sí").',
  '- CO: tuteo neutro o ustedeo ("¿quieres?", "cuéntame", "claro"). Sin voseo argentino.',
  '- PE: tuteo neutro o ustedeo. Sin voseo argentino.',
  '',
  'PRINCIPIOS CLÍNICOS:',
  '- NIPT es screening, no diagnóstico. Nunca garantizar resultados.',
  '- Ante incertidumbre, pedir exactamente 1 dato para poder confirmar.',
  '- Antes de dar información de logística, centros de extracción o proceso de toma de muestra, confirmá la ciudad o zona del contacto si no la tenés.',
  '- Usar el historial para no repetir ni información ni preguntas ya dadas.',
  '- No evaluar ni elogiar la práctica clínica del médico ("excelente conducta", "muy buena decisión"). Tratalo como par.',
  '- Si el contacto introduce un intent nuevo (menciona "caso", "paciente", "colega", "resultado", "diagnóstico", "alto riesgo") en medio de un flow de materiales o derivación: cerrá ese flow y atendé el intent nuevo. Hacé 1 sola pregunta de triage. No ofrezcas flyers ni textos cuando el contacto está preguntando por un caso clínico.',
  '',
  'TONO Y FORMATO:',
  '- Si el contacto abre con un saludo, respondé con un saludo breve antes de ir al punto.',
  '- Respuestas de 2-4 líneas. Si necesitás más, es una señal de que estás dando demasiado de una vez.',
  '- Sin frases vacías ni muletillas: "¡Claro!", "Por supuesto", "¿En qué más puedo ayudarte?", "Perfecto", "Para ayudarte mejor", "Gracias por escribir", "Gracias por escribirme", "Genial", "Cualquier consulta acá estoy", "¡Con gusto!".',
  '- Sin emojis salvo que el contacto los use primero.',
  '- No filtrés razonamiento interno en el output. Solo el mensaje final al contacto.',
  '- Si el contacto responde con una confirmación breve o cierre conversacional (una frase corta que solo indica "entendido/ok" y NO agrega pregunta nueva ni información nueva), NO sumes una pregunta ni CTA. Respondé con UNA sola frase breve y neutral, sin pregunta. Ejemplos: "Entendido. Quedo a disposición.", "Listo. Cuando quieras, seguimos."',
  '',
  'NUNCA:',
  '- Prometer certezas clínicas ni usar absolutismos: "100% seguro", "sin falsos positivos", "garantizado", "el mejor test".',
  '- Revelar honorarios o comisiones a contactos no verificados.',
  '- Verificar identidad de médico de forma que revele políticas internas. La verificación debe ser conversacional y breve ("¿Sos profesional médico?" o similar).',
  '- Hacer dos preguntas en el mismo mensaje (ni siquiera de forma implícita como "¿X o tal vez Y?").',
  '- Inventar o estimar información que no esté explícitamente en el Conocimiento disponible. Esto incluye sin excepción:',
  '  · Direcciones, horarios o teléfonos de centros de extracción',
  '  · Costos logísticos o de envío (ni rangos estimados)',
  '  · Precios o honorarios de cualquier panel',
  '  · Emails o contactos del equipo operativo',
  '  · Tiempos de resultado por panel o laboratorio',
  '  · Tasas clínicas (sensibilidad, especificidad, tasa de fallo, riesgo de procedimientos)',
  '  · Características técnicas de paneles (qué detecta, compatibilidad con gemelar, semanas mínimas)',
  '  · Existencia o funcionamiento de sistemas internos (panel de seguimiento, credenciales)',
  '  Si el dato no está en el Conocimiento disponible: usá [ESCALAR], sin excepción.',
  '  Excepción: si te piden un flyer o cuadro comparativo descargable, buscá el link en el Conocimiento disponible (logistics / assets.nipt.*) y envialo directamente. Si no está en KB, decí "Lo consigo y te lo paso" — no escalés por material descargable.',
  '- Afirmar que algo ya ocurrió (consulta al equipo, envío de credenciales, llamada, correo) si no hay evidencia explícita en el historial. Usá presente: "Lo estoy derivando al equipo", nunca "Ya lo consulté".',
  '- Confirmar disponibilidad o agenda de terceros (Johanna, el equipo, un laboratorio) sin tener esa información.',
  '- Repetir la misma pregunta si el contacto mostró que no la entendió; en ese caso avanzá sin preguntar.',
  '- **CIERRE — regla dura:** Si el último mensaje del contacto contiene una negativa clara ("no", "no no", "nada", "no ahora", "después", "por el momento no", "está bien así", "listo gracias", "gracias" como cierre, o cualquier rechazo explícito a una oferta) → respondé con UNA sola frase corta de despedida y NO agregues ninguna pregunta ni CTA al final de ese mensaje. La frase de cierre ES el mensaje completo. Ejemplo MAL: "Quedo a disposición. ¿Querés que te pase un flyer?" — Ejemplo BIEN: "Quedo a disposición cuando lo necesites."',
  '- Usar frases como "lo dejamos registrado" o "queda registrado" como si hubiera un sistema automático. Usá "lo tengo en cuenta" o "lo coordinamos" según el contexto.',
  '',
  'ESCALACIÓN — obligatoria en estos casos:',
  '- Preguntas sobre accesos, credenciales, estado de casos, pagos o cualquier dato operativo interno de Genesia que no esté en el Conocimiento disponible.',
  '- Cualquier dato específico de un paciente o derivación concreta.',
  '- Preguntas sobre descuentos por volumen, convenios institucionales o condiciones comerciales especiales.',
  '- Si no tenés el dato y no podés responder con certeza.',
  'Cuando debas escalar: iniciá la respuesta con exactamente `[ESCALAR]` (sin espacio). Luego decile al contacto que lo estás averiguando y que en breve le contestás — no menciones que escalás a un equipo ni que lo derivás a nadie. El contacto debe sentir que vos misma lo estás resolviendo. Ejemplos de cierre correcto: "Dejame verificarlo y te cuento enseguida.", "Dame un momento que lo averiguo.", "Lo consulto y te respondo."',
  'Si ya escalaste la misma consulta en el turno anterior y el contacto vuelve sin respuesta: no repitas el mismo mensaje. Decile que todavía lo estás gestionando y que le avisás ni bien tengas la respuesta.',
  'Si llevás más de 2 turnos con una escalación pendiente y el contacto sigue preguntando: reconocé la demora, ofrecé lo que sí podés responder en ese momento (aunque sea parcial), y confirmá que lo estás gestionando. No repitas el mismo mensaje de escalación.',
  'NO escalés saludos de cierre ni mensajes de cortesía ("gracias", "hasta luego", "fue un placer").',
  'IMPORTANTE: es preferible escalar que inventar. Nunca improvises datos operativos.',
].join('\n');

export function replyRouter() {
  const r = express.Router();

  r.post('/', async (req, res) => {
    const { wa_id, text, country, admin_instruction } = req.body || {};
    if (!wa_id) return res.status(400).json({ ok: false, error: 'missing_wa_id' });

    const pool = getPool();
    const client = await pool.connect();

    const userText = String(text || '').trim();
    const adminInstruction = admin_instruction ? String(admin_instruction).trim() : null;
    const inferredMarket = inferMarketFromWaId(wa_id);
    const inferredInterest = classifyInterest(userText);
    const intent = adminInstruction ? 'admin_reply' : extractIntent(userText);

    try {
      await client.query('BEGIN');

      // Detect Meta lead form payload and enrich contact before anything else
      const metaLead = parseMetaLead(userText);
      if (metaLead) {
        const upd = leadToContactUpdate(metaLead);
        await client.query(
          `INSERT INTO contacts (wa_id, country, contact_type, verified_doctor, verification_source,
              verification_confidence, name, email, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (wa_id) DO UPDATE SET
             country               = COALESCE(contacts.country, EXCLUDED.country),
             contact_type          = EXCLUDED.contact_type,
             verified_doctor       = EXCLUDED.verified_doctor,
             verification_source   = EXCLUDED.verification_source,
             verification_confidence = EXCLUDED.verification_confidence,
             name                  = COALESCE(contacts.name, EXCLUDED.name),
             email                 = COALESCE(contacts.email, EXCLUDED.email),
             updated_at            = now()`,
          [wa_id, country || inferredMarket || null,
           upd.contact_type, upd.verified_doctor, upd.verification_source,
           upd.verification_confidence, upd.name, upd.email]
        );
        console.log(`meta_lead_enriched wa_id=...${String(wa_id).slice(-6)} type=${upd.contact_type}`);
      } else {
        // Upsert contact (minimal — classification is done by wa-bridge)
        await client.query(
          `INSERT INTO contacts (wa_id, country, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (wa_id) DO UPDATE SET
             country = COALESCE(EXCLUDED.country, contacts.country),
             updated_at = now()`,
          [wa_id, country || inferredMarket || null]
        );
      }

      // Read contact state once — reuse for gate + facts
      const ctRes = await client.query(
        `SELECT contact_type, verified_doctor FROM contacts WHERE wa_id = $1 LIMIT 1`,
        [wa_id]
      );
      const contactType = ctRes.rows?.[0]?.contact_type || 'unknown';
      let verifiedDoctor = ctRes.rows?.[0]?.verified_doctor === true;
      let intentEff = intent;

      // Doctor self-identification: verify contact if they mention a medical keyword,
      // or if they give an affirmative response right after the honorarium gate question.
      const GATE_TTL_MS = 30 * 60 * 1000;
      const { rows: lastGateRows } = await client.query(
        `SELECT meta, created_at FROM messages
         WHERE wa_id = $1 AND direction = 'out' AND meta->>'rule' = 'honorarium_gate_v2'
         ORDER BY created_at DESC LIMIT 1`,
        [wa_id]
      );
      const lastGate = lastGateRows[0];
      const gateAge = Date.now() - new Date(lastGate?.created_at || 0).getTime();
      const gatePending = !!lastGate && gateAge < GATE_TTL_MS;

      const mentionsMedKeyword = /\b(obstetra|ginec[oó]|m[eé]dic[oa]|doctor[a]?)\b/i.test(userText);
      // Accept short affirmatives ("Sí", "Ok", "Claro") only when gate is pending — not as standalone self-id
      const isAffirmativeToGate = gatePending && /^(s[ií]|ok\b|claro|exacto|correcto|confirmo)\b/i.test(userText.trim());

      if (!verifiedDoctor && (mentionsMedKeyword || isAffirmativeToGate)) {
        await client.query(
          `UPDATE contacts SET verified_doctor = true, updated_at = now() WHERE wa_id = $1`,
          [wa_id]
        );
        verifiedDoctor = true;
        console.log(`doctor_self_identified wa_id=...${String(wa_id).slice(-6)}`);
        if (gatePending) {
          intentEff = 'honorarium';
          console.log(`gate_confirmed wa_id=...${String(wa_id).slice(-6)}`);
        }
      }

      // Detect if last outbound was admin-triggered — report back after this reply
      const { rows: lastOutRows } = await client.query(
        `SELECT meta FROM messages
         WHERE wa_id = $1 AND direction = 'out'
         ORDER BY created_at DESC LIMIT 1`,
        [wa_id]
      );
      const pendingAdminReport = !adminInstruction && lastOutRows[0]?.meta?.admin_triggered === true;

      // Honorarium hard guardrail — must be verified doctor
      if (intentEff === 'honorarium' && !verifiedDoctor) {
        const replyText = '¿Sos obstetra/ginecólogo/médico?';

        await client.query(
          `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'out',$2,$3)`,
          [wa_id, replyText, { provider: 'rule', rule: 'honorarium_gate_v2' }]
        );

        await client.query('COMMIT');
        return res.json({ ok: true, reply: replyText, escalated: false, action: { kind: 'text' } });
      }

      // product_interest and stage are updated in the CRM upsert after the LLM reply

      // Log inbound
      const market = inferredMarket || (country ? String(country).toUpperCase() : null);

      await client.query(
        `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'in',$2,$3)`,
        [wa_id, userText, { source: 'wa-bridge', intent: intentEff, inferredMarket, inferredInterest }]
      );

      // Fetch KB (market-specific + global)
      const domain = inferredInterest === 'cancer' ? 'cancer' : 'nipt';
      const knowledgeRows = await fetchKnowledgeBundle(client, { domain, market });
      const knowledgeMarkdown = knowledgeRows.length
        ? formatKnowledgeBundle(knowledgeRows)
        : '(sin información disponible)\n⚠️ KB vacío: si la pregunta requiere datos operativos de Genesia, usá [ESCALAR].';

      // Fetch transcript
      const transcriptLines = await fetchRecentTranscript(client, wa_id);

      // Detect assets already sent in this thread (prevent re-offering)
      const sentAssetUrls = transcriptLines
        .filter(l => l.startsWith('Valeria:') && l.includes('genesia.la/assets/'))
        .flatMap(l => l.match(/https:\/\/genesia\.la\/assets\/\S+/g) || []);

      // Build user prompt as clean sections
      const contactLabel = contactType === 'unknown' ? 'desconocido' : contactType;
      const doctorLabel = verifiedDoctor ? 'sí (verificado)' : 'no'; // verifiedDoctor may have been updated by post-gate check

      const userPrompt = [
        '## Contacto',
        `- Tipo: ${contactLabel}`,
        `- Médico verificado: ${doctorLabel}`,
        `- Market: ${market || 'desconocido'}`,
        `- Interés detectado: ${inferredInterest}`,
        ...(metaLead ? [
          '',
          '## Lead de Meta Ads',
          'Este contacto llegó por formulario de campaña de Meta (médicos Perú).',
          'Ya está identificado — no pedir que se presente de nuevo.',
          metaLead.profession ? `- Especialidad declarada: ${metaLead.profession}` : '',
          metaLead.full_name  ? `- Nombre: ${metaLead.full_name}` : '',
          'Dar la bienvenida, confirmar que puede ayudar con NIPT y ofrecer el flyer de materiales directamente.',
          'No escalar por este mensaje.',
        ].filter(Boolean) : []),
        '',
        `## Historial reciente (últimos ${contextDays()} días, máx ${contextMaxMessages()} mensajes)`,
        transcriptLines.length ? transcriptLines.join('\n') : '(sin historial previo)',
        '',
        '## Conocimiento disponible',
        knowledgeMarkdown,
        '',
        '## Mensaje actual',
        userText,
        ...(sentAssetUrls.length > 0 ? [
          '',
          `> **[sistema]** Ya enviaste estos recursos en este hilo: ${sentAssetUrls.join(', ')} — No los vuelvas a ofrecer proactivamente. Mencionarlos solo si el contacto los pide de nuevo explícitamente.`,
        ] : []),
        '',
        ...(adminInstruction ? [
          '## Instrucción del equipo Genesia',
          adminInstruction,
          '',
          '---',
          'Convertí la instrucción del equipo en un mensaje natural para el contacto. Mantené el tono y rol de Valeria. No copies la instrucción textualmente.',
        ] : [
          '---',
          intentEff === 'case_status'
            ? '⚠️ INSTRUCCIÓN IMPERATIVA: El contacto pregunta sobre un caso o paciente específico. Valeria NO tiene acceso a datos de casos. Debés comenzar tu respuesta con [ESCALAR] obligatoriamente. No hagas preguntas adicionales — decile que lo vas a consultar con el equipo.'
            : 'Respondé según tu rol y el historial. Preguntá solo si es necesario. Si no tenés datos concretos, usá [ESCALAR]. Sin frases vacías.',
        ]),
      ].join('\n');

      const out = await llmReply({ system: SYSTEM_PROMPT, user: userPrompt });
      let rawText = String(out?.text || '').trim();

      // Detect escalation signal — suppressed for Meta lead first contact
      const shouldEscalate = !metaLead && /\[ESCALAR\]/.test(rawText);
      const replyText = shouldEscalate
        ? rawText.replace(/\[ESCALAR\]\s*/g, '').trim()
        : rawText || '¿En qué puedo ayudarte hoy?';

      // Fire-and-forget admin notification
      if (shouldEscalate) {
        notifyAdmin({ wa_id, userText, replyText, intent: intentEff }).catch(e =>
          console.error('notifyAdmin failed:', e?.message || e)
        );
      }

      // Fire-and-forget report-back to admin (active loop: lead responded to admin-triggered message)
      if (pendingAdminReport) {
        notifyAdminReport({ wa_id, leadText: userText, valeriaReply: replyText });
      }

      // Log outbound
      await client.query(
        `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'out',$2,$3)`,
        [wa_id, replyText, {
          provider: out.provider,
          ms: out.ms,
          ...(shouldEscalate ? { escalated: true } : {}),
          ...(adminInstruction ? { admin_triggered: true } : {}),
        }]
      );

      // CRM: upsert contact_state with stage + product_interest (no-downgrade)
      const STAGE_PRIORITY = ['frio','nuevo','en_dialogo','interesado','escalado','en_seguimiento','convertido'];
      const { rows: csRows } = await client.query(
        `SELECT stage FROM contact_state WHERE wa_id = $1`, [wa_id]
      );
      const currentStage = csRows[0]?.stage || null;
      const candidateStage = (() => {
        if (adminInstruction) return 'en_seguimiento';
        if (shouldEscalate) return 'escalado';
        if (['pricing','honorarium','options','procedure'].includes(intentEff)) return 'interesado';
        return 'en_dialogo';
      })();
      const shouldUpdateStage =
        !currentStage ||
        (!['convertido','frio'].includes(currentStage) &&
          STAGE_PRIORITY.indexOf(candidateStage) >= STAGE_PRIORITY.indexOf(currentStage));
      if (shouldUpdateStage) {
        await client.query(
          `INSERT INTO contact_state (wa_id, stage, product_interest, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (wa_id) DO UPDATE SET
             stage = EXCLUDED.stage,
             product_interest = COALESCE(EXCLUDED.product_interest, contact_state.product_interest),
             updated_at = now()`,
          [wa_id, candidateStage, inferredInterest !== 'unknown' ? inferredInterest : null]
        ).catch(e => console.error('contact_state upsert failed:', e?.message));
      }

      await client.query('COMMIT');

      return res.json({ ok: true, reply: replyText, escalated: shouldEscalate, action: { kind: 'text' } });
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
