/**
 * turnClassifier.js — Mini-clasificador LLM de turno (haiku, una llamada, multi-salida).
 *
 * Clasifica un mensaje de usuario en: intent, domain, market, ack_only, confidence.
 * Usa claude-haiku para velocidad/costo. Retorna null si falla o el JSON no es válido.
 *
 * Feature flag: TURN_CLASSIFIER=llm en el proceso caller (no en este módulo).
 */

import { llmReply } from './llm.js';

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const VALID_INTENT = new Set(['case_status', 'pricing', 'options', 'procedure', 'honorarium', 'general']);
const VALID_DOMAIN = new Set(['nipt', 'cancer', 'general']);
const VALID_MARKET = new Set(['AR', 'CO', 'PE']);

const SYSTEM_PROMPT = `\
Sos un clasificador de mensajes para un asistente clínico (Valeria, Genesia).
Respondé SOLO un objeto JSON válido (sin markdown, sin texto extra) siguiendo el schema indicado.
No inventes campos. Si no estás seguro, usá null o "general" y bajá confidence.`;

function buildUserPrompt(userText, lastValeriaOut, contactCountryHint) {
  return `\
Clasificá el siguiente turno de conversación.

DEVOLVÉ EXACTAMENTE ESTE JSON:
{
  "intent": "case_status" | "pricing" | "options" | "procedure" | "honorarium" | "general",
  "domain": "nipt" | "cancer" | "general",
  "market": "AR" | "CO" | "PE" | null,
  "ack_only": boolean,
  "confidence": number
}

DEFINICIONES:
- intent=case_status: estado de caso/paciente, resultados, pagos, "no me pagaron", "estado del caso", "mi paciente", etc.
- intent=honorarium: honorarios/comisiones/pago al médico derivante.
- intent=pricing: precio/costo al paciente.
- intent=options: opciones/menú/alternativas de tests/paneles.
- intent=procedure: logística/proceso/pasos/turno/muestra/entrega (no caso específico).
- intent=general: otros.

- domain=nipt: embarazo/NIPT/trisomías/Down/tamizaje prenatal/cfDNA.
- domain=cancer: oncología/panel hereditario/cáncer.
- domain=general: si no hay señales claras.

- market: inferir SOLO si hay evidencia explícita en el texto (país, ciudad, moneda o modismos).
  Ejemplos NO exhaustivos:
  - AR: "Argentina", "CABA", "Buenos Aires", ciudades argentinas, voseo ("vos", "querés").
  - CO: "Colombia", "Bogotá", "COP", ciudades colombianas.
  - PE: "Perú", "Lima", "S/" (soles), ciudades peruanas.
  Si no hay señales claras → market=null. No adivines.

- ack_only=true SOLO si el mensaje es una confirmación breve/cierre conversacional y NO agrega una pregunta nueva ni información nueva relevante.

DATOS:
- last_valeria_out: <<<${lastValeriaOut ?? 'null'}>>>
- contact_country_hint: <<<${contactCountryHint ?? 'null'}>>>
- user_text: <<<${userText}>>>

DEVOLVÉ SOLO JSON.`;
}

/**
 * @param {{ userText: string, lastValeriaOut: string|null, contactCountryHint: string|null }} opts
 * @returns {Promise<{intent,domain,market,ack_only,confidence}|null>}
 */
export async function classifyTurn({ userText, lastValeriaOut, contactCountryHint }) {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(userText, lastValeriaOut, contactCountryHint);

  let raw;
  try {
    const out = await llmReply({ system, user, model: CLASSIFIER_MODEL });
    raw = String(out?.text || '').trim();
  } catch (e) {
    console.error(`turn_classifier llm_error err=${e?.message}`);
    return null;
  }

  let parsed;
  try {
    // Strip potential markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error(`turn_classifier parse_error raw=${raw.slice(0, 100)}`);
    return null;
  }

  // Validate and normalize
  const intent = VALID_INTENT.has(parsed?.intent) ? parsed.intent : null;
  const domain = VALID_DOMAIN.has(parsed?.domain) ? parsed.domain : null;
  const market = VALID_MARKET.has(parsed?.market) ? parsed.market : null;
  const ack_only = typeof parsed?.ack_only === 'boolean' ? parsed.ack_only : false;
  const confidence = typeof parsed?.confidence === 'number'
    ? Math.min(1, Math.max(0, parsed.confidence))
    : 0;

  if (!intent || !domain) {
    console.error(`turn_classifier validation_error parsed=${JSON.stringify(parsed)}`);
    return null;
  }

  console.log(`turn_classifier ok intent=${intent} domain=${domain} market=${market} ack_only=${ack_only} conf=${confidence.toFixed(2)}`);
  return { intent, domain, market, ack_only, confidence };
}
