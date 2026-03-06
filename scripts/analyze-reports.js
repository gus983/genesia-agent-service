/**
 * analyze-reports.js — Sintetiza reportes de simulación en propuestas accionables
 *
 * Lee todos los archivos en sim-reports/ (o los pasados por argumento),
 * usa Claude para identificar patrones y genera proposals/latest.md
 * con cambios concretos listos para aprobar.
 *
 * Uso:
 *   ANTHROPIC_API_KEY=... node scripts/analyze-reports.js
 *   ANTHROPIC_API_KEY=... node scripts/analyze-reports.js sim-reports/2026-03-05-18.md
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── READ REPORTS ─────────────────────────────────────────────────────────────

function loadReports(files) {
  if (files.length) {
    return files.map(f => ({
      name: path.basename(f),
      content: fs.readFileSync(f, 'utf8'),
    }));
  }

  const dir = path.join(ROOT, 'sim-reports');
  if (!fs.existsSync(dir)) {
    console.error('No sim-reports/ directory found. Run sim-conversations.js first.');
    process.exit(1);
  }

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({
      name: f,
      content: fs.readFileSync(path.join(dir, f), 'utf8'),
    }));
}

// ─── READ CURRENT SYSTEM PROMPT ──────────────────────────────────────────────

function loadCurrentSystemPrompt() {
  const replyPath = path.join(ROOT, 'src/routes/reply.js');
  const src = fs.readFileSync(replyPath, 'utf8');
  const match = src.match(/const SYSTEM_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\)/);
  if (!match) return '(no se pudo extraer el SYSTEM_PROMPT)';

  // Extract the string lines
  const lines = [...match[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m =>
    m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'")
  );
  return lines.join('\n');
}

// ─── ANALYZE ─────────────────────────────────────────────────────────────────

async function analyzeReports(reports, systemPrompt) {
  const reportsBlock = reports.map(r =>
    `### Reporte: ${r.name}\n\n${r.content}`
  ).join('\n\n---\n\n');

  const prompt = `Sos un experto en diseño de agentes conversacionales para salud B2B.
Tu tarea: analizar reportes de simulación de Valeria (asesora clínica de Genesia) e identificar mejoras concretas.

## SYSTEM_PROMPT actual de Valeria

\`\`\`
${systemPrompt}
\`\`\`

## Reportes de simulación

${reportsBlock}

---

## Tu tarea

Analiza los reportes y produce un documento de propuestas con esta estructura EXACTA:

---

# Propuestas de mejora — Valeria

## Resumen ejecutivo
[2-4 líneas sobre los patrones más frecuentes encontrados]

## Hallazgos por categoría

### Errores de comportamiento (reglas violadas)
[Lista de comportamientos incorrectos de Valeria, con qué persona/turno lo evidenció]

### Gaps de KB (información faltante)
[Temas sobre los que Valeria no tenía datos suficientes y que se deberían agregar a knowledge_items]

### Errores de tono o formato
[Frases prohibidas usadas, respuestas demasiado largas, dobles preguntas, etc.]

---

## Propuestas

[Para cada propuesta, usar este formato:]

### P-01: [título corto]
**Tipo:** \`prompt_change\` | \`kb_addition\` | \`logic_change\`
**Prioridad:** \`alta\` | \`media\` | \`baja\`
**Problema:** [qué falla concretamente, en qué conversación apareció]
**Frecuencia:** [en cuántas simulaciones / turnos apareció]

**Cambio propuesto:**

[Para prompt_change: mostrar el fragmento ACTUAL del SYSTEM_PROMPT y el fragmento NUEVO propuesto]

ACTUAL:
\`\`\`
[texto actual]
\`\`\`
PROPUESTO:
\`\`\`
[texto nuevo]
\`\`\`

[Para kb_addition: mostrar el item completo listo para agregar a seed-kb.js]

\`\`\`javascript
item('nipt', 'faq', 'AR', 'clave_nueva', \`
## Título
[contenido]
\`)
\`\`\`

[Para logic_change: describir el cambio de código necesario con pseudocódigo o snippet]

**Riesgo de regresión:** [qué podría romperse si se aplica este cambio]

---

[Repetir para cada propuesta. Numerar P-01, P-02, etc.]

---

## Prioridad de implementación sugerida

[Tabla con P-XX | tipo | prioridad | esfuerzo estimado (bajo/medio/alto)]

---

Sé específico. Cada propuesta debe ser implementable directamente. No propongas cambios vagos como "mejorar el tono" — proponé el texto exacto a cambiar.
Si detectás un gap de KB que requiere investigación de datos (ej. "honorarios reales de Genesia"), marcá como DATO_FALTANTE para que el usuario lo complete.`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return resp.content[0].text.trim();
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const files = process.argv.slice(2);
  const reports = loadReports(files);

  if (!reports.length) {
    console.error('No reports found.');
    process.exit(1);
  }

  console.log(`\n🔍 Analizando ${reports.length} reporte(s): ${reports.map(r => r.name).join(', ')}`);

  const systemPrompt = loadCurrentSystemPrompt();
  console.log(`📋 SYSTEM_PROMPT cargado (${systemPrompt.length} chars)`);

  console.log(`🤖 Sintetizando con Claude Sonnet...`);
  const proposals = await analyzeReports(reports, systemPrompt);

  // Write output
  const proposalsDir = path.join(ROOT, 'proposals');
  fs.mkdirSync(proposalsDir, { recursive: true });

  const ts = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const outPath = path.join(proposalsDir, `${ts}.md`);
  const latestPath = path.join(proposalsDir, 'latest.md');

  const header = `<!-- generado: ${new Date().toISOString()} | reportes: ${reports.map(r => r.name).join(', ')} -->\n\n`;
  fs.writeFileSync(outPath, header + proposals, 'utf8');
  fs.writeFileSync(latestPath, header + proposals, 'utf8');

  console.log(`\n✅ Propuestas guardadas:`);
  console.log(`   ${outPath}`);
  console.log(`   ${latestPath} (alias latest)`);
  console.log(`\nRevisá proposals/latest.md, aprobá las que querés implementar y pasáselas a Claude.`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
