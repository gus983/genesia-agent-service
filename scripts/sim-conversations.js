/**
 * sim-conversations.js — Simula conversaciones ficticias con Valeria
 *
 * Arquitectura:
 *   Simulador (Haiku)  →  reply endpoint (Valeria real)  →  Evaluador (Sonnet)
 *
 * Uso:
 *   DATABASE_URL=... ANTHROPIC_API_KEY=... AGENT_URL=http://localhost:4020 \
 *     node scripts/sim-conversations.js
 *
 * Output: sim-reports/YYYY-MM-DD-HH.md
 */

import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:4020';

// ─── PERSONAS ────────────────────────────────────────────────────────────────

const PERSONAS = [
  {
    id: 'medico_ar_honorarios',
    wa_id: 'sim000000000001',
    contact_type: 'medico_derivador',
    market: 'AR',
    max_turns: 7,
    scenario: 'Médico obstetra de Buenos Aires que quiere derivar pacientes a Genesia. Su primera pregunta es sobre honorarios.',
    user_style: 'Directo, poco tiempo. Usa lenguaje médico. Respuestas cortas. No da rodeos.',
    expected_behaviors: [
      'Valeria activa el gate de honorarios (pregunta si es médico)',
      'Una vez verificado, informa el esquema de honorarios correctamente',
      'No inventa montos ni porcentajes',
      'Ofrece próximos pasos concretos para derivar',
    ],
  },
  {
    id: 'medico_ar_logistica',
    wa_id: 'sim000000000002',
    contact_type: 'medico_derivador',
    market: 'AR',
    max_turns: 6,
    scenario: 'Médico tocoginecólogo de Córdoba que quiere saber dónde puede ir su paciente a hacerse el NIPT.',
    user_style: 'Amable pero concreto. Pregunta por ciudad específica. Puede preguntar por el proceso completo.',
    expected_behaviors: [
      'Valeria informa el centro correcto en Córdoba con dirección',
      'Menciona el costo adicional de logística para centros fuera de CABA',
      'Aclara que el paciente NO debe contactar el centro directamente',
      'Da información sobre tiempos y proceso',
    ],
  },
  {
    id: 'contacto_desconocido_a_medico',
    wa_id: 'sim000000000003',
    contact_type: 'unknown',
    market: 'AR',
    max_turns: 8,
    scenario: 'Contacto que empieza sin identificarse ("hola, quiero info sobre NIPT"), luego revela ser médico ginecólogo y pregunta por honorarios.',
    user_style: 'Empieza vago. Se identifica recién cuando Valeria pregunta. Luego es más directo.',
    expected_behaviors: [
      'Valeria trata al contacto desconocido correctamente al inicio',
      'Cuando el contacto revela ser médico, ajusta el trato',
      'Activa el gate de honorarios cuando corresponde',
      'Transición fluida entre tono genérico y tono B2B',
    ],
  },
  {
    id: 'medico_preguntas_clinicas',
    wa_id: 'sim000000000004',
    contact_type: 'medico_derivador',
    market: 'AR',
    max_turns: 7,
    scenario: 'Médico que quiere entender las diferencias clínicas entre paneles para recomendar mejor a sus pacientes. Pregunta específicamente qué detecta Advanced Pro vs MaterniT21 Plus.',
    user_style: 'Técnico, pregunta con terminología clínica (microdeleciones, aneuploidias, CNVs). Espera respuestas precisas.',
    expected_behaviors: [
      'Valeria diferencia correctamente Advanced Pro (92 microdeleciones, BGI) vs MaterniT21 Plus (7 microdeleciones, Sequenom)',
      'Menciona la diferencia de semanas mínimas (10 vs 9)',
      'No mezcla características entre paneles',
      'No inventa capacidades diagnósticas',
    ],
  },
  {
    id: 'medico_consulta_caso',
    wa_id: 'sim000000000005',
    contact_type: 'medico_derivador',
    market: 'AR',
    max_turns: 5,
    scenario: 'Médico que ya derivó una paciente y pregunta por el estado del resultado: "¿llegó el resultado de mi paciente Laura Gómez?"',
    user_style: 'Algo impaciente. Espera una respuesta concreta. Puede insistir.',
    expected_behaviors: [
      'Valeria DEBE escalar con [ESCALAR] — no tiene acceso a datos de casos',
      'No inventa ni estima estado del resultado',
      'La respuesta al usuario es honesta y promete derivar al equipo',
      'No hace preguntas adicionales innecesarias antes de escalar',
    ],
  },
  {
    id: 'medico_co_logistica',
    wa_id: 'sim000000000006',
    contact_type: 'medico_derivador',
    market: 'CO',
    max_turns: 6,
    scenario: 'Médico ginecólogo de Medellín, Colombia. Pregunta por opciones de toma de muestra para su paciente en esa ciudad y los precios.',
    user_style: 'Colombiano, formal. Puede usar "usted". Quiere info clara y rápida.',
    expected_behaviors: [
      'Valeria usa precios en COP correctamente',
      'Informa el centro de Medellín (Centrolab) con dirección',
      'Menciona que hay servicio a domicilio en Medellín con Centrolab',
      'Aclara costos adicionales para centros fuera de las 3 ciudades principales',
    ],
  },
  {
    id: 'institucion_ar',
    wa_id: 'sim000000000007',
    contact_type: 'institucion',
    market: 'AR',
    max_turns: 6,
    scenario: 'Representante de una clínica obstétrica de Buenos Aires que quiere evaluar incorporar NIPT de Genesia para ofrecer a sus pacientes. Pregunta por volumen, condiciones y proceso.',
    user_style: 'Ejecutivo, formal. Habla de "nuestra institución". Quiere condiciones diferenciales por volumen.',
    expected_behaviors: [
      'Valeria reconoce que es una institución y ajusta el enfoque',
      'No improvisa condiciones de convenio que no están en KB',
      'Escala si la pregunta requiere negociación comercial específica',
      'Mantiene tono profesional B2B',
    ],
  },
  {
    id: 'medico_ar_rechazo_cierre',
    wa_id: 'sim000000000008',
    contact_type: 'medico_derivador',
    market: 'AR',
    max_turns: 6,
    scenario: 'Médico que inicialmente muestra interés en derivar pero al final dice "gracias, lo voy a pensar" y cierra la conversación.',
    user_style: 'Interesado al inicio, luego evasivo. Usa frases como "ya te aviso", "no gracias, por ahora no".',
    expected_behaviors: [
      'Valeria acepta el cierre sin insistir ni repetir el ofrecimiento',
      'No pregunta "¿en qué más te puedo ayudar?" ni variantes',
      'Cierre cordial y breve',
      'No vuelve a ofrecer lo que el médico acaba de rechazar',
    ],
  },
];

