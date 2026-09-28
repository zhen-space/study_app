import { useEffect, useMemo, useState, useCallback } from 'react';
import { api } from '../api';
import { listShelf, getBookTree, flattenItems } from './material';
import { buildSchedulePreviewRequest } from './schedulePreview';
import { today } from './helpers';
import { md } from './plans';
import AddMaterialFlow from './AddMaterialFlow';
import { Button, IconButton, PageHeader, SurfaceCard, EmptyState, BottomSheet } from './ui';
import Icon from './Icons';

// 建立段考：不中斷的三步流程。核心資料完整、使用者在最後一步確認之前，
// **完全不建立任何 Plan**（沒有空 Plan、不會把人丟到空白 Plan Detail）。
//   Step 1 這次考試：名稱、起訖、加入科目、逐科考試日（預設沿用最後一天，可改）。
//   Step 2 每科考什麼：每科一張卡片，選多本教材＋確切課/章/單元；教材庫沒有的
//           老師指定範圍是 first-class scope（不是 Task）；可當場匯入新教材回到卡片。
//   Step 3 希望怎麼安排：三選一（只分段/每天/具體時段）＋完整預覽，確認後才 atomic 建立。
//
// 草稿存 localStorage，返回/取消/重開都能接續；375px 手機優先、繁中。

const DRAFT_KEY = 'examWizardDraft:v1';
const STEPS = ['這次考試', '每科考什麼', '希望怎麼安排'];
const LEVELS = [
  ['progress', '只告訴我每個日期前要讀完什麼', '各科在考試日前把範圍讀完，不排每天做什麼'],
  ['daily', '幫我排出每天要完成什麼', '列出每天要讀哪些內容，但不指定幾點'],
  ['timed', '幫我排到每天的具體時間', '依你的可用時間與行事曆，排到幾點到幾點'],
];

const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } };
const saveDraft = d => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode */ } };
const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ } };

