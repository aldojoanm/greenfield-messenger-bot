// server.js
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import messengerRouter, { runtimeDebug } from './index.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/debug/files', (_req, res) => {
  const kd = path.join(__dirname, 'knowledge');
  const pub = path.join(__dirname, 'public');
  const ing = path.join(__dirname, 'public', 'ingenieros');

  const safeList = (dir) => {
    try {
      if (!fs.existsSync(dir)) return null;
      return fs.readdirSync(dir);
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  };

  res.json({
    cwd: process.cwd(),
    __dirname,
    paths: {
      knowledge_dir: kd,
      knowledge_exists: fs.existsSync(kd),
      public_dir: pub,
      public_exists: fs.existsSync(pub),
      ingenieros_dir: ing,
      ingenieros_exists: fs.existsSync(ing),
    },
    list: {
      knowledge: safeList(kd),
      public: safeList(pub),
      ingenieros: safeList(ing),
    },
  });
});

app.get('/debug/config', (_req, res) => {
  res.json(runtimeDebug());
});

app.use(messengerRouter);

app.use((_req, res) => res.status(404).send('Not Found'));
app.use((err, _req, res, _next) => {
  console.error('❌ Server error:', err?.stack || err?.message || err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Greenfield Server en :${PORT}`);
  console.log('   • Messenger: GET/POST /webhook');
  console.log('   • Privacy:   GET      /privacidad');
  console.log('   • Debug:     GET      /debug/files  y  /debug/config');
});