// ─── SIMULADOR (genera mensaje de usuario) ────────────────────────────────────

async function generateUserMessage(persona, history, turnIndex) {
  const isFirstTurn = turnIndex === 0;

  const historyText = history.map(h =>
    `${h.role === 'user' ? 'Tú (usuario)' : 'Valeria'}: ${h.text}`
  ).join('\n');

  const prompt = isFirstTurn
    ? `Sos un usuario de WhatsApp. Tu perfil: ${persona.scenario}
Estilo: ${persona.user_style}
Escribí el PRIMER mensaje que le mandarías a Valeria (asesora de Genesia).
Sé realista y breve (como se escribe en WhatsApp). Solo el mensaje, sin explicaciones.`
    : `Sos un usuario de WhatsApp. Tu perfil: ${persona.scenario}
Estilo: ${persona.user_style}

Conversación hasta ahora:
${historyText}

Turno ${turnIndex + 1} de ${persona.max_turns}.
Escribí tu PRÓXIMO mensaje respondiendo a Valeria. Sé realista y breve.
Si la conversación llegó a un cierre natural, responde con exactamente: [FIN]
Solo el mensaje, sin explicaciones.`;

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  return resp.content[0].text.trim();
}

// ─── CALL VALERIA ────────────────────────────────────────────────────────────

