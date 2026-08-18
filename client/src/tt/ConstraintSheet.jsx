import { useEffect, useState } from 'react';
import { api } from '../api';
import { BottomSheet, Button, SurfaceCard } from './ui';

// C：AI 提案永遠停在這張確認卡；使用者按確認後才寫 structured intent，
// 而且 parser 標成 unsupported 的條件清楚保留，不會被靜默忽略。
export default function ConstraintSheet({ planId, onClose }) {
  const [source, setSource] = useState(''); const [candidate, setCandidate] = useState(null); const [loading, setLoading] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api(`/plans/${planId}/constraints`).then(x => { setSource(x.source_text || ''); if (Object.keys(x.intent || {}).length || x.unsupported?.length) setCandidate({ supported: x.intent || {}, unsupported: x.unsupported || [] }); }).catch(() => {}); }, [planId]);
  const parse = async () => { try { setLoading(true); setErr(''); setCandidate(await api(`/plans/${planId}/constraints/parse`, { method: 'POST', body: { source_text: source } })); } catch (e) { setErr(e.message); } finally { setLoading(false); } };
  const confirm = async () => { try { setLoading(true); setErr(''); await api(`/plans/${planId}/constraints`, { method: 'PUT', body: { source_text: source, intent: candidate?.supported || {} } }); onClose(); } catch (e) { setErr(e.message); } finally { setLoading(false); } };
  return <BottomSheet onClose={onClose} label="AI 排程條件"><b>AI 排程條件</b><div className="ui-meta" style={{ marginTop: 6 }}>AI 只解讀你的意思；真正的時間仍由排程器與鎖定規則決定。</div><textarea aria-label="排程條件" rows="4" placeholder="例如：數學先排，週三不要化學" value={source} onChange={e => setSource(e.target.value)} style={{ width: '100%', marginTop: 12 }} /><Button variant="secondary" block disabled={loading || !source.trim()} onClick={parse}>{loading ? '解讀中…' : '請 AI 解讀'}</Button>{err && <SurfaceCard tone="warning" style={{ marginTop: 12 }}>{err}</SurfaceCard>}{candidate && <SurfaceCard style={{ marginTop: 12 }}><b>請確認後再套用</b><div className="ui-meta" style={{ marginTop: 6 }}>已支援：{Object.keys(candidate.supported || {}).length ? JSON.stringify(candidate.supported) : '沒有可安全套用的條件'}</div>{candidate.unsupported?.length > 0 && <div className="ui-meta" style={{ marginTop: 6, color: 'var(--warning)' }}>尚未支援：{candidate.unsupported.map(x => x.key).join('、')}（不會被偷偷套用）</div>}<Button variant="primary" block style={{ marginTop: 12 }} disabled={loading} onClick={confirm}>確認套用已支援條件</Button></SurfaceCard>}</BottomSheet>;
}
