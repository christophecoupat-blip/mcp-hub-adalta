'use strict';

// ── server.js — MCP Hub ADALTA ────────────────────────────────────────────────
// Démarre les 10 serveurs MCP en tant que processus enfants,
// puis proxy les requêtes SSE entrantes vers chacun selon le chemin URL.
//
//   Claude.ai → https://mcp-hub-adalta.osc-fr1.scalingo.io/boss/sse
//            → proxy → localhost:3007/sse
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { spawn }  = require('child_process');
const path       = require('path');

// ── Déclaration des services ─────────────────────────────────────────────────
const SERVICES = [
  { name: 'pennylane', repo: 'pennylane-mcp', port: 3001 },
  { name: 'urssaf',    repo: 'urssaf-mcp',    port: 3002 },
  { name: 'rne',       repo: 'rne-mcp',       port: 3003 },
  { name: 'bocc',      repo: 'bocc-mcp',      port: 3004 },
  { name: 'judilibre', repo: 'judilibre-mcp', port: 3005 },
  { name: 'kali',      repo: 'kali-mcp',      port: 3006 },
  { name: 'boss',      repo: 'boss-mcp',      port: 3007 },
  { name: 'bofip',     repo: 'bofip-mcp',     port: 3008 },
  { name: 'sirene',    repo: 'sirene-mcp',    port: 3009 },
  { name: 'legifrance',repo: 'legifrance-mcp',port: 3010 },
];

const SERVICES_DIR = path.join(__dirname, 'services');

// ── Démarrage des processus enfants ─────────────────────────────────────────
function startService(svc) {
  const dir = path.join(SERVICES_DIR, svc.repo);
  console.log(`[HUB] Démarrage de ${svc.name} (port interne ${svc.port})...`);

  const child = spawn('npm', ['start'], {
    cwd: dir,
    env: { ...process.env, PORT: String(svc.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  child.stdout.on('data', d => process.stdout.write(`[${svc.name}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${svc.name}] ${d}`));

  child.on('error', err => {
    console.error(`[HUB] ✗ Erreur démarrage ${svc.name} : ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (signal === 'SIGTERM') return; // arrêt volontaire
    console.warn(`[HUB] ⚠ ${svc.name} s'est arrêté (code=${code}). Redémarrage dans 5s...`);
    setTimeout(() => startService(svc), 5_000);
  });

  return child;
}

// Lancer tous les services
console.log('[HUB] Lancement des 10 connecteurs MCP...\n');
for (const svc of SERVICES) {
  startService(svc);
}

// ── Attente du démarrage des services (10 secondes) ─────────────────────────
const STARTUP_DELAY = parseInt(process.env.STARTUP_DELAY || '10000', 10);
console.log(`[HUB] Attente de ${STARTUP_DELAY / 1000}s pour l'initialisation des services...`);

setTimeout(() => {

  const app = express();

  // ── Endpoint de santé (/health) ──────────────────────────────
  app.get('/health', (req, res) => {
    const base = process.env.SCALINGO_APP_URL
      ? `https://${process.env.SCALINGO_APP_URL}`
      : `http://localhost:${process.env.PORT || 5000}`;
    res.json({
      status:    'ok',
      timestamp: new Date().toISOString(),
      connecteurs: SERVICES.map(s => ({
        nom: s.name,
        sse: `${base}/${s.name}/sse`,
      })),
    });
  });

  // ── Proxy SSE pour chaque service ────────────────────────────
  for (const svc of SERVICES) {
    app.use(
      `/${svc.name}`,
      createProxyMiddleware({
        target:      `http://localhost:${svc.port}`,
        changeOrigin: false,
        pathRewrite:  { [`^/${svc.name}`]: '' },

        // Connexions longues / SSE
        proxyTimeout: 0,
        timeout:      0,

        on: {
          proxyReq: (proxyReq, req) => {
            // Headers SSE
            if (req.headers.accept === 'text/event-stream') {
              proxyReq.setHeader('Cache-Control', 'no-cache');
              proxyReq.setHeader('Connection',    'keep-alive');
            }
          },
          proxyRes: (proxyRes) => {
            // Désactiver le buffering Nginx/Scalingo pour SSE
            proxyRes.headers['x-accel-buffering'] = 'no';
            proxyRes.headers['cache-control']     = 'no-cache';
          },
          error: (err, req, res) => {
            console.error(`[HUB] ✗ Proxy ${svc.name} : ${err.message}`);
            if (!res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error:      `Service ${svc.name} temporairement indisponible`,
                retryAfter: 5,
              }));
            }
          },
        },
      })
    );
  }

  // ── Démarrage du serveur hub ─────────────────────────────────
  const PORT = parseInt(process.env.PORT || '5000', 10);

  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '═'.repeat(55));
    console.log('  MCP HUB ADALTA — Scalingo — ACTIF');
    console.log('═'.repeat(55));
    console.log(`  Port d'écoute : ${PORT}`);
    console.log('\n  Connecteurs disponibles :');
    for (const svc of SERVICES) {
      console.log(`    ✓ /${svc.name}/sse → localhost:${svc.port}`);
    }
    console.log('\n  Vérification : GET /health');
    console.log('═'.repeat(55) + '\n');
  });

}, STARTUP_DELAY);
