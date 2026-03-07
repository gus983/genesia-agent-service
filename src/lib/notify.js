const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v22.0';

// Rate limit: one escalation notification per wa_id per N minutes
const NOTIFY_RATE_LIMIT_MS = Number(process.env.NOTIFY_RATE_LIMIT_MS || 5 * 60 * 1000);
const _lastNotified = new Map(); // wa_id -> timestamp

// Coalescing window for report-back notifications (ms)
const REPORT_COALESCE_MS = Number(process.env.REPORT_COALESCE_MS || 45_000);
const _pendingReports = new Map(); // wa_id -> { timer, countExtra, lastLeadText, lastValeriaReply }

function isRateLimited(wa_id) {
  const last = _lastNotified.get(wa_id);
  if (!last) return false;
  return (Date.now() - last) < NOTIFY_RATE_LIMIT_MS;
}

async function sendWhatsAppText(to, body) {
  const token = process.env.WA_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.warn('notifyAdmin: WA_TOKEN or PHONE_NUMBER_ID not set, skipping WA notification');
    return;
  }

  const resp = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error('notifyAdmin: WA send failed', resp.status, err?.error?.message || '');
  }
}

/**
 * Notify admin via WhatsApp when Valeria can't answer.
 * Fire-and-forget — caller should not await.
 *
 * @param {{ wa_id: string, userText: string, replyText: string, intent?: string }} opts
 */
export async function notifyAdmin({ wa_id, userText, replyText, intent }) {
  const adminNumber = process.env.ADMIN_NUMBER;
  if (!adminNumber) {
    console.warn('notifyAdmin: ADMIN_NUMBER not set, skipping');
    return;
  }

  if (isRateLimited(wa_id)) {
    console.log(`notifyAdmin: rate limited for ...${String(wa_id).slice(-6)}, skipping`);
    return;
  }
  _lastNotified.set(wa_id, Date.now());

  const preview = (s, max = 220) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const phone = String(wa_id).replace(/^\+/, '');
  const maskedId = String(wa_id).slice(-6);
  const intentLabel = intent ? ` — motivo: ${intent}` : '';

  const msg = [
    `*Valeria necesita tu respuesta*${intentLabel}`,
    `*Contacto:* +${phone}`,
    `https://wa.me/${phone}`,
    '',
    `*Pregunta del lead:* ${preview(userText)}`,
    '',
    `*Lo que le dije:* ${preview(replyText)}`,
    '',
    `_Respondé este mensaje con la información y Valeria se la transmite al lead._`,
    `_Si gestionás varios leads a la vez, mencioná el número al inicio de tu respuesta (ej: ${phone.slice(-8)}, decile que...)._`,
  ].join('\n');

  await sendWhatsAppText(adminNumber, msg);

  // Register escalation in wa-bridge cache so admin coaching loop can find it
  const waBridgeUrl = (process.env.WA_BRIDGE_URL || 'http://genesia-wa-bridge:3000').replace(/\/$/, '');
  const regUrl = `${waBridgeUrl}/internal/escalation`;
  console.log(`escalation_register_start wa_id=...${maskedId} url=${regUrl}`);
  fetch(regUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wa_id, question: userText }),
  }).then(async r => {
    if (r.ok) {
      console.log(`escalation_register_ok wa_id=...${maskedId} status=${r.status}`);
    } else {
      const body = await r.text().catch(() => '');
      console.warn(`escalation_register_fail wa_id=...${maskedId} status=${r.status} body=${body.slice(0, 200)}`);
    }
  }).catch(e => console.warn(`escalation_register_fail wa_id=...${maskedId} err=${e?.message}`));
}

/**
 * Report lead's response back to admin after an admin-triggered Valeria message.
 * Coalesces rapid successive messages — fires once per REPORT_COALESCE_MS window of silence.
 * Fire-and-forget — caller should not await.
 *
 * @param {{ wa_id: string, leadText: string, valeriaReply: string }} opts
 */
export function notifyAdminReport({ wa_id, leadText, valeriaReply }) {
  const existing = _pendingReports.get(wa_id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.countExtra += 1;
    existing.lastLeadText = leadText;
    existing.lastValeriaReply = valeriaReply;
    existing.timer = setTimeout(() => _flushAdminReport(wa_id), REPORT_COALESCE_MS);
    console.log(`admin_report_coalesced wa_id=...${String(wa_id).slice(-6)} extra=${existing.countExtra}`);
  } else {
    const entry = {
      countExtra: 0,
      lastLeadText: leadText,
      lastValeriaReply: valeriaReply,
      timer: setTimeout(() => _flushAdminReport(wa_id), REPORT_COALESCE_MS),
    };
    _pendingReports.set(wa_id, entry);
  }
}

async function _flushAdminReport(wa_id) {
  const entry = _pendingReports.get(wa_id);
  if (!entry) return;
  _pendingReports.delete(wa_id);

  const adminNumber = process.env.ADMIN_NUMBER;
  if (!adminNumber) return;

  const maskedId = String(wa_id).slice(-6);
  const phone = String(wa_id).replace(/^\+/, '');
  const preview = (s, max = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

  const extraNote = entry.countExtra > 0
    ? `\n_Lead envió ${entry.countExtra} mensaje(s) adicional(es) — mostrando el último._`
    : '';

  const msg = [
    `*Valeria averiguó — respuesta del lead:*${extraNote}`,
    `*Contacto:* +${phone}`,
    `https://wa.me/${phone}`,
    '',
    `*Lo que dijo el lead:* ${preview(entry.lastLeadText)}`,
    '',
    `*Cómo respondió Valeria:* ${preview(entry.lastValeriaReply)}`,
  ].join('\n');

  console.log(`admin_report_flush wa_id=...${maskedId} extra=${entry.countExtra}`);
  await sendWhatsAppText(adminNumber, msg).catch(e =>
    console.error('admin_report_flush failed:', e?.message)
  );
}
