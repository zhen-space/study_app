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
import plansRouter from './routes/plans.js';
import routinesRouter from './routes/routines.js';
import studySessionsRouter from './routes/study-sessions.js';
import goalsRouter from './routes/goals.js';
import constraintsRouter from './routes/constraints.js';
import legacyMigrationRouter from './routes/legacy-migration.js';
import materialRouter from './routes/material.js';
import integrationsRouter from './routes/integrations.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' })); // 多張照片一起匯入（前端已先縮圖，這裡只是保險）

app.use('/api/auth', authRouter);
// 必須排在其他 /api router 之前。那些 router 內部是 router.use(requireAuth)，
// 而 Express 的 router-level middleware 對「進入這個 router 的每一個請求」都會跑，
// 不管最後有沒有匹配到路由——排在後面的話，Google OAuth callback 會先被
// 別人的 requireAuth 擋成 401，而 Google 導回來時本來就不會帶我們的 header。
app.use('/api', integrationsRouter);
app.use('/api', dataRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api', plansRouter);
app.use('/api', routinesRouter);
app.use('/api', studySessionsRouter);
app.use('/api', goalsRouter);
app.use('/api', constraintsRouter);
app.use('/api', legacyMigrationRouter);
app.use('/api', materialRouter);
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