export default function ExamCreateWizard({ lists = [], onDone, onCancel }) {
  const restored = loadDraft();
  const [step, setStep] = useState(restored?.step ?? 0);
  const [name, setName] = useState(restored?.name ?? '');
  const [start, setStart] = useState(restored?.start ?? today());
  const [end, setEnd] = useState(restored?.end ?? '');
  // subjects: [{ listId, examDate }]；scope: { [listId]: { items:{cid:{title,chapter,book_title,minutes}}, manual:[{label,est}] } }
  const [subjects, setSubjects] = useState(restored?.subjects ?? []);
  const [scope, setScope] = useState(restored?.scope ?? {});
  const [level, setLevel] = useState(restored?.level ?? 'progress');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(null);   // { listId } → 開教材選取
  const [preview, setPreview] = useState(null);    // 每日/時段的排程預覽 blocks

  // 草稿自動保存（返回/取消/重開可接續）。
  useEffect(() => { saveDraft({ step, name, start, end, subjects, scope, level }); },
    [step, name, start, end, subjects, scope, level]);

  const nameOf = id => lists.find(l => Number(l.id) === Number(id))?.name || '科目';
  const addSubject = id => {
    if (subjects.some(s => Number(s.listId) === Number(id))) return;
    setSubjects(s => [...s, { listId: Number(id), examDate: end || '' }]);
  };
  const removeSubject = id => {
    setSubjects(s => s.filter(x => Number(x.listId) !== Number(id)));
    setScope(sc => { const n = { ...sc }; delete n[id]; return n; });
  };
  const setExamDate = (id, d) => setSubjects(s => s.map(x => Number(x.listId) === Number(id) ? { ...x, examDate: d } : x));

  // 科目的 scope 讀寫
  const subjScope = id => scope[id] || { items: {}, manual: [] };
  const addItems = (listId, picked) => setScope(sc => {
    const cur = sc[listId] || { items: {}, manual: [] };
    const items = { ...cur.items };
    for (const p of picked) items[p.id] = { title: p.title, chapter: (p.path || [])[0] || '', book_title: p.book_title || '', minutes: p.estimated_minutes ?? null };
    return { ...sc, [listId]: { ...cur, items } };
  });
  const removeItem = (listId, cid) => setScope(sc => {
    const cur = sc[listId] || { items: {}, manual: [] };
    const items = { ...cur.items }; delete items[cid];
    return { ...sc, [listId]: { ...cur, items } };
  });
  const addManual = (listId, label, est) => setScope(sc => {
    const cur = sc[listId] || { items: {}, manual: [] };
    return { ...sc, [listId]: { ...cur, manual: [...cur.manual, { label, est: est || null }] } };
  });
  const removeManual = (listId, i) => setScope(sc => {
    const cur = sc[listId] || { items: {}, manual: [] };
    return { ...sc, [listId]: { ...cur, manual: cur.manual.filter((_, j) => j !== i) } };
  });

  const cancel = () => { clearDraft(); onCancel?.(); };

  // ---- 驗證每一步 ----
  const step0ok = name.trim() && end && subjects.length && (!start || end >= start)
    && subjects.every(s => !s.examDate || s.examDate <= end);
  const scopeCount = id => Object.keys(subjScope(id).items).length + subjScope(id).manual.length;
  const totalScope = subjects.reduce((n, s) => n + scopeCount(s.listId), 0);

  // ---- Step 3 排程預覽（每日/時段）----
  const buildItems = useCallback(() => {
    const items = []; const meta = {};
    for (const s of subjects) {
      const sc = subjScope(s.listId);
      const dueEnd = s.examDate || end;
      for (const [cid, it] of Object.entries(sc.items)) {
        const title = `${it.book_title ? it.book_title + '｜' : ''}${it.chapter ? it.chapter + '｜' : ''}${it.title}`;
        items.push({ subject_id: Number(s.listId), title, minutes: it.minutes || 30, spread: false, start: today(), end: dueEnd });
        meta[`${s.listId}|${title}`] = { content_item_id: Number(cid), deadline: dueEnd };
      }
      for (const m of sc.manual) {
        if (!m.est) continue; // 缺預估的手動範圍無法排入每日/時段（僅列為未排）
        const title = m.label;
        items.push({ subject_id: Number(s.listId), title, minutes: m.est, spread: false, start: today(), end: dueEnd });
        meta[`${s.listId}|${title}`] = { deadline: dueEnd };
      }
    }
    return { items, meta };
  }, [subjects, scope, end]);

  const runPreview = useCallback(async () => {
    if (level === 'progress') { setPreview(null); return; }
    const { items, meta } = buildItems();
    if (!items.length) { setPreview({ blocks: [], unplaced: [], meta, empty: true }); return; }
    setBusy(true); setErr('');
    try {
      const body = buildSchedulePreviewRequest({ items, startDate: today(), endDate: end, conditions: { timed: level === 'timed', pace: 'even' } });
      const r = await api('/schedule/preview', { method: 'POST', body });
      setPreview({ blocks: r.blocks || [], unplaced: r.unplaced || [], meta });
    } catch (e) { setErr(e.message || '預覽失敗'); setPreview(null); }
    finally { setBusy(false); }
  }, [level, end, buildItems]);
  useEffect(() => { if (step === 2) runPreview(); }, [step, level, runPreview]);

  // ---- 確認建立（atomic）----
  const confirm = async () => {
    setBusy(true); setErr('');
    try {
      const material_scope = subjects.flatMap(s => Object.keys(subjScope(s.listId).items).map(Number));
      const manual_scope = subjects.flatMap(s => subjScope(s.listId).manual.map(m => ({
        subject_list_id: Number(s.listId), label: m.label, estimated_minutes: m.est || null,
      })));
      const body = {
        name: name.trim(), start_date: start || null, end_date: end, level,
        subjects: subjects.map(s => ({ subject_list_id: Number(s.listId), exam_date: s.examDate || end })),
        material_scope, manual_scope,
      };
      if (level !== 'progress' && preview && preview.blocks.length) {
        const byKey = preview.meta || {};
        const creates = []; const blocks = []; const seen = new Set();
        preview.blocks.forEach((b, i) => {
          const key = `${b.subject_id}|${b.title}`;
          const m = byKey[key] || {};
          const ck = `x${i}`;
          if (!seen.has(key)) {
            seen.add(key);
            creates.push({
              client_key: ck, title: b.title, list_id: b.subject_id,
              deadline_date: m.deadline || null, estimated_minutes: b.minutes || null,
              material_content_item_id: m.content_item_id ?? null, tags: ['讀書計劃'],
            });
            blocks.push({ client_key: ck, date: b.date, start_time: b.start_time || null, end_time: b.end_time || null, planned_minutes: b.minutes ?? null });
          } else {
            // 同一 Task 多個 block：後續 block 綁同一 client_key
            const first = creates.find(c => c.title === b.title && c.list_id === b.subject_id);
            blocks.push({ client_key: first.client_key, date: b.date, start_time: b.start_time || null, end_time: b.end_time || null, planned_minutes: b.minutes ?? null });
          }
        });
        body.schedule = { task_creates: creates, blocks };
      }
      const created = await api('/exam-plans', { method: 'POST', body });
      clearDraft();
      onDone?.(created.plan.id);
    } catch (e) { setErr(e.message || '建立失敗'); setBusy(false); }
  };

  return (
    <div className="main">
      <PageHeader title="建立段考"
        back={<button className="page-back" onClick={step === 0 ? cancel : () => setStep(step - 1)}>← {step === 0 ? '取消' : '上一步'}</button>}
        actions={<IconButton label="取消" onClick={cancel}><Icon name="x" size={18} /></IconButton>} />
      <div className="main-body" style={{ maxWidth: 560 }}>
        <div className="steps" style={{ marginTop: 4 }}>{STEPS.map((_, i) => <div key={i} className={'step-dot' + (i <= step ? ' on' : '')} />)}</div>
        <div className="ui-meta" style={{ marginBottom: 10 }}>步驟 {step + 1}／3：{STEPS[step]}</div>
        {err && <div className="mt-err" role="alert" style={{ marginBottom: 8 }}>{err}</div>}

        {step === 0 && (
          <div style={{ display: 'grid', gap: 12 }}>
            <label className="ui-field"><span className="ui-meta">這次是什麼考試？</span>
              <input aria-label="段考名稱" value={name} onChange={e => setName(e.target.value)} placeholder="例如：第二次段考" /></label>
            <div className="row" style={{ gap: 8 }}>
              <label className="ui-field" style={{ flex: 1 }}><span className="ui-meta">從哪天開始準備</span>
                <input type="date" aria-label="開始日期" value={start} onChange={e => setStart(e.target.value)} /></label>
              <label className="ui-field" style={{ flex: 1 }}><span className="ui-meta">整個段考最後一天</span>
                <input type="date" aria-label="段考結束日期" value={end} onChange={e => setEnd(e.target.value)} /></label>
            </div>
            <div>
              <div className="ui-meta" style={{ marginBottom: 4 }}>加入考試科目（每科可有自己的考試日）</div>
              {subjects.map(s => (
                <div key={s.listId} className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
                  <span style={{ fontWeight: 600, minWidth: 64 }}>{nameOf(s.listId)}</span>
                  <input type="date" aria-label={`${nameOf(s.listId)} 考試日`} value={s.examDate || ''} max={end || undefined}
                    onChange={e => setExamDate(s.listId, e.target.value)} style={{ flex: 1 }} />
                  <IconButton label={`移除 ${nameOf(s.listId)}`} onClick={() => removeSubject(s.listId)}><Icon name="x" size={16} /></IconButton>
                </div>
              ))}
              <select aria-label="加入科目" value="" style={{ marginTop: 8, width: '100%' }}
                onChange={e => { if (e.target.value) addSubject(e.target.value); }}>
                <option value="">＋ 加入科目…</option>
                {lists.filter(l => !subjects.some(s => Number(s.listId) === Number(l.id))).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div className="ui-meta" style={{ marginTop: 4 }}>未指定單科考試日 → 沿用整個段考最後一天。</div>
            </div>
            <Button variant="primary" block disabled={!step0ok} onClick={() => setStep(1)}>下一步：加入各科範圍</Button>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: 'grid', gap: 12 }}>
            {subjects.map(s => {
              const sc = subjScope(s.listId);
              const byChapter = {};
              for (const [cid, it] of Object.entries(sc.items)) {
                const k = `${it.book_title}｜${it.chapter}`;
                (byChapter[k] = byChapter[k] || []).push([cid, it]);
              }
              return (
                <SurfaceCard key={s.listId}>
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <b>{nameOf(s.listId)}</b>
                    <span className="ui-meta">考試 {s.examDate ? md(s.examDate) : md(end)}</span>
                  </div>
                  {Object.keys(byChapter).length === 0 && sc.manual.length === 0 && (
                    <div className="ui-meta" style={{ marginTop: 6 }}>還沒選範圍。</div>
                  )}
                  {Object.entries(byChapter).map(([k, arr]) => (
                    <div key={k} style={{ marginTop: 6 }}>
                      <div className="ui-meta">{k.replace(/｜$/, '')}</div>
                      {arr.map(([cid, it]) => (
                        <div key={cid} className="row" style={{ gap: 6, marginLeft: 8, alignItems: 'baseline' }}>
                          <span>{it.title}</span>
                          <IconButton label={`移除 ${it.title}`} style={{ marginLeft: 'auto' }} onClick={() => removeItem(s.listId, cid)}><Icon name="x" size={14} /></IconButton>
                        </div>
                      ))}
                    </div>
                  ))}
                  {sc.manual.map((m, i) => (
                    <div key={`m${i}`} className="row" style={{ gap: 6, marginTop: 4, alignItems: 'baseline' }}>
                      <span>📝 {m.label}{m.est ? `（約 ${m.est} 分）` : ''}</span>
                      <span className="ui-meta">老師指定</span>
                      <IconButton label={`移除 ${m.label}`} style={{ marginLeft: 'auto' }} onClick={() => removeManual(s.listId, i)}><Icon name="x" size={14} /></IconButton>
                    </div>
                  ))}
                  <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="secondary" onClick={() => setPicking({ listId: s.listId })}>選教材／勾課章</Button>
                    <ManualAdder onAdd={(label, est) => addManual(s.listId, label, est)} />
                  </div>
                </SurfaceCard>
              );
            })}
            <Button variant="primary" block disabled={!totalScope} onClick={() => setStep(2)}>下一步：選擇怎麼安排</Button>
            {!totalScope && <div className="ui-meta" style={{ textAlign: 'center' }}>至少替一科加入一項範圍。</div>}
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'grid', gap: 12 }}>
            <SurfaceCard>
              <b>希望怎麼安排？</b>
              {LEVELS.map(([v, title, desc]) => (
                <label key={v} className="row" style={{ gap: 8, alignItems: 'baseline', marginTop: 8 }}>
                  <input type="radio" name="exam-level" checked={level === v} onChange={() => setLevel(v)} />
                  <span><b>{title}</b><div className="ui-meta">{desc}</div></span>
                </label>
              ))}
            </SurfaceCard>

            <SurfaceCard>
              <b>確認一下</b>
              <div className="ui-meta" style={{ marginBottom: 6 }}>{name}｜{start ? md(start) : ''}–{md(end)}</div>
              {subjects.map(s => {
                const sc = subjScope(s.listId);
                const chapters = [...new Set(Object.values(sc.items).map(it => `${it.book_title ? it.book_title + ' → ' : ''}${it.chapter}`))];
                return (
                  <div key={s.listId} style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 600 }}>{nameOf(s.listId)} · 考試 {md(s.examDate || end)}</div>
                    {chapters.map((c, i) => <div key={i} className="ui-meta" style={{ marginLeft: 6 }}>・{c}</div>)}
                    {sc.manual.map((m, i) => <div key={`m${i}`} className="ui-meta" style={{ marginLeft: 6 }}>・📝 {m.label}（老師指定）</div>)}
                    {chapters.length === 0 && sc.manual.length === 0 && <div className="ui-meta" style={{ marginLeft: 6 }}>（未選範圍）</div>}
                  </div>
                );
              })}
              {level !== 'progress' && preview && (
                <div style={{ marginTop: 10 }}>
                  <div className="ui-meta" style={{ fontWeight: 600 }}>每天要做的（預覽）</div>
                  <DailyPreview blocks={preview.blocks} />
                  {preview.unplaced?.length > 0 && <div className="ui-meta" style={{ color: 'var(--warning,#b7791f)' }}>有 {preview.unplaced.length} 項排不下，可回上一步調整或改用「只分段」。</div>}
                </div>
              )}
            </SurfaceCard>

            <Button variant="primary" block disabled={busy} onClick={confirm}>{busy ? '建立中…' : '確認，建立段考計畫'}</Button>
          </div>
        )}

        {picking && (
          <BottomSheet onClose={() => setPicking(null)} label="選教材">
            <SubjectMaterialPicker
              subjectId={picking.listId} subjectName={nameOf(picking.listId)} lists={lists}
              selectedIds={new Set(Object.keys(subjScope(picking.listId).items).map(Number))}
              onAdd={picked => addItems(picking.listId, picked)}
              onClose={() => setPicking(null)} />
          </BottomSheet>
        )}
      </div>
    </div>
  );
}

