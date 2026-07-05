import { useEffect, useState } from 'react';
import { api } from '../api';
import PetSprite, { MONSTERS } from './PetSprite';

export default function PetView() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('/pet').then(setD);
  useEffect(() => { load(); }, []);
  if (!d) return <div className="main" />;

  const pet = d.pet;
  const owned = pet.owned || [];
  const equipped = pet.equipped || [];
  const level = Math.floor(d.coins_total / 100) + 1;
  const xp = d.coins_total % 100;

  const save = patch => api('/pet', { method: 'PATCH', body: patch }).then(load);
  const buy = async id => {
    setErr('');
    try { await api('/shop/buy', { method: 'POST', body: { id } }); load(); }
    catch (e) { setErr(e.message); }
  };
  const toggleEquip = id =>
    save({ equipped: equipped.includes(id) ? equipped.filter(x => x !== id) : [...equipped, id] });

  if (!MONSTERS[pet.type]) return (
    <div className="main">
      <div className="main-head"><h2>領養小怪獸</h2></div>
      <div className="main-body" style={{ textAlign: 'center', paddingTop: 10 }}>
        <p>選一隻小怪獸陪你讀書——牠會在各頁面走來走去、提醒你任務、幫你加油！<br /><b>只能養一隻</b>，選好囉。</p>
        <div className="stat-tiles" style={{ marginTop: 16 }}>
          {Object.entries(MONSTERS).map(([k, mo]) => (
            <button key={k} className="tile" style={{ cursor: 'pointer' }} onClick={() => {
              const name = prompt(`幫${mo.name}取個名字（直接確定就叫${mo.name}）：`) || mo.name;
              save({ type: k, name, equipped: [] });
            }}>
              <PetSprite type={k} size={110} />
              <div style={{ fontWeight: 700 }}>{mo.name}</div>
              <div className="muted">{mo.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  const scene = equipped.filter(id => ['house', 'garden', 'castle'].includes(id));
  const wear = equipped.filter(id => !['house', 'garden', 'castle'].includes(id));
  const emo = id => d.shop.find(s => s.id === id)?.emoji;

  return (
    <div className="main">
      <div className="main-head">
        <h2>🐾 {pet.name}</h2>
        <button className="icon-btn" onClick={() => save({ name: prompt('新名字：') || pet.name })}>✏️</button>
        <span style={{ marginLeft: 'auto', fontWeight: 700 }}>🪙 {d.coins}</span>
      </div>
      <div className="main-body">
        <div className="tile" style={{ textAlign: 'center', padding: 24, marginTop: 8,
          background: scene.includes('castle') ? 'linear-gradient(#e3f2fd,#fff)' : scene.includes('garden') ? 'linear-gradient(#e8f5e9,#fff)' : scene.includes('house') ? 'linear-gradient(#fff3e0,#fff)' : undefined }}>
          {scene.length > 0 && <div style={{ fontSize: 34, marginBottom: -14 }}>{scene.map(emo).join(' ')}</div>}
          <PetSprite type={pet.type} equipped={equipped} />
          <div className="muted" style={{ fontSize: 12 }}>點一下寵物跟牠玩</div>
          <div style={{ marginTop: 10 }}>Lv.{level}</div>
          <div style={{ background: '#eef1f4', borderRadius: 6, height: 10, marginTop: 6 }}>
            <div style={{ background: 'var(--primary)', width: `${xp}%`, height: '100%', borderRadius: 6 }} />
          </div>
          <div className="muted" style={{ marginTop: 4 }}>再賺 {100 - xp} 🪙 升級・完成任務+10、習慣打卡+5、番茄鐘+5/25分</div>
        </div>

        <h3 style={{ margin: '18px 0 4px' }}>🛍️ 商店</h3>
        {err && <div className="error">{err}</div>}
        <div className="stat-tiles">
          {d.shop.map(item => {
            const has = owned.includes(item.id);
            const on = equipped.includes(item.id);
            return (
              <div className="tile" key={item.id} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 34 }}>{item.emoji}</div>
                <div>{item.name}</div>
                {has
                  ? <button className={'btn sm' + (on ? '' : ' ghost')} style={{ marginTop: 6 }} onClick={() => toggleEquip(item.id)}>{on ? '已裝備' : '裝備'}</button>
                  : <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => buy(item.id)}>🪙 {item.price}</button>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
