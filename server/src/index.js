import express from 'express';
import cors from 'cors';
import authRouter from './routes/auth.js';
import dataRouter from './routes/data.js';
import scheduleRouter from './routes/schedule.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api', dataRouter);
app.use('/api/schedule', scheduleRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API on :${PORT}`));
