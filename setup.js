'use strict';

// ── setup.js ──────────────────────────────────────────────────────────────────
// Exécuté automatiquement lors de "npm install" (postinstall).
// Clone chaque repo MCP depuis GitHub et installe ses dépendances.
// Ce script tourne côté Scalingo au moment du BUILD, pas au runtime.
// ─────────────────────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const GITHUB_ORG  = 'christophecoupat-blip';
const SERVICES_DIR = path.join(__dirname, 'services');

const REPOS = [
  'pennylane-mcp',
  'urssaf-mcp',
  'rne-mcp',
  'bocc-mcp',
  'judilibre-mcp',
  'kali-mcp',
  'boss-mcp',
  'bofip-mcp',
  'sirene-mcp',
  'legifrance-mcp',
];

// Créer le dossier services/ si absent
if (!fs.existsSync(SERVICES_DIR)) {
  fs.mkdirSync(SERVICES_DIR, { recursive: true });
  console.log('[SETUP] Dossier services/ créé');
}

let errors = 0;

for (const repo of REPOS) {
  const dir = path.join(SERVICES_DIR, repo);
  const url = `https://github.com/${GITHUB_ORG}/${repo}.git`;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[SETUP] Traitement de : ${repo}`);

  // ── Clone ou mise à jour ──────────────────────────────────────
  if (!fs.existsSync(dir)) {
    console.log(`[SETUP] ▶ Clonage depuis GitHub...`);
    try {
      execSync(`git clone --depth 1 "${url}" "${dir}"`, {
        stdio: 'inherit',
        timeout: 90_000,
      });
      console.log(`[SETUP] ✓ Cloné avec succès`);
    } catch (err) {
      console.error(`[SETUP] ✗ Échec du clonage : ${err.message}`);
      errors++;
      continue;
    }
  } else {
    console.log(`[SETUP] ↻ Déjà présent — mise à jour (git pull)...`);
    try {
      execSync('git pull --rebase origin main', {
        cwd: dir, stdio: 'inherit', timeout: 30_000,
      });
    } catch {
      console.warn(`[SETUP] ⚠ git pull ignoré (branche ou réseau)`);
    }
  }

  // ── Installation des dépendances npm ─────────────────────────
  console.log(`[SETUP] ▶ npm install --production...`);
  try {
    execSync('npm install --production --no-audit --no-fund', {
      cwd: dir,
      stdio: 'inherit',
      timeout: 180_000,
    });
    console.log(`[SETUP] ✓ Dépendances installées`);
  } catch (err) {
    console.error(`[SETUP] ✗ npm install échoué : ${err.message}`);
    errors++;
  }
}

console.log(`\n${'═'.repeat(60)}`);

if (errors > 0) {
  console.error(`[SETUP] ✗ ${errors} erreur(s) détectée(s). Build interrompu.`);
  process.exit(1);
}

console.log('[SETUP] ✅ Tous les services installés avec succès !');
console.log('[SETUP] Le hub est prêt à démarrer.\n');
