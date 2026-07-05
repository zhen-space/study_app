// 解析 .ics 行事曆檔 → [{title, date, start_time, end_time, recurring}]
export function parseICS(text) {
  // 續行（開頭是空白）併回上一行
  const lines = text.replace(/\r/g, '').split('\n').reduce((acc, l) => {
    if (/^[ \t]/.test(l) && acc.length) acc[acc.length - 1] += l.slice(1);
    else acc.push(l);
    return acc;
  }, []);

  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [keyPart, value] = [line.slice(0, idx), line.slice(idx + 1)];
    const key = keyPart.split(';')[0];
    if (key === 'SUMMARY') cur.title = value.replace(/\\,/g, ',').replace(/\\n/g, ' ');
    else if (key === 'DTSTART') cur.start = { raw: value, allDay: keyPart.includes('VALUE=DATE') || !value.includes('T') };
    else if (key === 'DTEND') cur.end = { raw: value };
    else if (key === 'RRULE') cur.rrule = value;
  }

  const parseDT = raw => {
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
    if (!m) return null;
    const [, y, mo, d, h = '00', mi = '00', , z] = m;
    if (z) { // UTC → 本地時間
      const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
      return { date: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
        time: `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` };
    }
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  };

  const out = [];
  for (const e of events) {
    if (!e.title || !e.start || e.start.allDay) continue; // 全天事件不佔時段，略過
    const s = parseDT(e.start.raw);
    const en = e.end ? parseDT(e.end.raw) : null;
    if (!s) continue;
    out.push({
      title: e.title,
      date: s.date,
      start_time: s.time,
      end_time: en && en.date === s.date ? en.time : '23:59',
      recurring: /FREQ=WEEKLY/.test(e.rrule || '') ? 'weekly' : null,
    });
  }
  return out;
}
