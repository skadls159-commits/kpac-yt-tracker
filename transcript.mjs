// 수집 영상 자막(스크립트) 가져오기. 유튜브 공개 자막(자동 생성 포함)만.
import fs from 'node:fs';
const NOW = Math.floor(Date.now() / 1000);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const watch = readJSON('watch.json', {});
const prev = readJSON('prev_tr.json', {});
const out = { v: 1, updated: NOW, items: prev.items || {} };
const want = [...new Set([...(watch.tr || []), ...(watch.pin || [])])].filter(id => !out.items[id] || (out.items[id].err && NOW - out.items[id].at > 3 * 86400));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const dec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n/g, ' ');
async function tracks(id) {
  const r = await fetch('https://www.youtube.com/watch?v=' + id + '&hl=ko', { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' } });
  const html = await r.text();
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) return { tracks: [], blocked: /consent|captcha|unusual traffic/i.test(html) && !/ytInitialPlayerResponse/.test(html) };
  return { tracks: JSON.parse(m[1]) };
}
async function one(id) {
  const { tracks: ts, blocked } = await tracks(id);
  if (blocked) return { err: 'blocked' };
  if (!ts.length) return { err: 'none' };
  const t = ts.find(x => x.languageCode === 'ko' && !x.kind) || ts.find(x => x.languageCode === 'ko') || ts.find(x => !x.kind) || ts[0];
  const r = await fetch(t.baseUrl.replace(/&fmt=\w+/, '') + '&fmt=json3', { headers: { 'User-Agent': UA } });
  if (!r.ok) return { err: 'fetch ' + r.status };
  const j = await r.json();
  const seg = (j.events || []).filter(e => e.segs).map(e => [Math.round((e.tStartMs || 0) / 1000), dec(e.segs.map(s => s.utf8 || '').join('')).trim()]).filter(s => s[1] && s[1] !== '\n');
  if (!seg.length) return { err: 'empty' };
  return { lang: t.languageCode, auto: !!t.kind, seg };
}
let n = 0, ok = 0;
for (const id of want.slice(0, 120)) {
  n++;
  try { const r = await one(id); out.items[id] = { at: NOW, ...r }; if (!r.err) ok++; }
  catch (e) { out.items[id] = { at: NOW, err: String(e.message || e).slice(0, 80) }; }
  await new Promise(s => setTimeout(s, 400));
}
// 400개 넘으면 오래된 것부터 정리 (pin은 유지)
const pin = new Set(watch.pin || []);
const ids = Object.keys(out.items);
if (ids.length > 400) ids.filter(i => !pin.has(i)).sort((a, b) => out.items[a].at - out.items[b].at).slice(0, ids.length - 400).forEach(i => delete out.items[i]);
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/transcripts.json', JSON.stringify(out));
console.log(JSON.stringify({ requested: want.length, tried: n, ok, total: Object.keys(out.items).length }));
