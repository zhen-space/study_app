import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { api } from '../api';
import { listShelf, getBookTree, flattenItems } from './material';
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
  ['progress', '只記錄考試範圍與截止日', '不產生每日待辦，也不會排到行事曆；之後仍可再安排'],
  ['daily', '幫我排出每天要完成什麼', '自動分配到每天並出現在每日待辦，但不指定幾點'],
  ['timed', '幫我排到每天的具體時間', '依可用時間與既有行程排出起訖時間，顯示在行事曆'],
];
const LEVEL_OUTCOME = {
  progress: '只保存考試範圍與截止日，不產生每日待辦或行事曆時段。',
  daily: '建立每天要完成的待辦，但不指定幾點開始。',
  timed: '建立有起訖時間的每日安排，並顯示在行事曆。',
};

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
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(null);   // { listId } → 開教材選取
  const [preview, setPreview] = useState(null);    // 每日/時段的排程預覽 blocks
  const previewRequest = useRef(0);
  // React state 在同一個 event turn 不會同步更新；用 ref 擋住手機快速連點造成的重複建立。
  const creatingRef = useRef(false);

  // 草稿自動保存（返回/取消/重開可接續）。
  useEffect(() => { saveDraft({ step, name, start, end, subjects, scope, level }); },
    [step, name, start, end, subjects, scope, level]);

  const nameOf = useCallback(id => lists.find(l => Number(l.id) === Number(id))?.name || '已刪除的科目', [lists]);
  const addSubject = id => {
    if (subjects.some(s => Number(s.listId) === Number(id))) return;
    // 空值才是「沿用整個段考最後一天」的單一真相。
    // 若在新增科目時就把當下 end 複製進去，後來改段考日期時它會
    // 偷偷留在舊日期，畫面寫「沿用」卻實際沒有沿用。
    setSubjects(s => [...s, { listId: Number(id), examDate: '' }]);
  };
  const removeSubject = id => {
    setSubjects(s => s.filter(x => Number(x.listId) !== Number(id)));
    setScope(sc => { const n = { ...sc }; delete n[id]; return n; });
  };
  const setExamDate = (id, d) => setSubjects(s => s.map(x => Number(x.listId) === Number(id) ? { ...x, examDate: d } : x));

  // 科目的 scope 讀寫
  const subjScope = useCallback(id => scope[id] || { items: {}, manual: [] }, [scope]);
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

  // 離開不是放棄：手機上可能只是暫時切去查考試日期或教材，草稿要留著讓下次接續。
  // 只有 atomic 建立成功後才清掉草稿，避免誤觸返回／右上關閉就整份消失。
  const exitForNow = () => { onCancel?.(); };

  // ---- 驗證每一步 ----
  // 草稿可能跨裝置／跨數天保留；期間若科目已被刪除，不能把失效 id 送去預覽或建立。
  // 保留該列讓使用者自己移除，不暗中刪掉已選範圍。
  const missingSubjects = subjects.filter(s => !lists.some(l => Number(l.id) === Number(s.listId)));
  const invalidSubjectDates = subjects.filter(s => s.examDate && (
    (start && s.examDate < start) || (end && s.examDate > end)
  ));
  const step0ok = name.trim() && end && subjects.length && !missingSubjects.length && (!start || end >= start)
    && subjects.every(s => !s.examDate || ((!start || s.examDate >= start) && s.examDate <= end));
  const step0Hint = !name.trim() ? '請先輸入段考名稱。'
    : !end ? '請選擇整個段考的最後一天。'
      : start && end < start ? '段考最後一天不能早於準備開始日。'
        : !subjects.length ? '請至少加入一個考試科目。'
          : missingSubjects.length ? '草稿中的科目已不存在，請先移除後再重新選擇。'
          : invalidSubjectDates.length ? `${invalidSubjectDates.map(s => nameOf(s.listId)).join('、')}的考試日必須在準備開始日到段考最後一天之間。`
            : '';
  const scopeCount = id => Object.keys(subjScope(id).items).length + subjScope(id).manual.length;
  const totalScope = subjects.reduce((n, s) => n + scopeCount(s.listId), 0);
  const missingScopeSubjects = subjects.filter(s => scopeCount(s.listId) === 0);

  // ---- Step 3 排程預覽（每日/時段）----
  // 預覽只是「讓使用者看一眼」——實際排程由**伺服器**用 CURRENT scope 自己算，
  // 前端不送任何 blocks／task_creates（見後端 createExamPlanAtomic）。
  const requestBody = useCallback(() => ({
    name: name.trim(), start_date: start || null, end_date: end, level,
    subjects: subjects.map(s => ({ subject_list_id: Number(s.listId), exam_date: s.examDate || end })),
    material_scope: subjects.flatMap(s => Object.keys(subjScope(s.listId).items).map(Number)),
    manual_scope: subjects.flatMap(s => subjScope(s.listId).manual.map(m => ({
      subject_list_id: Number(s.listId), label: m.label, estimated_minutes: m.est || null,
    }))),
  }), [name, start, end, level, subjects, subjScope]);

  // 每日／時段需要每項都有預估時間，缺一律無法排入（跟後端 fail-closed 一致）。
  const scheduleGate = useMemo(() => {
    if (level === 'progress') return { ok: true, missing: [] };
    const missing = [];
    for (const s of subjects) {
      const sc = subjScope(s.listId);
      for (const it of Object.values(sc.items)) if (!(it.minutes > 0)) missing.push(`${nameOf(s.listId)}｜${it.title}`);
      for (const m of sc.manual) if (!(m.est > 0)) missing.push(`${nameOf(s.listId)}｜${m.label}`);
    }
    return { ok: missing.length === 0, missing };
  }, [level, subjects, nameOf, subjScope]);

  const runPreview = useCallback(async () => {
    const requestId = ++previewRequest.current;
    setPreviewing(true); setErr('');
    try {
      const r = await api('/exam-plans/preview', { method: 'POST', body: requestBody() });
      if (requestId === previewRequest.current) {
        setPreview({ ...r, blocks: r.blocks || [], failed: false });
        return true;
      }
      return false;
    } catch (e) {
      if (requestId === previewRequest.current) setPreview({ blocks: [], failed: true, error: e.message || '預覽失敗' });
      return false;
    } finally { if (requestId === previewRequest.current) setPreviewing(false); }
  }, [requestBody]);
  useEffect(() => { if (step === 2 && !missingSubjects.length) runPreview(); }, [step, level, runPreview, missingSubjects.length]);

  // daily／timed 只有在「有完整預估、預覽成功、有排出內容、且沒有排不下」時才可建立。
  // 這是 P0-1 的前端防線；伺服器仍會再 fail-closed 一次（單一權威來源）。
  const scheduleBlocked = !!missingSubjects.length || !scheduleGate.ok || previewing || !preview || preview.failed || !preview.preview_token
    || (level !== 'progress' && preview.blocks.length === 0);
  const canConfirm = !creating && !scheduleBlocked;

  // ---- 確認建立（atomic，server-authoritative）----
  const confirm = async () => {
    if (creatingRef.current || scheduleBlocked) return;
    creatingRef.current = true;
    setCreating(true); setErr('');
    try {
      const body = { ...requestBody(), preview_token: preview.preview_token };
      const created = await api('/exam-plans', { method: 'POST', body });
      clearDraft();
      onDone?.(created.plan.id);
    } catch (e) {
      if (e.status === 409 && e.payload?.code === 'EXAM_PREVIEW_STALE') {
        setPreview(null);
        creatingRef.current = false;
        setCreating(false);
        // stale 不是使用者做錯事：自動取回 CURRENT 世界，但絕不自動送出第二次建立。
        // 使用者會看到新預覽，必須親自再確認一次。
        const refreshed = await runPreview();
        setErr(refreshed
          ? '範圍或安排已更新，已為你重新預覽；請確認新內容後再建立。'
          : '範圍或安排已更新，但重新預覽失敗。請稍後再試。');
        return;
      } else setErr(e.message || '建立失敗');
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div className="main">
      <PageHeader title="建立段考"
        back={<button className="page-back" onClick={step === 0 ? exitForNow : () => setStep(step - 1)}>← {step === 0 ? '稍後繼續' : '上一步'}</button>}
        actions={<IconButton label="稍後繼續" onClick={exitForNow}><Icon name="x" size={18} /></IconButton>} />
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
                <div key={s.listId} className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, minWidth: 64 }}>{nameOf(s.listId)}</span>
                  <input type="date" aria-label={`${nameOf(s.listId)} 考試日`} value={s.examDate || end || ''}
                    min={start || undefined} max={end || undefined}
                    onChange={e => setExamDate(s.listId, e.target.value)} style={{ flex: 1, minWidth: 140 }} />
                  <IconButton label={`移除 ${nameOf(s.listId)}`} onClick={() => removeSubject(s.listId)}><Icon name="x" size={16} /></IconButton>
                  <div className="ui-meta" style={{ flexBasis: '100%', paddingLeft: 72 }}>
                    {s.examDate
                      ? <><span>已自訂單科考試日。</span>{' '}<button type="button" className="btn sm ghost" onClick={() => setExamDate(s.listId, '')}>改回沿用最後一天</button></>
                      : `沿用整個段考最後一天${end ? `（${md(end)}）` : ''}`}
                  </div>
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
            {!step0ok && <div className="ui-meta" role="status" style={{ textAlign: 'center' }}>{step0Hint}</div>}
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
                <SurfaceCard key={s.listId} tone={scopeCount(s.listId) === 0 ? 'warning' : undefined}>
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <b>{nameOf(s.listId)}</b>
                    <span className="ui-meta">考試 {s.examDate ? md(s.examDate) : md(end)}</span>
                  </div>
                  {Object.keys(byChapter).length === 0 && sc.manual.length === 0 && (
                    <div className="error" role="alert" style={{ marginTop: 6 }}>請替{nameOf(s.listId)}加入至少一項考試範圍。</div>
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
            <Button variant="primary" block disabled={!totalScope || missingScopeSubjects.length > 0} onClick={() => setStep(2)}>下一步：選擇怎麼安排</Button>
            {missingScopeSubjects.length > 0 && <div className="error" role="alert" style={{ textAlign: 'center' }}>
              尚未加入範圍：{missingScopeSubjects.map(s => nameOf(s.listId)).join('、')}
            </div>}
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
              <div aria-label="建立結果摘要" style={{ marginBottom: 8 }}><b>這次會：</b>{LEVEL_OUTCOME[level]}</div>
              {subjects.map(s => {
                const canonical = (preview?.scope || []).filter(x => Number(x.subject_list_id) === Number(s.listId));
                return (
                  <div key={s.listId} style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 600 }}>{nameOf(s.listId)} · 考試 {md(s.examDate || end)}</div>
                    {canonical.map((x, i) => <div key={x.content_item_id ?? `m${i}`} className="ui-meta" style={{ marginLeft: 6 }}>・{x.kind === 'manual' ? '📝 ' : ''}{x.title}{x.estimated_minutes ? `（${x.estimated_minutes} 分）` : ''}</div>)}
                    {preview && !preview.failed && canonical.length === 0 && <div className="ui-meta" style={{ marginLeft: 6 }}>（未選範圍）</div>}
                  </div>
                );
              })}
              {level !== 'progress' && preview && !preview.failed && !preview.empty && (
                <div style={{ marginTop: 10 }}>
                  <div className="ui-meta" style={{ fontWeight: 600 }}>每天要做的（預覽）</div>
                  <DailyPreview blocks={preview.blocks} nameOf={nameOf} />
                </div>
              )}
            </SurfaceCard>

            {/* P0-1：daily／timed 排不下、缺預估、預覽失敗或空 → 不得建立可確認的計畫，給明確補救 */}
            {previewing && (
              <SurfaceCard>
                <b>正在準備安排預覽…</b>
                <div className="ui-meta" role="status" style={{ marginTop: 4 }}>還沒有建立計畫；預覽完成後，你可以先確認內容再建立。</div>
              </SurfaceCard>
            )}

            {scheduleBlocked && !previewing && (
              <SurfaceCard>
                <b>{level === 'progress' ? '還不能建立段考計畫' : '還不能建立每天安排'}</b>
                {missingSubjects.length ? (
                  <div className="ui-meta" style={{ marginTop: 4 }}>
                    草稿中的科目已不存在。請回到第一步移除「已刪除的科目」，再重新選擇。
                  </div>
                ) : !scheduleGate.ok ? (
                  <div className="ui-meta" style={{ marginTop: 4 }}>
                    這些範圍還沒有預估時間，無法排入每天安排：{scheduleGate.missing.slice(0, 6).join('、')}{scheduleGate.missing.length > 6 ? '…' : ''}
                  </div>
                ) : preview?.failed ? (
                  <div className="ui-meta" style={{ marginTop: 4 }}>預覽失敗：{preview.error}</div>
                ) : !preview ? (
                  <div className="ui-meta" style={{ marginTop: 4 }}>請重新取得最新預覽。</div>
                ) : level !== 'progress' && preview?.blocks.length === 0 ? (
                  <div className="ui-meta" style={{ marginTop: 4 }}>目前沒有可排入的內容。</div>
                ) : null}
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {missingSubjects.length ? (
                    <Button size="sm" variant="primary" onClick={() => setStep(0)}>回第一步移除失效科目</Button>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => setStep(1)}>回上一步調整範圍／日期</Button>
                      {(preview?.failed || !preview) && <Button size="sm" variant="primary" onClick={runPreview}>重新預覽</Button>}
                      {level !== 'progress' && <Button size="sm" variant="ghost" onClick={() => setLevel('progress')}>改用「只記錄考試範圍與截止日」</Button>}
                    </>
                  )}
                </div>
              </SurfaceCard>
            )}

            <Button variant="primary" block disabled={!canConfirm} onClick={confirm}>
              {creating ? '正在建立段考計畫…' : previewing ? '正在產生預覽…' : '確認，建立段考計畫'}
            </Button>
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
function DailyPreview({ blocks = [], nameOf }) {
  const byDate = {};
  for (const b of blocks) (byDate[b.date] = byDate[b.date] || []).push(b);
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return <div className="ui-meta">沒有可排入的內容。</div>;
  return (
    <div>
      {dates.map(d => (
        <div key={d} style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>{md(d)} · {byDate[d].length} 項</div>
          {byDate[d].map((b, i) => (
            <div key={i} className="ui-meta" style={{ margin: '4px 0 0 6px', display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ flexShrink: 0 }}>{nameOf?.(b.subject_id) || '科目'}</span>
              {b.start_time && <span style={{ flexShrink: 0 }}>{b.start_time}{b.end_time ? `–${b.end_time}` : ''}</span>}
              <span>{b.title}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// 單科教材選取：列該科的書 → 開一本 → 勾課/章/單元 → 加入。教材庫沒有可當場匯入回卡。
function SubjectMaterialPicker({ subjectId, subjectName, lists, selectedIds, onAdd, onClose }) {
  const [books, setBooks] = useState(null);
  const [booksError, setBooksError] = useState('');
  const [openBook, setOpenBook] = useState(null);
  const [tree, setTree] = useState(null);
  const [treeError, setTreeError] = useState('');
  const [checked, setChecked] = useState(new Set());
  const [importing, setImporting] = useState(false);

  const loadBooks = useCallback(async () => {
    setBooks(null); setBooksError('');
    try {
      const r = await listShelf({});
      setBooks((r.books || []).filter(b => Number(b.subject_list_id) === Number(subjectId) && b.material_book_id));
      return true;
    } catch (e) {
      setBooksError(e.message || '暫時無法載入教材');
      return false;
    }
  }, [subjectId]);
  useEffect(() => { loadBooks(); }, [loadBooks]);

  const open = async b => {
    setOpenBook(b); setTree(null); setTreeError(''); setChecked(new Set());
    try { setTree(await getBookTree(b.material_book_id)); }
    catch (e) { setTreeError(e.message || '暫時無法載入教材目錄'); }
  };
  const items = useMemo(() => (tree ? flattenItems(tree) : []), [tree]);
  const toggle = it => setChecked(s => { const n = new Set(s); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; });
  const addChecked = () => {
    const picked = items.filter(it => checked.has(it.id)).map(it => ({ id: it.id, title: it.title, path: it.path, book_title: openBook.title, estimated_minutes: it.estimated_minutes ?? null }));
    onAdd(picked); setOpenBook(null); setTree(null); setChecked(new Set());
  };

  if (importing) {
    // 從段考科目卡進來：預帶本卡科目（建立的教材一定屬於這一科），建立後自動刷新書單
    // 並直接開啟新書，讓新教材立即可勾選；取消回到書單（段考草稿仍在 localStorage）。
    return <AddMaterialFlow lists={lists} defaultSubjectId={subjectId}
      onCancel={() => setImporting(false)}
      onCreated={async (r) => {
        setImporting(false);
        await loadBooks();
        const created = r?.book;
        if (created?.id) await open({ material_book_id: created.id, title: created.title });
      }} />;
  }
  if (openBook) {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="row"><b>{openBook.title}</b><Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => { setOpenBook(null); setTree(null); }}>返回書單</Button></div>
        {treeError ? <div className="ui-card ui-card--warning" role="alert">
          <div>{treeError}</div>
          <Button size="sm" variant="secondary" style={{ marginTop: 6 }} onClick={() => open(openBook)}>重試載入目錄</Button>
        </div> : !tree ? <div className="ui-meta">載入中…</div> : !items.length ? <div className="ui-meta">這本還沒有目錄。</div> : (
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
      {booksError ? <div className="ui-card ui-card--warning" role="alert">
        <div>{booksError}</div>
        <Button size="sm" variant="secondary" style={{ marginTop: 6 }} onClick={loadBooks}>重試載入教材</Button>
      </div> : books == null ? <div className="ui-meta">載入中…</div>
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
