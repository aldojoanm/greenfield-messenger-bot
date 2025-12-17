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
app.get('/debug/files', (_req, res) => {
  const byDir_cfg = path.join(__dirname, 'knowledge', 'greenfield_advisors.json');
  const byCwd_cfg = path.join(process.cwd(), 'knowledge', 'greenfield_advisors.json');

  res.json({
    cwd: process.cwd(),
    __dirname,
    byDir_cfg,
    byDir_cfg_exists: fs.existsSync(byDir_cfg),
    byCwd_cfg,
    byCwd_cfg_exists: fs.existsSync(byCwd_cfg),
    list_knowledge_byDir: fs.existsSync(path.join(__dirname, 'knowledge'))
      ? fs.readdirSync(path.join(__dirname, 'knowledge'))
      : null,
    list_knowledge_byCwd: fs.existsSync(path.join(process.cwd(), 'knowledge'))
      ? fs.readdirSync(path.join(process.cwd(), 'knowledge'))
      : null,
  });
});
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
