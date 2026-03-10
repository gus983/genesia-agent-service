/**
 * parseMetaLead.js
 * Parses inbound WhatsApp messages from Meta Lead Ads campaigns.
 *
 * Meta sends form responses as plain text lines: "key: value"
 * Keys may contain underscores, parentheticals, accents, mixed case.
 * Example:
 *   profesión_(ej._obstetricia): obstetricia
 *   email: maria@example.com
 *   full_name: María Gómez
 *   phone_number: +51999888777
 */

// Field patterns — order matters (first match wins per field)
const FIELD_MAP = [
  { pattern: /profesi[oó]n|especialidad/, field: 'profession' },
  { pattern: /^email$/,                   field: 'email'      },
  { pattern: /full.?name|nombre/,         field: 'full_name'  },
  { pattern: /phone.?number|tel[eé]fono|celular|m[oó]vil/, field: 'phone_number' },
];

const MEDICAL_RE   = /obstetr|ginec[oó]|m[eé]dic[oa]|doctor[a]?|perinat|enfermera|matrona/i;
const INSTITUTION_RE = /cl[íi]nica|hospital|laborator|instituci[oó]n/i;

/**
 * Strips parentheticals, normalizes separators.
 * "profesión_(ej._obstetricia)" → "profesión"
 * "Full_Name" → "full_name"
 */
function normalizeKey(raw) {
  return raw
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/[\s_]+/g, '_')
    .replace(/[^a-z0-9áéíóúüñ_]/g, '')
    .replace(/_+$/g, '')
    .trim();
}

/**
 * Parses a Meta lead message.
 * @param {string} text  Raw WA message body
 * @returns {{ profession?, email?, full_name?, phone_number? } | null}
 *   null if the message doesn't look like a Meta lead form.
 */
export function parseMetaLead(text) {
  const lines = String(text || '').split(/\r?\n/);
  const found = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;
    const rawKey = line.slice(0, colonIdx).trim();
    const value  = line.slice(colonIdx + 1).trim();
    if (!value) continue;

    const normKey = normalizeKey(rawKey);
    for (const { pattern, field } of FIELD_MAP) {
      if (pattern.test(normKey) && !found[field]) {
        found[field] = value;
        break;
      }
    }
  }

  // At least 2 recognized fields required to qualify as a Meta lead
  if (Object.keys(found).length < 2) return null;
  return found;
}

/**
 * Maps parsed lead fields to the contact DB update payload.
 * @param {{ profession?, full_name?, email?, phone_number? }} lead
 * @returns {{ contact_type, verified_doctor, verification_source, verification_confidence, name, email }}
 */
export function leadToContactUpdate(lead) {
  const profession = String(lead.profession || '').toLowerCase();

  let contact_type    = 'medico_derivador'; // campaign default
  let verified_doctor = profession ? MEDICAL_RE.test(profession) : false;

  if (INSTITUTION_RE.test(profession) && !MEDICAL_RE.test(profession)) {
    contact_type    = 'institucion';
    verified_doctor = false;
  }

  return {
    contact_type,
    verified_doctor,
    verification_source:    'meta_lead',
    verification_confidence: 0.85,
    name:  lead.full_name  || null,
    email: lead.email      || null,
  };
}
