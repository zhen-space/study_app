import { useCallback, useEffect, useMemo, useState } from 'react';
import { getContentCheck, commitContentCheck, ITEM_LABEL } from './material';
import { Button } from './ui';

// 「確認教材內容」。
//
// 學生的認知只有一件事：這本教材裡實際有哪些東西。他不需要知道自己的資料
// 原本存在哪一張表、也不需要知道確認之後系統做了什麼。所以這個畫面裡
// 沒有 legacy／migration／formalization／identity，也沒有「轉換成正式教材」。
//
// 系統已經知道的（書名、出版社、科目、章、節／主題）直接帶入，不再問一次。
// **不知道**的只有一件事：每個節底下到底有沒有課本內容／範例／例題。
// 舊資料從來沒有存過這個——猜就是無中生有，所以一定要問。
//
// 取消：什麼都不會寫。確認：整本一次建立，全成功或全不做。

const NODE_KINDS = [
  { value: 'section', label: '節' },
  { value: 'topic', label: '主題' },
];
// 節／主題底下可能有的內容
const CHILD_KINDS = ['reading', 'example', 'example_problem'];
// 每一章另外可能有的內容。它們不屬於任何一節——不為它們造一個假的節。
const CHAPTER_KINDS = ['unit_exercise', 'past_exam'];

// 一個節點的 key。用的是原始資料列的位置，不是標題——標題會重複。
const childKey = c => `${c.legacy_ref?.toc_id}:${(c.legacy_ref?.path || []).join('.')}`;
const chapterKey = ch => `ch:${ch.legacy_ref?.toc_id}`;

function KindChips({ kinds, value, onToggle, disabled = false, idPrefix }) {
  return (
    <div className="mc-kinds">
      {kinds.map(k => {
        const on = value.includes(k);
        return (
          <button key={k} type="button" role="checkbox" aria-checked={on} disabled={disabled}
            aria-label={`${idPrefix}：${ITEM_LABEL[k]}`}
            className={'mc-chip' + (on ? ' on' : '')}
            onClick={() => onToggle(k)}>
            <span className="mc-chip-box" aria-hidden="true">{on ? '✓' : ''}</span>
            {ITEM_LABEL[k]}
          </button>
        );
      })}
    </div>
  );
}

