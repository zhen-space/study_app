import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { addDays, dayOfWeek, todayTW } from '../util/date.js';
import * as sched from '../schedule/persistence.js';

const router = Router();
router.use(requireAuth);

const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function freeSlotsForDay(dateStr, events, settings) {
  const busy = [];
  const sleepStart = toMin(settings.sleep_start);
  const sleepEnd = toMin(settings.sleep_end);
  if (sleepStart > sleepEnd) busy.push([0, sleepEnd], [sleepStart, 1440]);
  else busy.push([sleepStart, sleepEnd]);
  for (const [a, b] of settings.meal_windows) busy.push([toMin(a), toMin(b)]);

  const dow = dayOfWeek(dateStr);
  for (const e of events) {
    const applies = e.recurring === 'weekly'
      ? dayOfWeek(e.date) === dow && e.date <= dateStr
      : e.date === dateStr;
    if (applies) busy.push([toMin(e.start_time), toMin(e.end_time)]);
  }

  busy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of busy) {
    if (merged.length && iv[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
    } else merged.push([...iv]);
  }
  const free = [];
  let cur = 0;
  for (const [a, b] of merged) {
    if (a - cur >= 30) free.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (1440 - cur >= 30) free.push([cur, 1440]);
  return free;
}

// POST /api/schedule/preview
// { items:[{subject_id, title, minutes, start, end, final}], mode:'order'|'spread', startDate?, endDate? }
// 每個項目可有自己的日期範圍；final=true 的項目（壓軸）會排在其他項目全部結束之後
// 某天既定行程（含週期）的總分鐘數
function busyMinutesForDay(dateStr, events) {
  const dow = dayOfWeek(dateStr);
  let m = 0;
  for (const e of events) {
    const applies = e.recurring === 'weekly'
      ? dayOfWeek(e.date) === dow && e.date <= dateStr
      : e.date === dateStr;
    if (applies) m += toMin(e.end_time) - toMin(e.start_time);
  }
  return m;
}

router.post('/preview', async (req, res) => {
  const { items, excludeWeekdays = [], excludeDates = [], skipIfBusyHours = 0, timed = true, perDay = 3, pace = 'even' } = req.body;
  if (!items?.length) return res.status(400).json({ error: '參數不完整' });
  const today = todayTW(); // 台灣時區的今天
  const gStart = req.body.startDate || today, gEnd = req.body.endDate || today;
  for (const it of items) { it.start = it.start || gStart; it.end = it.end || gEnd; }
  // 純題目（單元練習／歷屆試題）一天只排一份。項目可能來自不同路徑，
  // 其中「使用者自己標純題目」那條不會帶 onePerDay 旗標 → 規則就會失效。
  // 這裡照標題最後一段補上，不管前端怎麼送都守得住。
  const ONE_TAIL = /(單元練習|歷屆試題|歷屆|試題|練習|題目)$/;
  for (const it of items) {
    if (it.onePerDay) continue;
    const tail = String(it.title || '').split('｜').pop().trim();
    if (ONE_TAIL.test(tail)) it.onePerDay = true;
  }

  const minD = items.reduce((a, i) => i.start < a ? i.start : a, items[0].start);
  const maxD = items.reduce((a, i) => i.end > a ? i.end : a, items[0].end);

  const u = await q.get('SELECT sleep_start, sleep_end, meal_windows FROM users WHERE id=?', [req.userId]);
  const settings = { ...u, meal_windows: JSON.parse(u.meal_windows) };
  if (req.body.sleep_start) settings.sleep_start = req.body.sleep_start;
  if (req.body.sleep_end) settings.sleep_end = req.body.sleep_end;
  const events = await q.all('SELECT * FROM fixed_events WHERE user_id=?', [req.userId]);
  // 全域排程：其他 Plan 已經生效的「有明確起迄時間」block 必須佔住時段。
  // 本次正在重排的 Plan 可釋出自己的舊 block，讓演算法重新安插；建立新 Plan
  // 沒有 plan_id 時則不排除任何既有 block。untimed block 不代表特定時段，不能
  // 在這裡把整天封死。
  if (timed) {
    const activeVersionId = await sched.getActiveVersionId(req.userId);
    if (activeVersionId != null) {
      const currentPlanId = req.body.plan_id ?? null;
      const scheduledBusy = await q.all(
        `SELECT b.date, b.start_time, b.end_time
           FROM scheduled_blocks b
           JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id
          WHERE b.schedule_version_id=? AND b.user_id=?
            AND t.plan_id IS NOT NULL AND COALESCE(t.deleted,0)=0 AND t.completed=0
            AND b.date>=? AND b.start_time IS NOT NULL AND b.end_time IS NOT NULL
            AND (? IS NULL OR t.plan_id<>?)`,
        [activeVersionId, req.userId, today, currentPlanId, currentPlanId]);
      events.push(...scheduledBusy.map(b => ({ ...b, recurring: null, _scheduled: true })));
    }
  }

  const days = [];
  for (let ds = minD; ds <= maxD; ds = addDays(ds, 1)) {
    if (ds < today) continue;
    if (excludeDates.includes(ds)) continue;                      // 指定不排的日期
    if (excludeWeekdays.includes(dayOfWeek(ds))) continue;        // 不排的星期
    if (skipIfBusyHours > 0 && busyMinutesForDay(ds, events) >= skipIfBusyHours * 60) continue; // 既定行程太滿
    days.push({ date: ds, slots: freeSlotsForDay(ds, events, settings), slotIdx: 0 });
  }
  if (!days.length) return res.status(400).json({ error: '沒有可排的日期' });
  days.forEach(d => { d.pos = d.slots[0]?.[0] ?? null; });

  const CHUNK = 90, BREAK = 10;
  // 純題目（單元練習／歷屆試題）同一天同一科最多幾份：
  // 理想是 1，範圍真的不夠時退讓到 2（使用者：「就一天兩單元吧」），不會有第 3 份
  const ONE_CAP = 2;
  const mkChunks = list => {
    const out = [];
    for (const it of list) {
      if (!timed) { out.push({ ...it, chunk: 0 }); continue; } // 不計時：一項就是一個單位
      let rem = it.minutes || 120;
      while (rem > 0) {
        const c = Math.min(CHUNK, rem);
        out.push({ ...it, chunk: rem - c > 0 && rem - c < 30 ? rem : c });
        rem -= out[out.length - 1].chunk;
      }
    }
    return out;
  };

  // 佇列：同科目內依「打散/照順序」排列（item.spread，預設打散），跨科目一律輪流（每天各科都碰到）
  function buildQueue(list) {
    const bySub = {};
    list.forEach(it => { (bySub[it.subject_id] = bySub[it.subject_id] || []).push(it); });
    const subjQueues = Object.values(bySub).map(subjItems => {
      const chunkLists = subjItems.map(it => mkChunks([it]));
      if (subjItems[0].spread === false) return chunkLists.flat(); // 照章節順序
      const out = []; let added = true;                            // 章節打散：輪流
      while (added) { added = false; for (const cl of chunkLists) if (cl.length) { out.push(cl.shift()); added = true; } }
      return out;
    });
    const out = []; let added = true;
    while (added) { added = false; for (const q2 of subjQueues) if (q2.length) { out.push(q2.shift()); added = true; } }
    return out;
  }

  const firstsQ = buildQueue(items.filter(i => i.first && !i.final));  // 要先完成的
  const work = buildQueue(items.filter(i => !i.first && !i.final));
  const finals = buildQueue(items.filter(i => i.final));               // 壓軸也照順序

  const blocks = [];
  const failed = [];
  days.forEach(d => { d.load = 0; d.count = 0; d.subs = new Set(); }); // load=分鐘數 count=項數 subs=當天已排科目

  // 這一天塞不塞得下這個 chunk（timed 才需要判斷時間）
  function fits(day, w) {
    if (!timed) return day.slots.length > 0;
    let idx = day.slotIdx, pos = day.pos;
    while (idx < day.slots.length) {
      if (pos + w.chunk <= day.slots[idx][1]) return true;
      idx++; pos = day.slots[idx]?.[0] ?? null;
    }
    return false;
  }
  // 真的排進去（_bk/_ws/_we 供產出前的平衡搬移用，回傳前會清掉）
  function put(day, w) {
    if (!timed) {
      if (!day.slots.length) return false;
      blocks.push({ subject_id: w.subject_id, title: w.title, date: day.date, _bk: w._bk, _ws: w.start, _we: w.end, _fin: !!w.final, _one: !!w.onePerDay });
      day.count++; day.load++; day.subs.add(w.subject_id);
      return true;
    }
    while (day.slotIdx < day.slots.length) {
      const end = day.slots[day.slotIdx][1];
      if (day.pos + w.chunk <= end) {
        blocks.push({ subject_id: w.subject_id, title: w.title, date: day.date, _we: w.end, start_time: toHM(day.pos), end_time: toHM(day.pos + w.chunk) });
        day.pos += w.chunk + BREAK; day.load += w.chunk; day.count++; day.subs.add(w.subject_id);
        if (day.pos >= end) { day.slotIdx++; day.pos = day.slots[day.slotIdx]?.[0] ?? null; }
        return true;
      }
      day.slotIdx++; day.pos = day.slots[day.slotIdx]?.[0] ?? null;
    }
    return false;
  }
  // 模考／純題目（壓軸）那天，同一科只排這一項——它本來就要花整段時間，
  // 不該再跟習題擠同一天
  const exclusiveOk = (date, w) => {
    const same = blocks.filter(b => b.date === date && b.subject_id === w.subject_id);
    if (!same.length) return true;
    if (w.final) return false;                       // 模考／壓軸獨佔那天的這一科，一天就一場
    if (same.some(b => b._fin)) return false;
    // 純題目（單元練習／歷屆試題）那天，這一科只做純題目、不混範例+例題。
    // 盡量一天一份，真的排不下才允許兩份，絕不到第三份。
    if (w.onePerDay) return same.every(b => b._one) && same.length < ONE_CAP;
    return !same.some(b => b._one);
  };
  const eligible = (w, minDate, maxDate) => {
    const base = days.filter(d => d.date >= w.start && d.date <= w.end
      && (!minDate || d.date >= minDate) && (!maxDate || d.date <= maxDate));
    return base.length ? base : days.filter(d => d.date >= w.start && d.date <= w.end);
  };

  // 平均分配（逐日發放）：以「科目＋日期範圍」分桶，照日期逐天輪流看每一桶，
  // 按速率（項數÷天數）領量。速率≥1 的科目每天都會出現、速率<1 的等距出現，
  // 某天塞不下就之後立刻補回，不會整串往後推、擠在最後面。
  // pace='front' 盡早排完：速率加快（約 6 成天數消化），前面多排、後面留空。
  const front = pace === 'front';
  let bkSeq = 0; // 每次 distribute 遞增，避免不同批（一般/壓軸）同鍵誤連
  // minDate / maxDate 可以是函式（依科目不同）：收到桶的第一個項目，回傳該桶的界線
  function distribute(queue, minDate, maxDate) {
    if (!queue.length) return;
    bkSeq++;
    const capOk = day => timed ? true : (perDay > 0 ? day.count < perDay : true);
    const buckets = [];
    const byKey = {};
    queue.forEach(w => {
      // key 含 onePerDay：範例+例題和單元練習+歷屆就算同日期範圍也要分桶，階段邏輯才會生效
      const key = `${w.subject_id}|${w.start}|${w.end}|${w.onePerDay ? 1 : 0}`;
      if (!byKey[key]) { byKey[key] = { list: [] }; buckets.push(byKey[key]); }
      w._bk = `${bkSeq}|${key}`;                                 // 桶識別：搬移時用來維持桶內順序
      byKey[key].list.push(w);
    });
    for (const b of buckets) {
      const md = typeof minDate === 'function' ? minDate(b.list[0]) : minDate;
      const xd = typeof maxDate === 'function' ? maxDate(b.list[0]) : maxDate;
      b.minDate = md;
      let D = eligible(b.list[0], md, xd);                       // 同桶共用日期範圍
      if (!D.length) {
        // 範圍內完全沒有可排日（範圍設錯、已過期，或全被排除條件蓋掉）：
        // 退回用全部可排日（壓軸仍維持在 minDate 之後），至少排得進去
        D = days.filter(d => !md || d.date >= md);
        if (!D.length) D = days;
      }
      b.dates = new Set(D.map(d => d.date));
      b.rate = b.list.length / D.length;
      // 起手先給半格：不然「項目少的科目」要等 1/速率 天才第一次出現，
      // 造成前幾天科目很少、後面很擠。半格＝把整串往前挪半個間隔，頭尾才對稱。
      b.err = Math.min(0.5, b.rate / 2);
    }
    // 同科的階段（桶）必須「接續」：先做完全部範例+例題，練習/歷屆才開始。
    // 而且由「後往前」保留天數——練習（一天一課）需要 n 天就先保留尾端 n 天，
    // 範例被壓縮時自動加速（一天兩課）讓位，不會讓練習擠到截止日疊在一起。
    const dayIdx = {}; days.forEach((d, i) => { dayIdx[d.date] = i; });
    const phaseBySubj = new Map();
    buckets.forEach(b => {
      const sid = b.list[0].subject_id;
      if (!phaseBySubj.has(sid)) phaseBySubj.set(sid, []);
      phaseBySubj.get(sid).push(b);
    });
    for (const arr of phaseBySubj.values()) {
      if (arr.length < 2) continue;
      const winArr = arr.map(b => [...b.dates].map(dt => dayIdx[dt]).sort((x, y) => x - y));
      // 各階段至少需要的天數：一天一課的＝項數；可加速的（範例+例題）＝項數÷2
      const minNeed = arr.map(b => b.list[0].onePerDay ? b.list.length : Math.ceil(b.list.length / 2));
      // 天數要「照工作量」分給各階段，不能照「最少天數」由後往前硬保留。
      // 之前的做法會讓一天一課的練習佔走整個尾端，範例被壓到剩幾天，
      // 變成一天五、六節擠在一起（前面 8 項、後面 3 項）。
      const counts = arr.map(b => b.list.length);
      const sumC = counts.reduce((a, c) => a + c, 0) || 1;
      const avail = new Set(winArr.flat()).size;                 // 這科所有階段可用的總天數
      const rigid = arr.map(b => !!b.list[0].onePerDay);
      // 純題目（單元練習／歷屆試題）獨佔該科的一整天 → 有幾份就要幾天，先拿滿。
      // 剩下的天數再分給範例+例題，分法是「最小化最擠的那天」：
      // 從各階段 1 天起，每次把下一天給目前每日量最高的階段。
      const rigidNeed = rigid.reduce((a, r, i) => a + (r ? counts[i] : 0), 0);
      const flexIdx = arr.map((_, i) => i).filter(i => !rigid[i]);
      let alloc;
      if (!flexIdx.length) {
        alloc = counts.slice();                                  // 全部都是純題目
      } else if (avail - rigidNeed >= flexIdx.length) {
        // 純題目理想是一天一份；但如果這樣會讓「節」一天超過 SEC_OK 個，
        // 就把純題目壓到一天兩份，省下來的天數全部給節
        //（使用者：「如果真的排不下，就一天兩單元的單元練習/歷屆試題吧」）
        const SEC_OK = 2;
        const build = perDayOne => {
          const a2 = counts.map((c, i) => rigid[i] ? Math.max(1, Math.ceil(c / perDayOne)) : 1);
          let left = avail - a2.reduce((x, y) => x + y, 0);
          while (left > 0) {                                 // 多的天數只給節（純題目給再多也用不完）
            let k = -1, best = -1;
            for (const i of flexIdx) { const r = counts[i] / a2[i]; if (r > best) { best = r; k = i; } }
            if (k < 0) break;
            a2[k]++; left--;
          }
          return a2;
        };
        const secWorst = a2 => Math.max(0, ...flexIdx.map(i => counts[i] / a2[i]));
        alloc = build(1);
        for (let k = 2; k <= ONE_CAP && secWorst(alloc) > SEC_OK; k++) {
          const cand = build(k);
          if (secWorst(cand) < secWorst(alloc)) alloc = cand;
        }
      } else {
        // 連「一天一份」都排不下（範圍太短）。兩種分法各算一次，挑比較好的：
        //   a) 尊重「純題目一天最多兩份」→ 純題目先拿 ceil(份數/2) 天
        //   b) 純平衡（不設純題目上限）
        // 用 (a) 的前提是「節」不會因此爆掉（超過一天 DAY_OK 個就寧可讓純題目多疊），
        // 不然會出現「純題目一天兩份、但節一天 14 個」這種更糟的結果。
        const capDays = counts.map((c, i) => rigid[i] ? c : Infinity);
        const greedy = floors => {
          const a2 = floors.slice();
          let left = avail - a2.reduce((a, c) => a + c, 0);
          if (left < 0) {                                   // 連下限都放不下：等比例縮
            const sum = a2.reduce((a, c) => a + c, 0) || 1;
            return a2.map(v => Math.max(1, Math.round(avail * v / sum)));
          }
          while (left > 0) {
            let k = -1, best = -1;
            for (let i = 0; i < arr.length; i++) {
              if (a2[i] >= capDays[i]) continue;
              const r = counts[i] / a2[i];
              if (r > best) { best = r; k = i; }
            }
            if (k < 0) break;
            a2[k]++; left--;
          }
          return a2;
        };
        const DAY_OK = 6;                                   // 一天最多約 6 項是使用者說過的舒適上限
        const capped = greedy(counts.map((c, i) => rigid[i] ? Math.max(1, Math.ceil(c / ONE_CAP)) : 1));
        const flexWorst = a2 => Math.max(0, ...arr.map((_, i) => rigid[i] ? 0 : counts[i] / a2[i]));
        alloc = flexWorst(capped) <= DAY_OK ? capped : greedy(counts.map(() => 1));
      }
      // 收尾修正：總和超過可用天數就從最大的扣，不足就補給最後一個階段（排到範圍尾端）
      let over = alloc.reduce((a, c) => a + c, 0) - avail;
      while (over > 0) { const i = alloc.indexOf(Math.max(...alloc)); if (alloc[i] <= 1) break; alloc[i]--; over--; }
      if (over < 0) alloc[alloc.length - 1] -= over;
      // 前向切割：每階段只用「上一階段之後」的日子，且只拿自己那份天數
      let prevEndIdx = -1;
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        let ds = winArr[i].filter(j => j > prevEndIdx);
        if (i < arr.length - 1 && alloc[i] < ds.length) ds = ds.slice(0, Math.max(1, alloc[i]));
        if (!ds.length) ds = winArr[i].filter(j => j > prevEndIdx);
        if (!ds.length) ds = winArr[i];
        if (!ds.length) continue;
        // 早點完成：這一階段壓縮到約 6 成天數，下一階段就從壓縮後的結尾接著開始，
        // 中間才不會留下一大段完全沒有這科的空白
        if (front) {
          const need = b.list[0].onePerDay ? b.list.length : Math.ceil(b.list.length / 2);
          const keep = Math.max(need, Math.ceil(ds.length * 0.6), 1);
          if (keep < ds.length) ds = ds.slice(0, keep);
        }
        b.dates = new Set(ds.map(j => days[j].date));
        b.rate = b.list.length / ds.length;
        b.err = Math.min(0.5, b.rate / 2);
        b._fronted = true;
        prevEndIdx = ds[ds.length - 1];
      }
    }
    // 「早點完成」：不是把速率調快（那會變成一天塞 3 課、然後空好幾天），
    // 而是把可用天數縮短到約 6 成——同樣平均鋪，只是整體提早做完。
    if (front) {
      for (const b of buckets) {
        if (b._fronted) continue;                                  // 多階段的已在上面處理
        const ds = [...b.dates].sort();
        if (ds.length < 2) continue;
        const need = b.list[0].onePerDay ? b.list.length : Math.ceil(b.list.length / 2);
        const keep = Math.max(need, Math.ceil(ds.length * 0.6), 1);
        if (keep >= ds.length) continue;
        b.dates = new Set(ds.slice(0, keep));
        b.rate = b.list.length / keep;
        b.err = Math.min(0.5, b.rate / 2);
      }
    }
    // 主輪：逐天、各桶按速率領量 → 各科每天交錯出現，順序保持。
    // 另設「科目總速率閘門」：同科多個桶（如例題桶＋練習桶）共用一個科目額度，
    // 桶自己的額度滿了還要科目額度也滿才能排 → 物理整體約兩天一次就真的兩天一次，
    // 不會兩桶同天一起出手變 2 項、隔天又都沒有。
    const subjErr = {};
    for (const day of days) {
      for (const b of buckets) {
        if (!b.list.length || !b.dates.has(day.date)) continue;
        const sid = b.list[0].subject_id;
        subjErr[sid] = (subjErr[sid] || 0) + b.rate;             // 科目額度＝當天各活躍桶速率之和
      }
      for (const b of buckets) {
        if (!b.list.length || !b.dates.has(day.date)) continue;
        const sid = b.list[0].subject_id;
        b.err += b.rate;
        let putToday = 0;
        while (b.err >= 0.999 && subjErr[sid] >= 0.999 && b.list.length) {
          const w = b.list[0];
          // 練習/歷屆盡量一天一課；課數多於天數時放寬為「速率的進位」（如 16 課 10 天→一天最多 2），均勻消化
          if (w.onePerDay && putToday >= Math.max(1, Math.ceil(b.rate - 1e-9))) break;
          if (capOk(day) && fits(day, w) && exclusiveOk(day.date, w) && put(day, w)) { b.list.shift(); b.err -= 1; subjErr[sid] -= 1; putToday++; b.lastIdx = dayIdx[day.date]; }
          else break;                                            // 今天滿了，額度留著之後補
        }
      }
    }
    // 剩下的（被每日上限/空檔擋住）：照順序找最早塞得下的日子
    // onePerDay（練習/歷屆）補位時也一天一項往後排，不要疊同一天
    for (const b of buckets) {
      // 照順序的桶：補位不可以繞回「已排到的日子」之前，順序才不會亂
      const base = (b.list[0] && b.list[0].spread === false && b.lastIdx != null) ? b.lastIdx + 1 : 0;
      let ci = base;
      for (const w of b.list) {
        let done = false;
        for (let i = ci; i < days.length && !done; i++) {
          if (!b.dates.has(days[i].date)) continue;
          if (fits(days[i], w) && exclusiveOk(days[i].date, w) && put(days[i], w)) { done = true; ci = w.onePerDay ? i + 1 : i; }
        }
        // 排不下時「分層退讓」：先放寬「壓軸獨佔整天」——寧可跟同科習題同一天，
        // 也絕不讓兩場模考擠在同一天（那才是最糟的）。
        // 壓軸從「最後一天往前找」，才不會退讓後反而跑到最前面。
        const noTwoFinals = i => !(w.final && blocks.some(x => x.date === days[i].date && x.subject_id === w.subject_id && x._fin));
        if (!done && w.final) for (let i = days.length - 1; i >= 0 && !done; i--) {
          if (!b.dates.has(days[i].date) || !noTwoFinals(i)) continue;
          if (fits(days[i], w) && put(days[i], w)) done = true;
        }
        if (!done && !w.final) for (let i = Math.max(0, base - 1); i < days.length && !done; i++) {
          if (!b.dates.has(days[i].date)) continue;
          if (w.onePerDay && !exclusiveOk(days[i].date, w)) continue;   // 純題目仍維持一天一份
          if (fits(days[i], w) && put(days[i], w)) done = true;
        }
        // 純題目補位：不限桶內日期，但還是不跟同科的另一份純題目同日
        if (!done && !w.final && w.onePerDay) for (let i = 0; i < days.length && !done; i++) {
          if (days[i].date < w.start || days[i].date > w.end) continue;   // 不可跑到自己的區段之前
          if (!exclusiveOk(days[i].date, w)) continue;
          if (fits(days[i], w) && put(days[i], w)) done = true;
        }
        // 壓軸還是排不下：不限原範圍，從最後一天往前找「該科還沒有壓軸」的日子
        if (!done && w.final) for (let i = days.length - 1; i >= 0 && !done; i--) {
          if (!noTwoFinals(i)) continue;
          if (fits(days[i], w) && put(days[i], w)) done = true;
        }
        // 真的沒地方了就完全放寬（不再限桶內日期、不限每日量）——寧可某天多一項，
        // 也絕不讓項目「排不進去」。但要挑「最不擠」的日子，不能從第一天開始硬塞：
        // 不然 18 份單元練習會整疊堆在第一天（範圍太短時就會走到這一步）。
        // 順序不用擔心：同桶的日期在下面會重新排序後照原順序配回去。
        if (!done) {
          const sc = (date, sid) => blocks.reduce((a, x) => a + (x.date === date && x.subject_id === sid ? 1 : 0), 0);
          const pick = (ownWindow, keepExcl) => {
            const pool = days.map((d, i) => ({ d, i }))
              // 使用者設的截止日是硬規則：先只在這個項目自己的日期範圍內找，
              // 不然「生物排到 9/5」這種事就會發生（那幾天只有物理能用、剛好最空）
              .filter(({ d }) => (!ownWindow || (d.date >= w.start && d.date <= w.end))
                // 也要守「純題目／模考獨佔該科那天」：少了這一關，只要有一份歷屆
                // 走到最後補位，就會被塞到已經有歷屆的日子旁邊
                && (!keepExcl || exclusiveOk(d.date, w))
                && fits(d, w));
            pool.sort((A, C) =>
              sc(A.d.date, w.subject_id) - sc(C.d.date, w.subject_id)   // 先挑該科最少的那天
              || A.d.count - C.d.count                                  // 再挑總量最少的
              || (w.final ? C.i - A.i : A.i - C.i));                    // 壓軸偏後、一般偏前
            for (const { d } of pool) { if (put(d, w)) return true; }
            return false;
          };
          // 優先順序：範圍內且不破獨佔 → 範圍內（截止日是硬規則）→ 放寬範圍但不破獨佔 → 全放寬
          done = pick(true, true) || pick(true, false) || pick(false, true) || pick(false, false);
        }
        if (!done) failed.push(`${w.title}〔${w.start}～${w.end}〕`); // 附上範圍，方便看出是哪段日期塞不下
      }
    }
    // 同一桶（同科同階段）內：日期排序後照「原本的順序」配回去。
    // 補位/退讓時可能從後往前找日子，會讓模考2 跑到模考1 前面——這裡統一校正，
    // 保證第1次、第2次、第3次模考的先後正確（日期集合不變，其他規則不受影響）。
    for (const b of buckets) {
      const mates = blocks.filter(x => x._bk === b._bk);
      if (mates.length < 2) continue;
      const ds = mates.map(m => m.date).sort();
      mates.forEach((m, i) => { m.date = ds[i]; });
    }
  }

  // 壓軸（模考、學測實驗必考重點等）「排在該科所有一般項目之後」——分科計算：
  // 生物的模考只要等生物的練習/歷屆做完，不用等其他科。這樣壓軸可以從該科
  // 內容結束後就開始平均鋪開（該科每天都會出現），不會全部擠在最後幾天。
  // 先按「該科壓軸÷該科總項數」的比例，幫每科的壓軸保留尾端日子。
  const cntBy = (arr) => arr.reduce((m, w) => (m[w.subject_id] = (m[w.subject_id] || 0) + 1, m), {});
  const finalsBySub = cntBy(finals);
  const normalsBySub = cntBy([...firstsQ, ...work]);
  const normalMaxBySub = {};
  {
    // 保留天數要用「該科自己的可排日」來算，不能用全部日子：
    // 生物只到 8/30、但整體到 9/5 時，用全部日子算出來的保留區會落在 9/1 之後，
    // 等於在生物的範圍內完全沒保留 → 模考只好硬塞進 8/30 之前，
    // 把練習/歷屆擠成兩份同日。
    const winBySub = {};
    for (const w of [...firstsQ, ...work, ...finals]) {
      const v = winBySub[w.subject_id] || (winBySub[w.subject_id] = { s: w.start, e: w.end });
      if (w.start < v.s) v.s = w.start;
      if (w.end > v.e) v.e = w.end;
    }
    for (const sid of Object.keys(finalsBySub)) {
      const F = finalsBySub[sid], W = normalsBySub[sid] || 0;
      if (!W) continue;
      const v = winBySub[sid];
      const own = days.filter(d => !v || (d.date >= v.s && d.date <= v.e));
      if (own.length < 2) continue;
      // 壓軸（模考等）每一場都要獨佔該科的一整天 → 有幾場就要保留幾天
      const nF = Math.max(1, Math.min(F, own.length - 1));
      normalMaxBySub[sid] = own[own.length - nF - 1].date;
    }
  }
  const normalMaxFor = w => normalMaxBySub[w.subject_id] ?? null;
  distribute(firstsQ, null, normalMaxFor);   // 先完成的最先排
  distribute(work, null, normalMaxFor);      // 一般項目：平均分配、照章節順序（讓出該科尾端）
  const lastNormalBySub = {};
  blocks.forEach(b => { if (!lastNormalBySub[b.subject_id] || b.date > lastNormalBySub[b.subject_id]) lastNormalBySub[b.subject_id] = b.date; });
  distribute(finals, w => {
    const ln = lastNormalBySub[w.subject_id];
    if (!ln) return null;                    // 這科只有壓軸：全範圍平均排
    const after = days.find(d => d.date > ln);
    return after ? after.date : ln;          // 該科一般項目最後一天的隔天以後
  });

  // ===== 產出前自我檢查 =====
  // 搬移時也要守「模考那天該科只有它」：目標日不能已有該科的壓軸，
  // 壓軸自己也只能搬到該科完全沒排的日子
  const canPlaceOn = (b, date) => {
    const same = blocks.filter(x => x !== b && x.date === date && x.subject_id === b.subject_id);
    if (!same.length) return true;
    if (b._fin) return false;                        // 模考獨佔該科的那一天
    if (same.some(x => x._fin)) return false;
    if (b._one) return same.every(x => x._one) && same.length < ONE_CAP;
    return !same.some(x => x._one);
  };
  // 1) 平衡每日量（不計時模式）：超量日的項目搬到未滿日。
  //    可搬條件：目標日在該項目的日期範圍內、且介於同桶前後項的日期之間（順序不破）。
  if (!timed && blocks.length && days.length > 1) {
    const cap = Math.ceil(blocks.length / days.length);
    const cnt = {}; days.forEach(d => { cnt[d.date] = 0; }); blocks.forEach(b => cnt[b.date]++);
    // 科目層級界線：壓軸不可搬到該科一般項目（含當天）之前；一般項目不可搬到該科壓軸（含當天）之後
    const maxNormal = {}, minFinal = {};
    blocks.forEach(b => {
      if (b._fin) { if (!minFinal[b.subject_id] || b.date < minFinal[b.subject_id]) minFinal[b.subject_id] = b.date; }
      else { if (!maxNormal[b.subject_id] || b.date > maxNormal[b.subject_id]) maxNormal[b.subject_id] = b.date; }
    });
    // 同科同日數：搬移不可以把同一科堆到同一天（總量平衡了、科目卻擠在一起）
    const sCnt = (date, sid) => blocks.reduce((a, x) => a + (x.date === date && x.subject_id === sid ? 1 : 0), 0);
    const idxOf = {}; days.forEach((d, i) => { idxOf[d.date] = i; });
    for (let pass = 0; pass < 3; pass++) {
      let movedAny = false;
      for (const b of blocks) {
        if (cnt[b.date] <= cap) continue;
        const mates = blocks.filter(x => x._bk === b._bk);
        const i = mates.indexOf(b);
        const lo = i > 0 ? mates[i - 1].date : null;
        const hi = i < mates.length - 1 ? mates[i + 1].date : null;
        // 跨階段護欄：不可越過同科其他桶（別的題型階段、壓軸）的日期
        const others = blocks.filter(x => x.subject_id === b.subject_id && x._bk !== b._bk);
        const nextOther = others.filter(x => x.date > b.date).reduce((a, x) => (!a || x.date < a) ? x.date : a, null);
        const prevOther = others.filter(x => x.date < b.date).reduce((a, x) => (!a || x.date > a) ? x.date : a, null);
        // 只能搬到同桶前後項「之間」（不含同日，維持等距），且從離原日最近的開始挑，不會整串往前擠
        const cands = days.filter(d => d.date !== b.date
          && canPlaceOn(b, d.date)                                 // 模考那天該科只有它
          && cnt[d.date] < cap && cnt[d.date] <= cnt[b.date] - 2   // 未達上限且搬了有實質改善
          && sCnt(d.date, b.subject_id) < sCnt(b.date, b.subject_id) // 這科在目標日要比原日少，不能越搬越擠
          && d.date >= b._ws && d.date <= b._we
          && (!lo || d.date > lo) && (!hi || d.date < hi)
          && (!nextOther || d.date < nextOther) && (!prevOther || d.date > prevOther)
          && (b._fin ? (!maxNormal[b.subject_id] || d.date > maxNormal[b.subject_id])
                     : (!minFinal[b.subject_id] || d.date < minFinal[b.subject_id]))
          && d.slots.length);
        const target = cands.sort((a, c) => Math.abs(idxOf[a.date] - idxOf[b.date]) - Math.abs(idxOf[c.date] - idxOf[b.date]))[0];
        if (target) { cnt[b.date]--; cnt[target.date]++; b.date = target.date; movedAny = true; }
      }
      if (!movedAny) break;
    }
    // 同科一天 2 項時，把多的那項搬到附近「完全沒有這科」的日子——
    // 一律待在使用者設定的日期範圍內（結束日是硬截止，一天也不能超），
    // 也絕不越過該科下一階段（如練習）或壓軸的日期。
    for (let pass = 0; pass < 3; pass++) {
      let movedAny = false;
      for (const b of blocks) {
        if (sCnt(b.date, b.subject_id) < 2) continue;
        const mates = blocks.filter(x => x._bk === b._bk);
        const i = mates.indexOf(b);
        const lo = i > 0 ? mates[i - 1].date : null;
        const hi = i < mates.length - 1 ? mates[i + 1].date : null;
        // 同科其他桶（別的題型階段、壓軸）最近的前後日期：搬移不可越界
        const others = blocks.filter(x => x.subject_id === b.subject_id && x._bk !== b._bk);
        const nextOther = others.filter(x => x.date > b.date).reduce((a, x) => (!a || x.date < a) ? x.date : a, null);
        const prevOther = others.filter(x => x.date < b.date).reduce((a, x) => (!a || x.date > a) ? x.date : a, null);
        const cands = days.filter(d => d.date !== b.date
          && canPlaceOn(b, d.date)                                // 模考那天該科只有它
          && sCnt(d.date, b.subject_id) === 0                     // 目標日完全沒這科
          && cnt[d.date] <= cap
          && d.date >= b._ws && d.date <= b._we                   // 不可超出使用者設定的範圍
          && (!lo || d.date > lo) && (!hi || d.date < hi)
          && (!nextOther || d.date < nextOther) && (!prevOther || d.date > prevOther)
          && Math.abs(idxOf[d.date] - idxOf[b.date]) <= 7         // 就近，最多 7 天
          && d.slots.length);
        const target = cands.sort((a, c) => Math.abs(idxOf[a.date] - idxOf[b.date]) - Math.abs(idxOf[c.date] - idxOf[b.date]))[0];
        if (target) { cnt[b.date]--; cnt[target.date]++; b.date = target.date; movedAny = true; }
      }
      if (!movedAny) break;
    }
  }
  // 2) 各科空窗檢查＋自動修補：在該科「第一次～最後一次」的期間內，出現間隔若明顯
  //    大於預期（期間÷次數），自動把該科空窗後的下一個項目搬進空窗補平。
  //    用 Map 保留 subject_id 原始型別（Object key 會變字串，前端就對不到科目名）。
  const subjExp = new Map(); // 各科預期間隔在第一次計算後凍結，避免「越補越密」的惡性循環
  const calcGaps = () => {
    const out = [];
    const bySub = new Map();
    blocks.forEach(b => { if (!bySub.has(b.subject_id)) bySub.set(b.subject_id, []); bySub.get(b.subject_id).push(b.date); });
    for (const [sid, ds0] of bySub) {
      const ds = [...new Set(ds0)].sort();
      if (ds.length < 2) continue;
      const span = days.filter(d => d.date >= ds[0] && d.date <= ds[ds.length - 1]).length;
      if (!subjExp.has(sid)) subjExp.set(sid, Math.max(1, Math.ceil(span / ds.length)));
      const expGap = subjExp.get(sid);
      for (let i = 1; i < ds.length; i++) {
        const between = days.filter(d => d.date > ds[i - 1] && d.date < ds[i]);
        // 天天出現的科目（預期間隔1）少一天就算空窗；低頻科目容忍 +1
        if (between.length + 1 > expGap + (expGap > 1 ? 1 : 0)) out.push({ sid, to: ds[i], between, expGap, gap: between.length + 1 });
      }
    }
    return out;
  };
  if (!timed && blocks.length && days.length > 1) {
    const cap = Math.ceil(blocks.length / days.length);
    const cnt = {}; days.forEach(d => { cnt[d.date] = 0; }); blocks.forEach(b => cnt[b.date]++);
    const maxNormal = {};
    blocks.forEach(b => { if (!b._fin && (!maxNormal[b.subject_id] || b.date > maxNormal[b.subject_id])) maxNormal[b.subject_id] = b.date; });
    const sCnt2 = (date, sid) => blocks.reduce((a, x) => a + (x.date === date && x.subject_id === sid ? 1 : 0), 0);
    for (let pass = 0; pass < 10; pass++) {
      const gaps = calcGaps();
      if (!gaps.length) break;
      let changed = false;
      for (const g of gaps) {
        // 只從「當天有 2 項以上這科」的日子借來填洞——搬走後那天還有這科，
        // 不會挖出新洞、也不會連鎖把整串往前拉
        const donors = blocks
          .filter(x => x.subject_id === g.sid && x.date >= g.to && sCnt2(x.date, g.sid) >= 2)
          .sort((a, b2) => a.date.localeCompare(b2.date));
        let moved = false;
        for (const b of donors) {
          const mates = blocks.filter(x => x._bk === b._bk);
          const i = mates.indexOf(b);
          const lo = i > 0 ? mates[i - 1].date : null;               // 往前搬不能超過同桶前一項
          const others = blocks.filter(x => x.subject_id === b.subject_id && x._bk !== b._bk);
          const prevOther = others.filter(x => x.date < b.date).reduce((a, x) => (!a || x.date > a) ? x.date : a, null);
          const target = g.between.find(d => cnt[d.date] <= cap
            && canPlaceOn(b, d.date)
            && d.date >= b._ws && d.date <= b._we && (!lo || d.date > lo)
            && (!prevOther || d.date > prevOther)                    // 不可越到同科前一階段裡面
            && (!b._fin || !maxNormal[b.subject_id] || d.date > maxNormal[b.subject_id]) // 壓軸仍在該科之後
            && d.slots.length);
          if (target) { cnt[b.date]--; cnt[target.date]++; b.date = target.date; moved = changed = true; break; }
        }
      }
      if (!changed) break;
    }
  }
  // 3) 全域負載平衡：把「很擠的日子」的項目搬到「很空的日子」，讓每天的量接近。
  //    關鍵手法：搬完後把同一桶的日期重新排序、照原順序配回去 → 課本順序自動維持，
  //    所以不需要「只能在前後鄰居之間移動」那種綁手綁腳的限制，才拉得動整串。
  if (!timed && blocks.length && days.length > 1) {
    const idxOf = {}; days.forEach((d, i) => { idxOf[d.date] = i; });
    const cap = Math.ceil(blocks.length / days.length);          // 每日目標上限
    const maxNormal = {}, minFinal = {};
    blocks.forEach(b => {
      if (!b._fin && (!maxNormal[b.subject_id] || b.date > maxNormal[b.subject_id])) maxNormal[b.subject_id] = b.date;
      if (b._fin && (!minFinal[b.subject_id] || b.date < minFinal[b.subject_id])) minFinal[b.subject_id] = b.date;
    });
    for (let pass = 0; pass < 12; pass++) {
      const cnt = {}; days.forEach(d => { cnt[d.date] = 0; }); blocks.forEach(b => cnt[b.date]++);
      const sCnt = (date, sid) => blocks.reduce((a, x) => a + (x.date === date && x.subject_id === sid ? 1 : 0), 0);
      // 從「最空的日子」開始，把量多的日子的項目拉過來（雙向平衡；
      // 只看超載日的話，第一天只有 2 項這種情況永遠補不到）
      // 目標拉到 cap（無條件進位的每日均量），不是只補到 floorCap——
      // 只補到 floorCap 的話，「6,6,6,5,5,5」這種還差一項的日子永遠補不滿，
      // 前面就會一直維持 7 項
      const light = days.filter(d => cnt[d.date] < cap && d.slots.length)
        .sort((a, b) => cnt[a.date] - cnt[b.date]);
      if (!light.length) break;
      let moved = false;
      for (const E of light) {
        while (cnt[E.date] < cap) {
          // 可以搬到 E 的候選項目：所在日子比 E 多至少 2 項，且不違反範圍與階段順序
          const cand = blocks.filter(b => cnt[b.date] > cnt[E.date] + 1
            && E.date >= b._ws && E.date <= b._we
            // 目標日這科不能比來源日多。允許「一樣多」很關鍵：
            // 有一科被前段塞滿（範例壓縮）時，其他天天一課的科目要能往後段挪，
            // 才填得平尾端那幾天，不然總量就會前面 7、8 項後面 3、4 項
            && (b._one ? sCnt(E.date, b.subject_id) === 0
                       : sCnt(E.date, b.subject_id) <= sCnt(b.date, b.subject_id))
            && canPlaceOn(b, E.date)
            && (b._fin ? (!maxNormal[b.subject_id] || E.date > maxNormal[b.subject_id])
                       : (!minFinal[b.subject_id] || E.date < minFinal[b.subject_id]))
            && (() => {
              const others = blocks.filter(x => x.subject_id === b.subject_id && x._bk !== b._bk);
              const nextOther = others.filter(x => x.date > b.date).reduce((a, x) => (!a || x.date < a) ? x.date : a, null);
              const prevOther = others.filter(x => x.date < b.date).reduce((a, x) => (!a || x.date > a) ? x.date : a, null);
              return (!nextOther || E.date < nextOther) && (!prevOther || E.date > prevOther);
            })())
            .sort((x, y) => cnt[y.date] - cnt[x.date]                         // 先搬最擠那天的
              || Math.abs(idxOf[x.date] - idxOf[E.date]) - Math.abs(idxOf[y.date] - idxOf[E.date]));
          const b = cand[0];
          if (!b) break;
          const mates = blocks.filter(x => x._bk === b._bk);                  // 同桶＝同科同階段
          cnt[b.date]--; cnt[E.date]++; b.date = E.date;
          const ds = mates.map(m => m.date).sort();                           // 重新照日期順序配給同桶項目
          mates.forEach((m, i) => { m.date = ds[i]; });                       // → 課本順序自動維持
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  // 4) 各科自己也要平均：同一天塞 2、3 課、隔幾天又完全沒有 → 把多的那課搬到
  //    該科「當天沒有」的日子（限自己的日期範圍與階段順序內）。搬完一樣重排同桶日期，
  //    所以課本順序不會亂。這是「各科平均」的最後一道保險。
  if (!timed && blocks.length && days.length > 1) {
    const idxOf = {}; days.forEach((d, i) => { idxOf[d.date] = i; });
    const cap = Math.ceil(blocks.length / days.length);
    const maxNormal = {}, minFinal = {};
    blocks.forEach(b => {
      if (!b._fin && (!maxNormal[b.subject_id] || b.date > maxNormal[b.subject_id])) maxNormal[b.subject_id] = b.date;
      if (b._fin && (!minFinal[b.subject_id] || b.date < minFinal[b.subject_id])) minFinal[b.subject_id] = b.date;
    });
    for (let pass = 0; pass < 10; pass++) {
      const cnt = {}; days.forEach(d => { cnt[d.date] = 0; }); blocks.forEach(b => cnt[b.date]++);
      const sCnt = (date, sid) => blocks.reduce((a, x) => a + (x.date === date && x.subject_id === sid ? 1 : 0), 0);
      let moved = false;
      // 同一天有 2 課以上的科目，從最擠的開始處理
      const crowded = blocks.filter(b => sCnt(b.date, b.subject_id) >= 2)
        .sort((a, b) => sCnt(b.date, b.subject_id) - sCnt(a.date, a.subject_id));
      for (const b of crowded) {
        if (sCnt(b.date, b.subject_id) < 2) continue;
        const others = blocks.filter(x => x.subject_id === b.subject_id && x._bk !== b._bk);
        const nextOther = others.filter(x => x.date > b.date).reduce((a, x) => (!a || x.date < a) ? x.date : a, null);
        const prevOther = others.filter(x => x.date < b.date).reduce((a, x) => (!a || x.date > a) ? x.date : a, null);
        const target = days.filter(E => E.date !== b.date
          && sCnt(E.date, b.subject_id) === 0                       // 該科當天完全沒有
          && canPlaceOn(b, E.date)
          && cnt[E.date] < cnt[b.date]                              // 也不能把別天弄更擠
          && cnt[E.date] <= cap
          && E.date >= b._ws && E.date <= b._we                     // 不可超出使用者範圍
          && (!nextOther || E.date < nextOther) && (!prevOther || E.date > prevOther)
          && (b._fin ? (!maxNormal[b.subject_id] || E.date > maxNormal[b.subject_id])
                     : (!minFinal[b.subject_id] || E.date < minFinal[b.subject_id]))
          && E.slots.length)
          .sort((x, y) => Math.abs(idxOf[x.date] - idxOf[b.date]) - Math.abs(idxOf[y.date] - idxOf[b.date]))[0];
        if (!target) continue;
        const mates = blocks.filter(x => x._bk === b._bk);
        cnt[b.date]--; cnt[target.date]++; b.date = target.date;
        const ds = mates.map(m => m.date).sort();
        mates.forEach((m, i) => { m.date = ds[i]; });               // 重排 → 課本順序維持
        moved = true;
      }
      if (!moved) break;
    }
  }
  // 5) 最終順序校正：所有搬移都跑完後，把每一桶（同科同階段）的日期由小到大
  //    重新配給「原本順序」的項目。這樣不管中間怎麼搬，第1次→第2次→第3次模考、
  //    課本章節的先後一定正確（只是換日期對應，不影響每日量與其他規則）。
  {
    const byBk = new Map();
    blocks.forEach(b => { if (b._bk) { if (!byBk.has(b._bk)) byBk.set(b._bk, []); byBk.get(b._bk).push(b); } });
    for (const mates of byBk.values()) {
      if (mates.length < 2) continue;
      const ds = mates.map(m => m.date).sort();
      mates.forEach((m, i) => { m.date = ds[i]; });
    }
  }
  // 6) 獨佔規則的最後保險：模考／壓軸那天，同一科只能有它。
  //    前面各種搬移＋同桶重排有可能把別的項目挪進模考那天，這裡最後再清一次：
  //    把同日同科的非壓軸項目搬到最近一個「沒有該科壓軸」的日子（一樣不出範圍、不亂順序）。
  if (!timed && blocks.length && days.length > 1) {
    const idxOf = {}; days.forEach((d, i) => { idxOf[d.date] = i; });
    const cap = Math.ceil(blocks.length / days.length) + 1;
    const finKey = new Set(blocks.filter(b => b._fin).map(b => `${b.date}|${b.subject_id}`));
    if (finKey.size) {
      const cnt = {}; days.forEach(d => { cnt[d.date] = 0; }); blocks.forEach(b => cnt[b.date]++);
      const sCnt = (date, sid) => blocks.reduce((a, x) => a + (x.date === date && x.subject_id === sid ? 1 : 0), 0);
      for (const b of blocks) {
        if (b._fin || !finKey.has(`${b.date}|${b.subject_id}`)) continue;
        const mates = blocks.filter(x => x._bk === b._bk);
        const pick = loose => days.filter(d => d.date !== b.date && d.slots.length
          && d.date >= b._ws && d.date <= b._we
          && !finKey.has(`${d.date}|${b.subject_id}`)                 // 目標日沒有該科壓軸
          && (loose || !(b._one && sCnt(d.date, b.subject_id) > 0))   // 一天一課的先試不疊
          && cnt[d.date] <= cap)
          .sort((x, y) => Math.abs(idxOf[x.date] - idxOf[b.date]) - Math.abs(idxOf[y.date] - idxOf[b.date]))[0];
        // 找不到完全不疊的日子時退讓：寧可某天多一份練習，也不要佔用模考當天
        const target = pick(false) || pick(true);
        if (!target) continue;
        cnt[b.date]--; cnt[target.date]++; b.date = target.date;
        const ds = mates.map(m => m.date).sort();                     // 重排維持課本／場次順序
        mates.forEach((m, i) => { m.date = ds[i]; });
      }
    }
  }
  // 修補後還剩的空窗＝使用者自訂日期範圍造成（不能擅自違反），僅回報說明
  const checkWarnings = calcGaps().reduce((acc, g) => {
    const ex = acc.find(x => x.subject_id === g.sid);
    if (ex) { if (g.gap > ex.maxGap) ex.maxGap = g.gap; }
    else acc.push({ subject_id: g.sid, maxGap: g.gap, expGap: g.expGap });
    return acc;
  }, []);
  const dayCounts = {};
  blocks.forEach(b => { dayCounts[b.date] = (dayCounts[b.date] || 0) + 1; });
  const cs = Object.values(dayCounts);
  // 每科實際排到的期間，讓使用者看得出「某科很快排完」是因為它的日期範圍較短
  const subjSpan = [];
  {
    const m = new Map();
    blocks.forEach(b => {
      const s = m.get(b.subject_id) || {
        subject_id: b.subject_id, first: b.date, last: b.date, count: 0,
        one: 0, sec: 0, oneDays: new Set(), secDays: new Set(), secPer: {},
      };
      if (b.date < s.first) s.first = b.date;
      if (b.date > s.last) s.last = b.date;
      s.count++;
      // 讓使用者看得到公式：可用天數 －（純題目份數）＝ 節可用的天數
      if (b._one) { s.one++; s.oneDays.add(b.date); }
      else { s.sec++; s.secDays.add(b.date); s.secPer[b.date] = (s.secPer[b.date] || 0) + 1; }
      m.set(b.subject_id, s);
    });
    // 該科自己的可排日數（用它所有項目的最早開始～最晚截止算）
    const availBySub = {};
    for (const w of [...firstsQ, ...work, ...finals]) {
      const v = availBySub[w.subject_id] || (availBySub[w.subject_id] = { s: w.start, e: w.end });
      if (w.start < v.s) v.s = w.start;
      if (w.end > v.e) v.e = w.end;
    }
    for (const s of m.values()) {
      const per = Object.values(s.secPer);
      const v = availBySub[s.subject_id];
      const availDays = v ? days.filter(d => d.date >= v.s && d.date <= v.e).length : days.length;
      subjSpan.push({
        subject_id: s.subject_id, first: s.first, last: s.last, count: s.count,
        one: s.one, oneDays: s.oneDays.size,
        sec: s.sec, secDays: s.secDays.size,
        secMin: per.length ? Math.min(...per) : 0,
        secMax: per.length ? Math.max(...per) : 0,
        totalDays: days.length,
        availDays,
        // 要讓「節」降到一天 2 個，這科總共需要幾天（純題目一天一份＋節一天兩個）
        wantDays: s.one + Math.ceil(s.sec / 2),
      });
    }
  }
  // 範圍太短的提醒：某科一天要排 3 項以上時，算出「照一天一課／一天兩節的節奏
  // 至少需要幾天」，讓使用者自己決定要不要把結束日往後延
  const tight = [];
  {
    const m = new Map();
    blocks.forEach(b => {
      const s = m.get(b.subject_id) || { subject_id: b.subject_id, one: 0, flex: 0, days: new Set(), perDay: {}, onePer: {} };
      if (b._one) { s.one++; s.onePer[b.date] = (s.onePer[b.date] || 0) + 1; } else s.flex++;
      s.days.add(b.date);
      s.perDay[b.date] = (s.perDay[b.date] || 0) + 1;
      m.set(b.subject_id, s);
    });
    for (const s of m.values()) {
      const mx = Math.max(...Object.values(s.perDay));
      const total = s.one + s.flex;
      const avg = total / (s.days.size || 1);
      // 純題目獨佔該科一整天 → 份數就是最少需要的天數
      const need = Math.max(s.one, Math.ceil(total / 3));
      const oneMax = Math.max(0, ...Object.values(s.onePer));
      // 只要有純題目被迫兩份同日，就一定是天數不夠——這是最明確的訊號，
      // 不要再拿「該科總天數」去判斷（各題型組可以有自己的日期範圍，
      // 用整科天數看的話會漏掉「歷屆組只有 17 天卻有 19 份」這種情況）
      if (oneMax > ONE_CAP || (need > s.days.size && mx >= 5 && mx > avg * 2)) {
        tight.push({ subject_id: s.subject_id, maxPerDay: mx, needDays: need, haveDays: s.days.size, oneCount: s.one, oneMax });
      }
    }
  }
  const check = {
    tight,
    dailyMin: cs.length ? Math.min(...cs) : 0,
    dailyMax: cs.length ? Math.max(...cs) : 0,
    warnings: checkWarnings,
    subjects: subjSpan,
  };

  // 每個項目自己的截止日：內部欄位清掉之前，先留一份公開的給前端
  // （Phase 2A 的 tasks.deadline_date 要用。純輸出欄位，不影響排程語意）
  blocks.forEach(b => { b.deadline = b._we || null; delete b._bk; delete b._ws; delete b._we; delete b._one; });
  blocks.sort((a, b) => a.date === b.date ? (a.start_time || '').localeCompare(b.start_time || '') : a.date.localeCompare(b.date));
  res.json({
    blocks, check, unplaced: failed.length > 0,
    message: failed.length ? `空檔不足，排不進去：${[...new Set(failed)].slice(0, 5).join('、')}${failed.length > 5 ? '…' : ''}（請延長日期或減少內容）` : undefined,
  });
});

/* ============================================================
   Phase 2C-P1：排程持久化的讀取端
   ------------------------------------------------------------
   全部 user scoped。別人的 version 一律 404——不是 403，
   403 等於承認「這個 id 存在」。
   寫入一律經過 schedule/persistence.js，routes 不自己拼 SQL。
   ============================================================ */

// 目前生效的排程。active_version_id 為 NULL 時回 active:false，
// 呼叫端據此走 legacy（due_date）路徑——這是過渡期的正式判斷依據。
router.get('/active', async (req, res) => {
  res.json(await sched.getActiveSchedule(req.userId));
});

// 版本列表（只有 metadata，不含 blocks）
router.get('/versions', async (req, res) => {
  res.json(await sched.listVersions(req.userId));
});

// 單一版本 ＋ 它的 blocks
router.get('/versions/:id', async (req, res) => {
  const r = await sched.getVersionWithBlocks(req.userId, Number(req.params.id));
  if (!r) return res.status(404).json({ error: '找不到這個版本' });
  res.json(r);
});

// Restore preview：舊版只是一份 template；結果以「現在」的 Task／期限／固定行程
// 重新判斷。UI 必須把 base_version_id 原樣送回 POST，避免過期 preview 覆蓋新排程。
router.get('/versions/:id/restore-preview', async (req, res) => {
  const preview = await sched.getRestorePreview(req.userId, Number(req.params.id));
  if (!preview) return res.status(404).json({ error: '找不到這個版本' });
  res.json(preview);
});

// Restore 永遠建立新的 immutable ScheduleVersion，絕不把舊 row 重新設 active。
router.post('/versions/:id/restore', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await sched.applyRestore(req.userId, Number(req.params.id), {
      baseVersionId: b.base_version_id,
      confirmPartial: b.confirm_partial === true,
    }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Wizard 建立與 AI 重排的正式寫入點。Task 的內容異動、軟刪除、版本、
// active pointer 與 due mirror 都由 persistence service 包進同一筆交易；
// route 不得直接寫 tasks.due_date / due_time。
router.post('/apply', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await sched.applySchedule(req.userId, {
      planId: b.plan_id,
      source: b.source,
      reason: b.reason || '',
      effectiveFrom: b.effective_from || null,
      taskUpdates: b.task_updates || [],
      taskCreates: b.task_creates || [],
      taskDeleteIds: b.task_delete_ids || [],
      blocks: b.blocks || [],
    }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 第一次進入 2C persistence：把既有排定日期收成 V1。
// 已經有 active version 就直接回傳，不會重複建立。
router.post('/bootstrap', async (req, res) => {
  try {
    res.json(await sched.bootstrapScheduleIfNeeded(req.userId, todayTW()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
