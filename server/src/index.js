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
import importRouter from './routes/import.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' })); // 多張照片一起匯入（前端已先縮圖，這裡只是保險）

app.use('/api/auth', authRouter);
app.use('/api', dataRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api', ticktickRouter);
app.use('/api/import', importRouter);

// serve built frontend (single-service deploy)
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = process.env.PORT || 3001;
await initSchema();
app.listen(PORT, () => console.log(`API on :${PORT}`));
