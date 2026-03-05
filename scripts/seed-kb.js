/**
 * seed-kb.js — Pobla knowledge_items con datos operativos de Genesia NIPT
 * Mercados: AR, CO, PE + specs globales de producto
 *
 * Uso: DATABASE_URL=... node scripts/seed-kb.js
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── HELPERS ────────────────────────────────────────────────────────────────

function item(domain, kind, market, key, text) {
  return { domain, kind, market: market || null, key, data: { text } };
}

// ─── ITEMS ──────────────────────────────────────────────────────────────────

const items = [

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCT SPECS — global (mismo para todos los mercados)
  // ═══════════════════════════════════════════════════════════════════════════

  item('nipt', 'product_specs', null, 'panels_clinical_summary', `
## Paneles NIPT — Resumen clínico

**Laboratorios procesadores:**
- Esenciales (Standard, Standard Pro, Advanced, Advanced Pro): BGI, Uruguay. Desde semana 10, resultados en 7-15 días hábiles.
- Premium (MaterniT21 Plus, Genome): Sequenom, Estados Unidos. Desde semana 9, resultados en 5-10 días hábiles.

**Paneles Esenciales:**
- Standard: Trisomías 21 (Down), 18 (Edwards), 13 (Patau) + sexo fetal.
- Standard Pro: Igual que Standard + anomalías en cromosomas sexuales (X, Y). No apto para embarazo gemelar.
- Advanced: Igual que Standard Pro + trisomías adicionales (16, 22, 9) + 10 microdeleciones (incluye síndrome de DiGeorge). No apto para embarazo gemelar.
- Advanced Pro: Igual que Advanced + análisis ampliado de 92 microdeleciones. No apto para embarazo gemelar.

**Paneles Premium:**
- MaterniT21 Plus: Trisomías 21, 18, 13 + anomalías cromosomas sexuales (X, Y) + trisomías 16 y 22 + 7 microdeleciones.
- Genome: Como MaterniT21 Plus + aneuploidias en todos los cromosomas + CNVs mayores a 7MB en todo el genoma. No apto para embarazo gemelar.

**Puntos clave para derivación:**
- Solo requiere muestra de sangre materna — no invasivo, sin riesgo fetal.
- El turno puede coordinarse desde la semana 6 de embarazo.
- No hay límite máximo de semanas para realizar el test.
- NIPT es screening, no diagnóstico. No descarta todas las anomalías cromosómicas posibles ni otros desórdenes no incluidos.
- BGI tiene presencia en más de 100 países y más de 10 millones de pruebas realizadas. Sequenom es laboratorio de referencia en San Diego, California.
`),

  // ═══════════════════════════════════════════════════════════════════════════
  // PRICING — por mercado
  // ═══════════════════════════════════════════════════════════════════════════

  item('nipt', 'pricing', 'AR', 'products_ar', `
## Precios NIPT — Argentina (USD)

Moneda: Dólares estadounidenses (USD).
Pago en pesos ARS disponible al tipo de cambio Banco Nación Venta (nunca dar el número exacto).
Se acepta efectivo únicamente en la oficina central CABA (Olleros 2411).

| Panel           | Precio USD |
|-----------------|-----------|
| Standard        | USD 270   |
| Standard Pro    | USD 330   |
| Advanced        | USD 450   |
| Advanced Pro    | USD 590   |
| MaterniT21 Plus | USD 750   |
| Genome          | USD 1.250 |

Costo logístico adicional para centros fuera de CABA: entre USD 50 y USD 100.
Ecografía incluida sin cargo para paneles premium (MaterniT21 Plus y Genome).
`),

  item('nipt', 'pricing', 'CO', 'products_co', `
## Precios NIPT — Colombia (COP)

Moneda: Pesos colombianos (COP).

| Panel           | Precio COP     |
|-----------------|----------------|
| Standard        | $1.050.000     |
| Standard Pro    | $1.275.000     |
| Advanced        | $1.782.000     |
| Advanced Pro    | $2.239.000     |
| MaterniT21 Plus | $2.995.000     |
| Genome          | $4.995.000     |

Costo logístico adicional para centros fuera de Bogotá, Medellín y Cali: $200.000 COP.
No se acepta pago en efectivo.
`),

  item('nipt', 'pricing', 'PE', 'products_pe', `
## Precios NIPT — Perú (PEN)

Moneda: Soles peruanos (S/). También acepta pago en dólares estadounidenses (USD).

| Panel           | Precio PEN |
|-----------------|-----------|
| Standard        | S/ 1.575  |
| Standard Pro    | S/ 1.715  |
| Advanced        | S/ 2.065  |
| Advanced Pro    | S/ 2.415  |
| MaterniT21 Plus | S/ 2.765  |
| Genome          | S/ 4.375  |

Costo logístico adicional para centros fuera de Lima: S/ 250.
No se acepta pago en efectivo.
`),

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGISTICS — centros de extracción por mercado
  // ═══════════════════════════════════════════════════════════════════════════

  item('nipt', 'logistics', 'AR', 'extraction_centers_ar', `
## Centros de extracción — Argentina

IMPORTANTE: Los pacientes NO deben contactar directamente a los centros. Todo se coordina a través de Genesia.

**Sin costo adicional de logística:**
- Ciudad de Buenos Aires: Oficina central Genesia — Olleros 2411

**Con costo adicional (entre USD 50 y USD 100):**
- Bahía Blanca, Buenos Aires: Biolab — Perú 439
- Junín, Buenos Aires: Laboratorio Dr. Luis Milani — Rivadavia 150
- La Plata, Buenos Aires: IPAC — Calle 12 1088 entre 54 y 55 / Calle 122 Nº 162 E 35 y 35 bis, Ensenada
- Mar del Plata, Buenos Aires: Laboratorio AC — Belgrano 3388
- Necochea, Buenos Aires: Laboratorio Alcorta Lacoste — Calle 61 Nro 2519
- Pergamino, Buenos Aires: Laboratorio Spinozzi — General Paz 823
- Tandil, Buenos Aires: Laboratorio Montani — Gral. Rodríguez 922
- Comodoro Rivadavia, Chubut: Sanatorio Español — Mitre 860
- Rawson, Chubut: Labsur — San Martín 449
- Córdoba: Fundación del Progreso para la Medicina — 9 de Julio 941
- Corrientes: ABA — Rivadavia 1349
- Concordia, Entre Ríos: Centro GAIA — Sargento Cabral 92
- Gualeguaychú, Entre Ríos: Laboratorio Centurión — 25 de Mayo 1255
- Paraná, Entre Ríos: Centro de Especialidades Bioquímicas — Buenos Aires 598
- Formosa: Laboratorio Dr. Raymundo Motter — Maipú 243
- San Salvador de Jujuy: Laboratorio German Brito — Alvear 491
- Mendoza: Laboratorio Pérez Elizalde — 25 de Mayo 576
- San Rafael, Mendoza: Laboratorio TECLAB — Santa Fe 457
- Posadas, Misiones: CEBAC — Av. Mitre 2330 PB
- Neuquén: IPAC Laboratorio — Leguizamón Onésimo 356
- Bariloche, Río Negro: Laboratorio IMI Dra. Pittau — Frey 481, Local 2
- General Roca, Río Negro: Diagnóstica - Grupo Bio — Pampa 1355
- Salta: Lab Ruiz Moreno — España 151
- San Juan: Nuevo Mater Puríssima Consultorios — 261 Martín Güemes Norte
- San Luis: Laboratorio Dr. Ricardo M. Bianco / Dra. Marta R. Bianco — Pedernera 962
- Santiago del Estero: Laboratorio Luis Oscar Trungelliti — Aguirre sur 1485
- El Calafate, Santa Cruz: Laboratorio Biolab S.R.L — Padre Agostini 90
- Rafaela, Santa Fe: Laboratorio Soldano — Bv. Hipólito Irigoyen 368
- Rosario, Santa Fe: Instituto de Fertilidad Colabianchi — Oroño 1520
- Santa Fe: Laboratorio Sager — Salvador Caputto 3290
- San Miguel de Tucumán: Laboratorio Sarmiento — Lavalle 868
- Tierra del Fuego: Contactar con asesora para coordinar costos y disponibilidad.

**Horarios CABA (Olleros 2411):**
Lunes, miércoles y viernes: 9:15 a 12:30.
Martes y jueves: disponible solo para paneles que no incluyen ecografía.
En el resto del país: según disponibilidad del laboratorio local.
`),

  item('nipt', 'logistics', 'CO', 'extraction_centers_co', `
## Centros de extracción — Colombia

IMPORTANTE: Los pacientes NO deben contactar directamente a los centros. Todo se coordina a través de Genesia.

**Sin costo adicional de logística:**
- Bogotá: Labopat – Sede principal Chico — Carrera 13 A #96-83, Piso 2
- Medellín: Laboratorio Centrolab (presencial y domicilios) — Calle 57A #48-21 Av. Oriental
- Cali: Laboratorio Clínico Elizabeth Valencia — Calle 5 #38-14 Ed. Consumedico, Ofc 402

**Con costo adicional ($200.000 COP):**
- Pereira: Laboratorio Clínico Controlab — Cra 5 #18-33, Lc 4, Centro de Especialistas
- Cartagena: Laboratorio Clínico Marisol Correa — Barrio Los Corales Manzana K, Lote 58
- Santa Marta: Laboratorio SOLAB — Cra 3A #24-113
- Barranquilla: Laboratorio JM Lab — Calle 75 #45-45
- Florencia (Caquetá): Laboratorio Nancy Sandoval — Calle 18 #5-21, Barrio 7 de agosto
- Chía: Schiller Laboratorio Clínico Mercy Blandón — Carrera 9 #14-54
- Cúcuta: Laboratorio Marta Lucía Gallardo — Av. 0 #1471, Los Caobos
- Montería: Monsalud IPS — Cra 5 #21-48, Barrio Centro
- Villavicencio: Laboratorio Labopat — Carrera 39 No. 33A–12, Barrio El Barzal
- Bucaramanga: RVG IPS BIC SAS — Carrera 33 #49-35, consultorio 111, CC Cabecera 2da etapa
- Barrancabermeja: RVG IPS SAS — Calle 46 No. 25-25, Barrio El Recreo
- Armenia: Laboratorio Clínico Carina Perea — Cra14 #9-18 Edf Tarantella, Piso 2, Ofc 202A
- Neiva (Huila): Laboratorio Central del Huila — Cll17 #8-09, Brr Campo Nuñez
- Pitalito (Huila): Laboratorio Central del Huila — Cra 2 #2-82
- Valledupar: Clínica de Rehabilitación y Diagnóstico AMARC IPS — Av. 19 No 11-13
- Popayán: AYM Laboratorio Clinico — Cra 9A #17N-35, Barrio Antonio Nariño
- Pasto: Laboratorios Del Valle — Calle 21 No. 30-29, Las Cuadras
- Tunja: Laboratorio Clínico Meditest Lab — Calle 20 #14-31
- Manizales: Laboratorio Clínico Valencia García Ltda. — Carrera 21 #24-04, frente a Antiguo Inurbe Centro

**Toma a domicilio disponible en:**
- Medellín: solo dentro de la ciudad, con Centrolab.
- Cali: dentro de Cali; con costo adicional si es fuera.
- Pereira: bajo disponibilidad, requiere confirmación previa.
- Barranquilla: coordinado con el laboratorio.
- Chía: solo para Zipaquirá, Cota y Cajicá, con costo adicional.

**Horarios:**
Bogotá, Medellín y Cali: lunes a jueves 7:00-15:30, viernes y sábados 7:00-10:00.
Resto del país: según disponibilidad del laboratorio.
`),

  item('nipt', 'logistics', 'PE', 'extraction_centers_pe', `
## Centros de extracción — Perú

IMPORTANTE: Los pacientes NO deben contactar directamente a los centros. Todo se coordina a través de Genesia.

**Sin costo adicional de logística:**
- Lima: Centro médico César Vallejo - Lince — Av. César Vallejo 1475, Lince

**Con costo adicional (S/ 250):**
- Cusco: Familab — Urb. CACHIMAYO C-13
- Huánuco: Centro especializado "Mujer" — Jr. Huallayco 1160
- Trujillo: PEDIAGYN — Av. El Golf 362, Urb. Las Flores del Golf
- Juliaca: Centro Ginecológico Obstétrico Bebe — Jr. Loreto 513, Rinconada
- Tacna: CenQhali Gyn Ginecología Especializada — Pasaje Plaza Zela 135 (al lado de canal América)

**Toma a domicilio disponible en:**
- Lima: solo dentro de la ciudad.

**Horarios:**
Los horarios se coordinan directamente con cada centro según disponibilidad.
`),

  // ═══════════════════════════════════════════════════════════════════════════
  // FAQ — operativa B2B por mercado
  // ═══════════════════════════════════════════════════════════════════════════

  item('nipt', 'faq', 'AR', 'operational_faq_ar', `
## Operativa B2B — Argentina

**Proceso de derivación:**
1. El médico indica el test a la paciente.
2. La paciente se contacta con Genesia (WhatsApp o email: info@genesia.com.ar).
3. Genesia coordina turno, toma de muestra y envío al laboratorio.
4. Resultados disponibles en 7-15 días hábiles (esenciales) o 5-10 días hábiles (premium).
5. Los resultados se envían directamente a la paciente.

**Honorarios médicos:**
Solo se informa a médicos verificados. Consultar con el equipo Genesia.

**Coordinación:**
- Asesora: Johanna, días hábiles 10-18hs, tel. +541156378500.
- No se necesita pago anticipado para coordinar el turno.
- Pago: USD (o pesos ARS al tipo de cambio BNA venta) — efectivo solo en CABA (Olleros 2411).
- Ecografía sin cargo incluida en paneles premium (MaterniT21 Plus y Genome).

**Timing:**
- Turno: se puede coordinar desde semana 6.
- Toma: desde semana 10 (esenciales) o semana 9 (premium).
- Sin límite máximo de semanas.
`),

  item('nipt', 'faq', 'CO', 'operational_faq_co', `
## Operativa B2B — Colombia

**Proceso de derivación:**
1. El médico indica el test a la paciente.
2. La paciente se contacta con Genesia (WhatsApp o email: info@genesia.com.co).
3. Genesia coordina turno, toma de muestra y envío al laboratorio.
4. Resultados disponibles en 7-15 días hábiles (esenciales) o 5-10 días hábiles (premium).

**Honorarios médicos:**
Solo se informa a médicos verificados. Consultar con el equipo Genesia.

**Coordinación:**
- Asesora: Eliana, días hábiles 8-18hs.
- El pago se realiza previamente a través del sitio web (ecommerce habilitado).
- No se acepta pago en efectivo.
- Website: https://colombia.genesia.la

**Timing:**
- Turno: desde semana 6.
- Toma: desde semana 10 (esenciales) o semana 9 (premium).
- Sin límite máximo de semanas.
`),

  item('nipt', 'faq', 'PE', 'operational_faq_pe', `
## Operativa B2B — Perú

**Proceso de derivación:**
1. El médico indica el test a la paciente.
2. La paciente se contacta con Genesia (WhatsApp o email: info@genesia.pe).
3. Genesia coordina turno, toma de muestra y envío al laboratorio.
4. Resultados disponibles en 7-15 días hábiles (esenciales) o 5-10 días hábiles (premium).

**Honorarios médicos:**
Solo se informa a médicos verificados. Consultar con el equipo Genesia.

**Coordinación:**
- Agente: Valeria, días hábiles 9-17hs, tel. +51923813224.
- Pago en soles (S/) o dólares (USD). No se acepta efectivo.
- Website: https://peru.genesia.la

**Timing:**
- Turno: desde semana 6.
- Toma: desde semana 10 (esenciales) o semana 9 (premium).
- Sin límite máximo de semanas.
`),

];

// ─── SEED ───────────────────────────────────────────────────────────────────

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let upserted = 0;
    for (const it of items) {
      await client.query(
        `INSERT INTO knowledge_items (domain, kind, market, key, data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (domain, kind, market, key)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [it.domain, it.kind, it.market, it.key, JSON.stringify(it.data)]
      );
      upserted++;
    }

    await client.query('COMMIT');
    console.log(`✓ Seed completo: ${upserted} items upserted.`);

    // Quick verification
    const { rows } = await client.query(
      `SELECT domain, kind, market, key FROM knowledge_items ORDER BY domain, kind, market, key`
    );
    console.log('\nKB actual:');
    for (const r of rows) {
      console.log(`  [${r.domain}] ${r.kind} / ${r.market || 'global'} / ${r.key}`);
    }
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(e => {
  console.error('Seed failed:', e?.message || e);
  process.exit(1);
});
