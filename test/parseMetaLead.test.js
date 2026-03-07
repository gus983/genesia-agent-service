import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseMetaLead, leadToContactUpdate } from '../src/lib/parseMetaLead.js';

// --- parseMetaLead ---

describe('parseMetaLead', () => {

  it('parses a standard Meta lead with all fields', () => {
    const text = [
      'profesión_(ej._obstetricia): obstetricia',
      'email: maria.gomez@clinica.pe',
      'full_name: María Gómez',
      'phone_number: +51999888777',
    ].join('\n');

    const result = parseMetaLead(text);
    assert.deepStrictEqual(result, {
      profession:   'obstetricia',
      email:        'maria.gomez@clinica.pe',
      full_name:    'María Gómez',
      phone_number: '+51999888777',
    });
  });

  it('parses a lead with uppercase keys and no phone field', () => {
    const text = [
      'Profesión: Ginecología',
      'Full_Name: Carlos Ríos',
      'Email: carlos@hospital.pe',
    ].join('\n');

    const result = parseMetaLead(text);
    assert.ok(result, 'should not be null');
    assert.strictEqual(result.profession, 'Ginecología');
    assert.strictEqual(result.full_name,  'Carlos Ríos');
    assert.strictEqual(result.email,      'carlos@hospital.pe');
    assert.strictEqual(result.phone_number, undefined);
  });

  it('returns null for a regular conversation message', () => {
    const text = 'Hola, quería consultar sobre el NIPT para mi paciente de 38 años.';
    assert.strictEqual(parseMetaLead(text), null);
  });

  it('returns null when fewer than 2 recognized fields are present', () => {
    const text = 'email: solo@un.campo';
    assert.strictEqual(parseMetaLead(text), null);
  });

});

// --- leadToContactUpdate ---

describe('leadToContactUpdate', () => {

  it('maps obstetricia → medico_derivador, verified_doctor=true', () => {
    const upd = leadToContactUpdate({ profession: 'obstetricia', full_name: 'Ana' });
    assert.strictEqual(upd.contact_type,    'medico_derivador');
    assert.strictEqual(upd.verified_doctor,  true);
    assert.strictEqual(upd.verification_source, 'meta_lead');
    assert.strictEqual(upd.name, 'Ana');
  });

  it('maps clínica → institucion, verified_doctor=false', () => {
    const upd = leadToContactUpdate({ profession: 'clínica privada', full_name: 'Centro Salud' });
    assert.strictEqual(upd.contact_type,    'institucion');
    assert.strictEqual(upd.verified_doctor,  false);
  });

  it('defaults to medico_derivador when profession is absent but email+name present', () => {
    const upd = leadToContactUpdate({ email: 'x@x.com', full_name: 'Juan' });
    assert.strictEqual(upd.contact_type,    'medico_derivador');
    assert.strictEqual(upd.verified_doctor,  true);
  });

});
