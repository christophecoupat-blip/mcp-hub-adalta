'use strict';

const express = require('express');
const http    = require('http');
const { spawn } = require('child_process');
const path    = require('path');

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
// sessionId → { port, msgPath: '/message' ou '/messages' }
const sessions = new Map();

function startService(svc) {
  const dir = path.join(SERVICES_DIR, svc.repo);
  console.log(`[HUB] Démarrage ${svc.name} (port ${svc.port})...`);
  const child = spawn('npm', ['start'], {
    cwd: dir,
    env: { ...process.env, PORT: String(svc.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', d => process.stdout.write(`[${svc.name}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${svc.name}] ${d}`));
  child.on('exit', (code, signal) => {
    if (signal === 'SIGTERM') return;
    console.warn(`[HUB] ${svc.name} arrêté. Redémarrage dans 5s...`);
    setTimeout(() => startService(svc), 5000);
  });
}

for (const svc of SERVICES) startService(svc);

const STARTUP_DELAY = parseInt(process.env.STARTUP_DELAY || '10000', 10);
console.log(`[HUB] Attente ${STARTUP_DELAY / 1000}s...`);

setTimeout(() => {
  const app = express();

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      sessions: sessions.size,
      connecteurs: SERVICES.map(s => ({
        nom: s.name,
        sse: `https://mcp-hub-adalta.osc-fr1.scalingo.io/${s.name}/sse`,
      })),
    });
  });

  // SSE — capture /message OU /messages
  app.get('/:service/sse', (req, res) => {
    const svc = SERVICES.find(s => s.name === req.params.service);
    if (!svc) return res.status(404).json({ error: 'Service inconnu' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const targetReq = http.request({
      hostname: 'localhost', port: svc.port, path: '/sse', method: 'GET',
      headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
    }, (targetRes) => {
      targetRes.on('data', (chunk) => {
        const text = chunk.toString();

        // Capture /message?sessionId= OU /messages?sessionId=
        const match = text.match(/data:\s*(\/messages?\?sessionId=([^\s\n\r]+))/);
        if (match) {
          const fullEndpoint = match[1].trim();          // ex: /message?sessionId=xxx
          const sessionId    = match[2].trim();          // ex: 1778413152057
          const msgPath      = fullEndpoint.split('?')[0]; // /message ou /messages
          sessions.set(sessionId, { port: svc.port, msgPath });
          console.log(`[HUB] Session: ${sessionId} → ${svc.name} (${msgPath})`);
        }

        res.write(text);
      });
      targetRes.on('end', () => res.end());
      targetRes.on('error', () => res.end());
    });

    targetReq.on('error', (err) => {
      console.error(`[HUB] Erreur ${svc.name}:`, err.message);
      res.end();
    });
    targetReq.end();
    req.on('close', () => targetReq.destroy());
  });

  // POST /message ou /messages → routing par sessionId
  function handlePost(req, res) {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId manquant' });

    const session = sessions.get(sessionId);
    if (!session) {
      console.warn(`[HUB] Session inconnue: ${sessionId}`);
      return res.status(404).json({ error: `Session inconnue: ${sessionId}` });
    }

    const { port, msgPath } = session;

    const proxyReq = http.request({
      hostname: 'localhost', port, method: 'POST',
      path: `${msgPath}?sessionId=${sessionId}`,
      headers: { ...req.headers, host: `localhost:${port}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(503).json({ error: err.message });
    });
    req.pipe(proxyReq);
  }

  app.post('/messages', handlePost);
  app.post('/message',  handlePost);

  // Compatibilité /:service/messages et /:service/message
  app.post('/:service/messages', (req, res) => proxyToService(req, res, '/messages'));
  app.post('/:service/message',  (req, res) => proxyToService(req, res, '/message'));

  function proxyToService(req, res, msgPath) {
    const svc = SERVICES.find(s => s.name === req.params.service);
    if (!svc) return res.status(404).json({ error: 'Service inconnu' });
    const sessionId = req.query.sessionId;
    const proxyReq = http.request({
      hostname: 'localhost', port: svc.port, method: 'POST',
      path: `${msgPath}${sessionId ? `?sessionId=${sessionId}` : ''}`,
      headers: { ...req.headers, host: `localhost:${svc.port}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
 