async function callValeria(persona, userText) {
  const resp = await fetch(`${AGENT_URL}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wa_id: persona.wa_id,
      text: userText,
      country: persona.market,
    }),
  });

  if (!resp.ok) throw new Error(`reply endpoint ${resp.status}`);
  const data = await resp.json();
  return { reply: data.reply, escalated: data.escalated };
}

// ─── EVALUADOR ───────────────────────────────────────────────────────────────

async function evaluateConversation(persona, history) {
  const historyText = history.map((h, i) =>
    `[${i + 1}] ${h.role === 'user' ? 'Usuario' : `Valeria${h.escalated ? ' [ESCALÓ]' : ''}`}: ${h.text}`
  ).join('\n\n');

  const prompt = `Sos un evaluador experto en calidad de agentes conversacionales B2B para salud.

## Perfil de la conversación
Persona: ${persona.scenario}
Comportamientos esperados:
${persona.expected_behaviors.map(b => `- ${b}`).join('\n')}

## Contexto de Valeria
Valeria es asesora clínica de Genesia (NIPT prenatal).
Reglas clave:
- Honorarios: solo a médicos verificados
- NIPT es screening, no diagnóstico
- Si no tiene el dato → escalar con [ESCALAR], no inventar
- Respuestas 2-4 líneas
- Sin frases vacías ("¡Claro!", "Por supuesto", "¿En qué más puedo ayudarte?")
- No hacer dos preguntas en el mismo mensaje
- Si el contacto rechaza algo, no insistir

## Conversación simulada
${historyText}

## Evaluación requerida
Evaluá CADA respuesta de Valeria con estos criterios (puntaje 1-10 cada uno):
1. **Correctitud**: ¿Respondió correctamente según las reglas y datos conocidos?
2. **Tono**: ¿Apropiado para el tipo de contacto? ¿Sin frases prohibidas?
3. **Escalación**: ¿Escaló cuando debía? ¿No escaló cuando no debía?
4. **Formato**: ¿2-4 líneas? ¿Sin preguntas dobles?
5. **Avance**: ¿El mensaje avanzó la conversación?

Luego dá:
- **Score global** (1-10): promedio ponderado
- **Hallazgos críticos**: cosas que Valeria hizo MAL (inventar datos, no escalar, insistir, etc.)
- **Puntos fuertes**: qué hizo bien
- **Sugerencias de mejora**: cambios concretos al prompt o KB que mejorarían las fallas

Formato: markdown estructurado.`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  return resp.content[0].text.trim();
}

// ─── CLEANUP SIM CONTACTS ────────────────────────────────────────────────────

async function cleanupSimContact(wa_id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM messages WHERE wa_id = $1`, [wa_id]);
    await client.query(`DELETE FROM contact_state WHERE wa_id = $1`, [wa_id]);
    await client.query(`DELETE FROM contacts WHERE wa_id = $1`, [wa_id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── RUN ONE PERSONA ─────────────────────────────────────────────────────────

async function runPersona(persona) {
  console.log(`\n▶ Simulando: ${persona.id}`);
  await cleanupSimContact(persona.wa_id);

  const history = [];

  for (let turn = 0; turn < persona.max_turns; turn++) {
    // Generate user message
    const userText = await generateUserMessage(persona, history, turn);
    if (userText === '[FIN]') {
      console.log(`  ✓ Conversación cerrada naturalmente en turno ${turn + 1}`);
      break;
    }

    console.log(`  → [${turn + 1}] Usuario: ${userText.slice(0, 60)}...`);
    history.push({ role: 'user', text: userText });

    // Call Valeria
    let valeriaReply, escalated;
    try {
      ({ reply: valeriaReply, escalated } = await callValeria(persona, userText));
    } catch (e) {
      valeriaReply = `[ERROR: ${e.message}]`;
      escalated = false;
    }

    console.log(`  ← Valeria${escalated ? ' [ESCALÓ]' : ''}: ${valeriaReply.slice(0, 60)}...`);
    history.push({ role: 'valeria', text: valeriaReply, escalated });

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 800));
  }

  // Evaluate
  console.log(`  🔍 Evaluando...`);
  const evaluation = await evaluateConversation(persona, history);

  // Cleanup
  await cleanupSimContact(persona.wa_id);

  return { persona, history, evaluation };
}

// ─── REPORT ──────────────────────────────────────────────────────────────────

function buildReport(results, startedAt) {
  const date = startedAt.toISOString().slice(0, 19).replace('T', ' ');

  const sections = results.map(({ persona, history, evaluation }) => {
    const transcript = history.map((h, i) =>
      `**[${i + 1}] ${h.role === 'user' ? '👤 Usuario' : `🤖 Valeria${h.escalated ? ' ⬆ ESCALÓ' : ''}`}**\n${h.text}`
    ).join('\n\n');

    return `---

## ${persona.id}

**Escenario:** ${persona.scenario}
**Market:** ${persona.market} | **Tipo:** ${persona.contact_type} | **Turnos:** ${history.length}

### Comportamientos esperados
${persona.expected_behaviors.map(b => `- ${b}`).join('\n')}

### Transcripción

${transcript}

### Evaluación del juez

${evaluation}
`;
  });

  return `# Reporte de Simulación — Valeria
Generado: ${date}
Personas: ${results.length}

${sections.join('\n')}
`;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date();
  console.log(`\n🚀 Simulación iniciada — ${PERSONAS.length} personas, endpoint: ${AGENT_URL}\n`);

  // Run selected personas (all by default, or filter via env)
  const filter = process.env.SIM_PERSONA;
  const toRun = filter ? PERSONAS.filter(p => p.id === filter) : PERSONAS;

  if (!toRun.length) {
    console.error(`No personas matched filter: ${filter}`);
    process.exit(1);
  }

  const results = [];
  for (const persona of toRun) {
    try {
      const result = await runPersona(persona);
      results.push(result);
    } catch (e) {
      console.error(`  ✗ Error en ${persona.id}:`, e.message);
      results.push({
        persona,
        history: [],
        evaluation: `**ERROR:** ${e.message}`,
      });
    }
  }

  // Write report
  const reportDir = path.resolve('sim-reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const filename = path.join(reportDir, `${startedAt.toISOString().slice(0, 13).replace('T', '-')}.md`);
  const report = buildReport(results, startedAt);
  fs.writeFileSync(filename, report, 'utf8');

  console.log(`\n✅ Reporte generado: ${filename}`);
  await pool.end();
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
