import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initSchema } from './db/init.js';
import authRouter from './routes/auth.js';
import dataRouter from './routes/data.js';
import scheduleRouter from './routes/schedule.js';
import ticktickRouter from './routes/ticktick.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api', dataRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api', ticktickRouter);

// serve built frontend (single-service deploy)
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = process.env.PORT || 3001;
await initSchema();
app.listen(PORT, () => console.log(`API on :${PORT}`));
