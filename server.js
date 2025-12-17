// server.js (Greenfield - SOLO Messenger + estáticos básicos)
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import messengerRouter from './index.js'; 
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
app.use('/image', express.static(path.join(__dirname, 'image')));
app.use(messengerRouter);
app.use((_req, res) => res.status(404).send('Not Found'));

app.use((err, _req, res, _next) => {
  console.error('❌ Server error:', err?.message || err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Greenfield Server en :${PORT}`);
  console.log('   • Messenger: GET/POST /webhook');
  console.log('   • Privacy:   GET      /privacidad');
  console.log('   • Health:    GET      /healthz');
});