export default function MaterialContentCheck({ book, onCancel, onDone }) {
  const listId = book?.legacy_ref?.list_id;
  const bookName = book?.legacy_ref?.book ?? '';

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');   // 自然語言的提示（例如內容剛剛變動）
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState({});
  // key → 勾選的內容種類
  const [picks, setPicks] = useState({});
  // 對不上正式種類的節點：學生自己決定它是節還是主題，系統不猜
  const [kindOf, setKindOf] = useState({});
  // 「每一節通常有」的整本套用狀態
  const [bulk, setBulk] = useState({ child: [], chapter: [] });

  const load = useCallback(async () => {
    setErr(''); setData(null);
    try {
      const d = await getContentCheck(listId, bookName);
      setData(d);
      setPicks({});
      setKindOf({});
      setBulk({ child: [], chapter: [] });
      setOpen(Object.fromEntries((d.draft?.chapters || []).map((c, i) => [chapterKey(c), i === 0])));
    } catch (e) { setErr(e.message); }
  }, [listId, bookName]);

  useEffect(() => { load(); }, [load]);

  const chapters = data?.draft?.chapters || [];

  const toggle = (key, kind) => setPicks(p => {
    const cur = p[key] || [];
    return { ...p, [key]: cur.includes(kind) ? cur.filter(k => k !== kind) : [...cur, kind] };
  });

  // 一次套到整本。教材通常每一節的結構都一樣，一節一節點三十次不是確認，是苦工。
  // 套用之後仍然可以逐一調整——決定的人始終是學生。
  const applyAll = (scope, kind) => {
    const on = !bulk[scope].includes(kind);
    setBulk(b => ({
      ...b,
      [scope]: on ? [...b[scope], kind] : b[scope].filter(k => k !== kind),
    }));
    setPicks(p => {
      const next = { ...p };
      const put = key => {
        const cur = next[key] || [];
        if (on) { if (!cur.includes(kind)) next[key] = [...cur, kind]; }
        else next[key] = cur.filter(k => k !== kind);
      };
      for (const ch of chapters) {
        if (scope === 'chapter') { put(chapterKey(ch)); continue; }
        for (const c of ch.children) put(childKey(c));
        // 還沒指定是節還是主題的，這裡不動它——它根本還不會進教材
        for (const u of ch.unsupported_nodes || []) if (kindOf[childKey(u)]) put(childKey(u));
      }
      return next;
    });
  };

  const total = useMemo(
    () => Object.values(picks).reduce((n, ks) => n + (ks?.length || 0), 0), [picks]);

  // 勾選 → canonical draft。identity 由建立當下決定，這裡只描述「要建立什麼」。
  const buildDraft = () => ({
    book: data.draft.book,
    chapters: chapters.map((ch, ci) => {
      const children = [];
      for (const c of ch.children) {
        children.push({
          kind: c.kind, title: c.title, order: children.length,
          content_items: (picks[childKey(c)] || []).map((kind, i) => ({
            kind, title: ITEM_LABEL[kind], order: i,
          })),
        });
      }
      // 學生指定過種類的才會進教材。沒指定的這次就不加入——不替他選一個。
      for (const u of ch.unsupported_nodes || []) {
        const k = childKey(u);
        if (!kindOf[k]) continue;
        children.push({
          kind: kindOf[k], title: u.title, order: children.length,
          content_items: (picks[k] || []).map((kind, i) => ({
            kind, title: ITEM_LABEL[kind], order: i,
          })),
        });
      }
      return {
        title: ch.title, order: ci,
        content_items: (picks[chapterKey(ch)] || []).map((kind, i) => ({
          kind, title: ITEM_LABEL[kind], order: i,
        })),
        children,
      };
    }),
  });

  const submit = async () => {
    setBusy(true); setErr(''); setNotice('');
    try {
      const r = await commitContentCheck(listId, {
        book: bookName, draft: buildDraft(), sourceSnapshot: data.source_snapshot,
      });
      onDone?.(r);
    } catch (e) {
      // 內容在確認的這段時間被改過：重新載入讓學生再看一次真正的內容。
      // 不自動重送——他確認的必須是他真的看過的那一份。
      if (e.status === 409) {
        setNotice('教材內容剛剛有更新，請再確認一次。');
        await load();
      } else setErr(e.message);
    } finally { setBusy(false); }
  };

  if (err && !data) {
    return (
      <div className="mc">
        <div className="mt-err" role="alert">{err}</div>
        <Button variant="tertiary" onClick={onCancel}>返回</Button>
      </div>
    );
  }
  if (!data) return <div className="mt-loading">載入中…</div>;

  return (
    <div className="mc">
      <div className="mc-head">
        <h3 className="mc-title">確認教材內容</h3>
        <div className="mc-book">{data.draft.book.title}</div>
        <p className="mc-lead">勾選這本教材裡實際有的內容，之後就可以直接安排。</p>
      </div>

      {notice && <div className="mc-notice" role="status">{notice}</div>}
      {err && <div className="mt-err" role="alert">{err}</div>}

      <div className="mc-bulk">
        <div className="mc-bulk-label">每一節通常有</div>
        <KindChips kinds={CHILD_KINDS} value={bulk.child} idPrefix="每一節通常有"
          onToggle={k => applyAll('child', k)} />
        <div className="mc-bulk-label">每一章另外有</div>
        <KindChips kinds={CHAPTER_KINDS} value={bulk.chapter} idPrefix="每一章另外有"
          onToggle={k => applyAll('chapter', k)} />
      </div>

      <div className="mc-list">
        {chapters.map(ch => {
          const k = chapterKey(ch);
          const isOpen = !!open[k];
          const count = (picks[k]?.length || 0)
            + ch.children.reduce((n, c) => n + (picks[childKey(c)]?.length || 0), 0)
            + (ch.unsupported_nodes || []).reduce((n, u) => n + (picks[childKey(u)]?.length || 0), 0);
          return (
            <div key={k} className="mc-chapter">
              <button type="button" className="mc-chapter-head" aria-expanded={isOpen}
                onClick={() => setOpen(o => ({ ...o, [k]: !o[k] }))}>
                <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                <span className="mc-chapter-title">{ch.title}</span>
                <span className="mc-chapter-count">{count ? `已選 ${count} 項` : ''}</span>
              </button>
              {isOpen && (
                <div className="mc-chapter-body">
                  {ch.children.map(c => (
                    <div key={childKey(c)} className="mc-node">
                      <div className="mc-node-title">{c.title}</div>
                      <KindChips kinds={CHILD_KINDS} value={picks[childKey(c)] || []}
                        idPrefix={c.title} onToggle={kind => toggle(childKey(c), kind)} />
                    </div>
                  ))}
                  {(ch.unsupported_nodes || []).map(u => {
                    const uk = childKey(u);
                    return (
                      <div key={uk} className="mc-node mc-node--ask">
                        <div className="mc-node-title">{u.title}</div>
                        {/* 課本上印的是「焦點」這類字，正式結構裡沒有對應的一層。
                            系統不替他決定，讓他自己說這是一節還是一個主題。 */}
                        <div className="mc-ask">
                          <span className="mc-ask-label">
                            這是{u.legacy_level ? `（課本上寫「${u.legacy_level}」）` : ''}
                          </span>
                          {NODE_KINDS.map(n => (
                            <button key={n.value} type="button" role="radio"
                              aria-checked={kindOf[uk] === n.value}
                              aria-label={`${u.title}：${n.label}`}
                              className={'mc-chip' + (kindOf[uk] === n.value ? ' on' : '')}
                              onClick={() => setKindOf(s => ({ ...s, [uk]: n.value }))}>
                              {n.label}
                            </button>
                          ))}
                        </div>
                        <KindChips kinds={CHILD_KINDS} value={picks[uk] || []} disabled={!kindOf[uk]}
                          idPrefix={u.title} onToggle={kind => toggle(uk, kind)} />
                      </div>
                    );
                  })}
                  <div className="mc-node mc-node--chapter">
                    <div className="mc-node-title">本章</div>
                    <KindChips kinds={CHAPTER_KINDS} value={picks[k] || []}
                      idPrefix={`${ch.title}：本章`} onToggle={kind => toggle(k, kind)} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mc-foot">
        <span className="mc-total" aria-live="polite">已選 {total} 項</span>
        <Button variant="tertiary" onClick={onCancel} disabled={busy}>取消</Button>
        <Button variant="primary" disabled={busy || !total} onClick={submit}>
          {busy ? '處理中…' : '完成'}
        </Button>
      </div>
    </div>
  );
}
