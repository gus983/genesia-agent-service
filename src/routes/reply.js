import express from 'express';
import { getPool } from '../db/index.js';

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

function classifyInterest(text = '') {
  const t = String(text).toLowerCase();
  if (/\b(nipt|trisom(i|í)a|down|tamiz|aneuploid|cfdna)\b/.test(t)) return 'nipt';
  if (/\b(c(a|á)ncer|oncolog)\b/.test(t)) return 'cancer';
  return 'unknown';
}

function looksLikePricingQuestion(text = '') {
  const t = String(text).toLowerCase();
  return /\b(precio|precios|cu[aá]nto|cuanto|valor|costo|costos|tarifa|arancel)\b/.test(t);
}

function wantsHonorarium(text = '') {
  const t = String(text).toLowerCase();
  return /\b(honorario|honorarios|comisi(o|ó)n|comisiones)\b/.test(t);
}

function formatMoney(currency, amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  if (currency === 'USD') return `USD ${n}`;
  if (currency === 'COP') return `${n.toLocaleString('es-CO')} COP`;
  if (currency === 'PEN') return `S/ ${n.toLocaleString('es-PE')}`;
  return `${n} ${currency}`;
}

export function replyRouter() {
  const r = express.Router();

  // POST /reply { wa_id, text, country? }
  r.post('/', async (req, res) => {
    const { wa_id, text, country } = req.body || {};
    if (!wa_id) return res.status(400).json({ ok: false, error: 'missing_wa_id' });

    const pool = getPool();
    const client = await pool.connect();

    const userText = String(text || '').trim();
    const inferredMarket = inferMarketFromWaId(wa_id);
    const inferredContactType = classifyContactType(userText);
    const inferredInterest = classifyInterest(userText);

    try {
      await client.query('BEGIN');

      // Upsert contact (keep existing non-unknown contact_type)
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

      // Minimal interest/state update
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
        [wa_id, userText, { source: 'wa-bridge' }]
      );

      // Pricing path (NIPT)
      let replyText = null;

      if (looksLikePricingQuestion(userText)) {
        const market = inferredMarket || (country ? String(country).toUpperCase() : null);

        if (!market) {
          replyText = 'Para pasarte los precios: ¿es para Argentina, Colombia o Perú?';
        } else {
          const { rows } = await client.query(
            `SELECT data
             FROM knowledge_items
             WHERE domain='nipt' AND kind='pricing' AND key='nipt.pricing' AND market=$1
             LIMIT 1`,
            [market]
          );

          if (!rows.length) {
            replyText = `Todavía no tengo cargados los precios para ${market}. ¿Me confirmás país y ciudad?`;
          } else {
            const data = rows[0].data || {};
            const products = Array.isArray(data.products) ? data.products : [];

            const ctRes = await client.query(`SELECT contact_type FROM contacts WHERE wa_id=$1`, [wa_id]);
            const contactType = ctRes.rows?.[0]?.contact_type || 'unknown';
            const wantHon = wantsHonorarium(userText);

            const lines = products.map((p) => {
              const name = p?.name || p?.product_name || p?.code || 'Opción';
              const vendor = p?.vendor ? ` (${p.vendor})` : '';
              const price = formatMoney(p?.patient_currency || p?.currency || 'USD', p?.patient_price);
              let s = `${name}${vendor}: ${price}`;

              if (wantHon) {
                if (contactType === 'medico') {
                  const hon = Number(p?.doctor_honorarium_usd);
                  if (Number.isFinite(hon)) s += ` — Honorario médico: USD ${hon}`;
                }
              }
              return s;
            });

            replyText =
              `Opciones NIPT (${market}):\n` +
              (lines.length ? lines.join('\n') : 'No hay productos cargados aún.') +
              (wantHon && contactType !== 'medico'
                ? `\n\nEl honorario médico lo comparto solo con profesionales. ¿Sos médico/a?`
                : '');
          }
        }
      }

      await client.query('COMMIT');

      return res.json({
        ok: true,
        reply: replyText || 'Recibido. (MVP) En breve integramos KB/RAG + políticas + follow-ups.',
        action: { kind: 'text' }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('reply failed:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'reply_failed' });
    } finally {
      client.release();
      // IMPORTANT: do NOT pool.end() in request handler
    }
  });

  return r;
}