// 手動範圍輸入（老師指定、教材庫沒有）。
function ManualAdder({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [est, setEst] = useState('');
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>＋ 老師指定、教材庫沒有的範圍</Button>;
  return (
    <div className="row" style={{ gap: 6, width: '100%', flexWrap: 'wrap' }}>
      <input aria-label="老師指定範圍" value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：講義第三章" style={{ flex: 1, minWidth: 120 }} />
      <input aria-label="預估分鐘" type="number" min="1" value={est} onChange={e => setEst(e.target.value)} placeholder="分鐘(可空)" style={{ width: 90 }} />
      <Button size="sm" variant="primary" disabled={!label.trim()} onClick={() => { onAdd(label.trim(), Number(est) || null); setLabel(''); setEst(''); setOpen(false); }}>加入</Button>
    </div>
  );
}

// 每日預覽：blocks 依日期分組。
function DailyPreview({ blocks = [] }) {
  const byDate = {};
  for (const b of blocks) (byDate[b.date] = byDate[b.date] || []).push(b);
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return <div className="ui-meta">沒有可排入的內容。</div>;
  return (
    <div>
      {dates.map(d => (
        <div key={d} style={{ marginTop: 4 }}>
          <span style={{ fontWeight: 600 }}>{md(d)}</span>
          {byDate[d].map((b, i) => (
            <span key={i} className="ui-meta" style={{ marginLeft: 6 }}>
              {b.start_time ? `${b.start_time} ` : ''}{b.title}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// 單科教材選取：列該科的書 → 開一本 → 勾課/章/單元 → 加入。教材庫沒有可當場匯入回卡。
function SubjectMaterialPicker({ subjectId, subjectName, lists, selectedIds, onAdd, onClose }) {
  const [books, setBooks] = useState(null);
  const [openBook, setOpenBook] = useState(null);
  const [tree, setTree] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [importing, setImporting] = useState(false);

  const loadBooks = useCallback(async () => {
    const r = await listShelf({});
    setBooks((r.books || []).filter(b => Number(b.subject_list_id) === Number(subjectId) && b.material_book_id));
  }, [subjectId]);
  useEffect(() => { loadBooks().catch(() => setBooks([])); }, [loadBooks]);

  const open = async b => {
    setOpenBook(b); setTree(null); setChecked(new Set());
    try { setTree(await getBookTree(b.material_book_id)); } catch { setTree({ nodes: [] }); }
  };
  const items = useMemo(() => (tree ? flattenItems(tree) : []), [tree]);
  const toggle = it => setChecked(s => { const n = new Set(s); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; });
  const addChecked = () => {
    const picked = items.filter(it => checked.has(it.id)).map(it => ({ id: it.id, title: it.title, path: it.path, book_title: openBook.title, estimated_minutes: it.estimated_minutes ?? null }));
    onAdd(picked); setOpenBook(null); setTree(null); setChecked(new Set());
  };

  if (importing) {
    return <AddMaterialFlow lists={lists} onCancel={() => setImporting(false)}
      onCreated={async () => { setImporting(false); await loadBooks(); }} />;
  }
  if (openBook) {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="row"><b>{openBook.title}</b><Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => { setOpenBook(null); setTree(null); }}>返回書單</Button></div>
        {!tree ? <div className="ui-meta">載入中…</div> : !items.length ? <div className="ui-meta">這本還沒有目錄。</div> : (
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {items.map(it => (
              <label key={it.id} className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                <input type="checkbox" checked={checked.has(it.id) || selectedIds.has(it.id)} disabled={selectedIds.has(it.id)} onChange={() => toggle(it)} />
                <span className="ui-meta">{(it.path || [])[0]} ·</span><span>{it.title}</span>
                {selectedIds.has(it.id) && <span className="ui-meta">已加入</span>}
              </label>
            ))}
          </div>
        )}
        <Button variant="primary" disabled={!checked.size} onClick={addChecked}>加入所選（{checked.size}）</Button>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <b>{subjectName} 的教材</b>
      {books == null ? <div className="ui-meta">載入中…</div>
        : books.length === 0 ? <EmptyState title="這科還沒有教材" description="當場匯入或建立一本，完成後回到這裡繼續選。" />
          : books.map(b => (
            <div key={b.material_book_id} className="row" role="button" tabIndex={0} style={{ cursor: 'pointer', padding: '6px 0' }}
              onClick={() => open(b)} onKeyDown={e => { if (e.key === 'Enter') open(b); }}>
              <span>{b.title}</span><Icon name="chevron" size={16} style={{ marginLeft: 'auto' }} />
            </div>
          ))}
      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        <Button size="sm" variant="secondary" onClick={() => setImporting(true)}>匯入／建立教材</Button>
        <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>完成</Button>
      </div>
    </div>
  );
}
