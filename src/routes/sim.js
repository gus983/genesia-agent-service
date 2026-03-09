/**
 * sim.js — HTTP endpoints for running simulation jobs from genesia-viewer.
 *
 * POST /sim/jobs          → start a background job (sim + analyze)
 * GET  /sim/jobs/latest   → last completed job info (or reads proposals/latest.md from disk)
 * GET  /sim/jobs/:id      → job status
 * GET  /sim/jobs/:id/report   → markdown report content
 * GET  /sim/jobs/:id/proposal → markdown proposal content
 *
 * Security: requires x-internal-secret header matching INTERNAL_SECRET env var.
 */

import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ─── JOB STORE ───────────────────────────────────────────────────────────────

const jobs = new Map();
// job shape: { status, created_at, n, market, report_path?, proposal_path?, error?, stdout, stderr }
// status: 'running_sim' | 'running_analysis' | 'done' | 'error'

// Clean up jobs older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.created_at < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

function hasActiveJob() {
  for (const job of jobs.values()) {
    if (job.status === 'running_sim' || job.status === 'running_analysis') return true;
  }
  return false;
}

function makeJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── RUNNER ──────────────────────────────────────────────────────────────────

function spawnScript(scriptPath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; process.stdout.write(`[sim] ${d}`); });
    proc.stderr.on('data', d => { stderr += d; process.stderr.write(`[sim] ${d}`); });
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`exit code ${code}`), { stdout, stderr }));
    });
    proc.on('error', reject);
  });
}

async function runJob(job_id, n, market) {
  const job = jobs.get(job_id);
  const simScript = path.join(ROOT, 'scripts/sim-conversations.js');
  const analyzeScript = path.join(ROOT, 'scripts/analyze-reports.js');

  try {
    // Phase 1: simulation
    job.status = 'running_sim';
    const simEnv = {};
    if (n) simEnv.SIM_N = String(n);
    if (market) simEnv.SIM_MARKET = market;

    const { stdout: simOut } = await spawnScript(simScript, simEnv);

    // Extract report path from stdout: "✅ Reporte generado: /path/to/file.md"
    const reportMatch = simOut.match(/Reporte generado:\s*(\S+\.md)/);
    const reportPath = reportMatch ? reportMatch[1] : null;
    if (reportPath) job.report_path = reportPath;

    // Phase 2: analysis
    job.status = 'running_analysis';
    const analyzeArgs = reportPath ? [reportPath] : [];
    const analyzeEnv = {};
    await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [analyzeScript, ...analyzeArgs], {
        cwd: ROOT,
        env: { ...process.env, ...analyzeEnv },
      });
      let stdout = '';
      proc.stdout.on('data', d => { stdout += d; process.stdout.write(`[analyze] ${d}`); });
      proc.stderr.on('data', d => process.stderr.write(`[analyze] ${d}`));
      proc.on('close', code => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`analyze exit code ${code}`));
      });
      proc.on('error', reject);
    });

    // Find latest proposal
    const latestPath = path.join(ROOT, 'proposals/latest.md');
    job.proposal_path = fs.existsSync(latestPath) ? latestPath : null;
    job.status = 'done';
    console.log(`sim_job_done job_id=${job_id}`);
  } catch (e) {
    job.status = 'error';
    job.error = e?.message || String(e);
    console.error(`sim_job_error job_id=${job_id} err=${job.error}`);
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, error: 'INTERNAL_SECRET not configured' });
  }
  if (req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export function simRouter() {
  const router = express.Router();
  router.use(authMiddleware);

  // POST /sim/jobs — start a new job
  router.post('/jobs', (req, res) => {
    if (hasActiveJob()) {
      return res.status(409).json({ ok: false, error: 'already_running', message: 'Ya hay una simulación en curso.' });
    }

    const n = Number(req.body?.n) || 0;
    const market = ['AR', 'CO', 'PE'].includes(String(req.body?.market || '').toUpperCase())
      ? String(req.body.market).toUpperCase()
      : null;

    const job_id = makeJobId();
    jobs.set(job_id, {
      status: 'running_sim',
      created_at: Date.now(),
      n,
      market,
      report_path: null,
      proposal_path: null,
      error: null,
    });

    // Fire and forget
    runJob(job_id, n, market).catch(e => console.error('runJob uncaught:', e?.message));

    res.json({ ok: true, job_id });
  });

  // GET /sim/jobs/latest — last done job or disk fallback
  router.get('/jobs/latest', (req, res) => {
    // Find the most recently completed job
    let latest = null;
    for (const [id, job] of jobs.entries()) {
      if (job.status === 'done') {
        if (!latest || job.created_at > latest.created_at) {
          latest = { job_id: id, ...job };
        }
      }
    }

    if (latest) {
      return res.json({ ok: true, job_id: latest.job_id, status: 'done', report_path: latest.report_path, proposal_path: latest.proposal_path });
    }

    // Fallback: check disk for proposals/latest.md
    const latestPath = path.join(ROOT, 'proposals/latest.md');
    if (fs.existsSync(latestPath)) {
      return res.json({ ok: true, job_id: null, status: 'done', report_path: null, proposal_path: latestPath });
    }

    res.json({ ok: true, job_id: null, status: null, report_path: null, proposal_path: null });
  });

  // GET /sim/jobs/:id — job status
  router.get('/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({
      ok: true,
      job_id: req.params.id,
      status: job.status,
      created_at: job.created_at,
      n: job.n,
      market: job.market,
      report_path: job.report_path,
      proposal_path: job.proposal_path,
      error: job.error,
    });
  });

  // GET /sim/jobs/:id/report
  router.get('/jobs/:id/report', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!job.report_path || !fs.existsSync(job.report_path)) {
      return res.status(404).json({ ok: false, error: 'report_not_ready' });
    }
    res.type('text/plain; charset=utf-8').send(fs.readFileSync(job.report_path, 'utf8'));
  });

  // GET /sim/jobs/:id/proposal (id='latest' reads proposals/latest.md from disk)
  router.get('/jobs/:id/proposal', (req, res) => {
    if (req.params.id === 'latest') {
      const latestPath = path.join(ROOT, 'proposals/latest.md');
      if (!fs.existsSync(latestPath)) return res.status(404).json({ ok: false, error: 'no_proposals_yet' });
      return res.type('text/plain; charset=utf-8').send(fs.readFileSync(latestPath, 'utf8'));
    }
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!job.proposal_path || !fs.existsSync(job.proposal_path)) {
      return res.status(404).json({ ok: false, error: 'proposal_not_ready' });
    }
    res.type('text/plain; charset=utf-8').send(fs.readFileSync(job.proposal_path, 'utf8'));
  });

  return router;
}
