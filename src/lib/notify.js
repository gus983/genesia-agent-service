const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v22.0';

// Rate limit: one notification per wa_id per N minutes
const NOTIFY_RATE_LIMIT_MS = Number(process.env.NOTIFY_RATE_LIMIT_MS || 5 * 60 * 1000);
const _lastNotified = new Map(); // wa_id -> timestamp

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
 * @param {{ wa_id: string, userText: string, replyText: string }} opts
 */
export async function notifyAdmin({ wa_id, userText, replyText }) {
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
  const maskedId = String(wa_id).slice(-6);

  const msg = [
    `*Valeria necesita ayuda* (ID: ...${maskedId})`,
    '',
    `*Pregunta:* ${preview(userText)}`,
    '',
    `*Respuesta dada:* ${preview(replyText)}`,
  ].join('\n');

  await sendWhatsAppText(adminNumber, msg);
}
