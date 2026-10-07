// KPAC 영상 리서치 자동 수집기 (GitHub Actions, Node 20, 의존성 없음)
// - 추적 영상 조회수 2시간마다 기록 -> 노출 확률 / 성장 그래프
// - 유튜브 인기(급상승) 목록 날짜별 저장 -> 핫 비디오
// - 키워드별 신규·인기 영상 발굴 (하루 1번)
// - 레퍼런스 채널 최신 영상 (구독 피드)
import fs from 'node:fs';

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error('YT_API_KEY missing'); process.exit(1); }
const FORCE = (process.env.FORCE_DISCOVER || '') === 'yes';
const NOW = Math.floor(Date.now() / 1000);
const HOUR = Math.floor(NOW / 3600);
const DAY = 86400;
const MAX_TRACK = 6000;
const units = { other: 0, search: 0 };
let quotaHit = false;

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const prev = readJSON('prev.json', {});
const prevHot = readJSON('prev_hot.json', {});
const watch = readJSON('watch.json', {});

const db = {
  v: 1, updated: NOW,
  lastDiscover: prev.lastDiscover || 0, lastHot: prev.lastHot || 0, lastChRefresh: prev.lastChRefresh || 0,
  videos: prev.videos || {}, channels: prev.channels || {}, log: prev.log || []
};
const hot = { days: prevHot.days || {}, cats: prevHot.cats || {} };

const kstDate = (sec) => new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 10);
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const isoSec = (d) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || ''); if (!m) return 0; return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };

async function api(path, params, isSearch = false) {
  if (quotaHit) return null;
  const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  u.searchParams.set('key', KEY);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(u).catch(() => null);
    if (isSearch) units.search++; else units.other++;
    if (!r) { await new Promise(s => setTimeout(s, 1500)); continue; }
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    const reason = j?.error?.errors?.[0]?.reason || '';
    if (/quota|rateLimit/i.test(reason)) { quotaHit = true; console.log('QUOTA', path, reason); return null; }
    if (r.status >= 500) { await new Promise(s => setTimeout(s, 2000)); continue; }
    console.log('API error', path, r.status, reason);
    return null;
  }
  return null;
}
async function pool(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }; await Promise.all(Array.from({ length: n }, run)); }

function addPoint(v, views) {
  const s = v.s || (v.s = []);
  const last = s[s.length - 1];
  if (last && last[0] === HOUR) last[1] = views; else s.push([HOUR, views]);
  // 36시간 이내는 전부(1시간 단위), 그 이전은 하루 1개만
  const cut = HOUR - 36; const out = []; const seenDay = new Set();
  for (const p of s) {
    if (p[0] >= cut) { out.push(p); continue; }
    const d = Math.floor(p[0] / 24); if (seenDay.has(d)) { out[out.length - 1] = p; continue; } seenDay.add(d); out.push(p);
  }
  v.s = out.slice(-80);
}
function track(id, src, until, extra = {}) {
  const v = db.videos[id] || (db.videos[id] = { s: [], src: '', until: 0 });
  if (!v.src.includes(src)) v.src += src;
  v.until = Math.max(v.until || 0, until);
  Object.assign(v, extra);
  return v;
}

// 새 영상 메타 + 현재 조회수
async function hydrate(ids) {
  const fresh = [];
  for (const part of chunk(ids, 50)) {
    const j = await api('videos', { part: 'snippet,statistics,contentDetails', id: part.join(','), maxResults: 50 });
    for (const it of j?.items || []) fresh.push(it);
  }
  for (const it of fresh) {
    const v = db.videos[it.id]; if (!v) continue;
    v.t = it.snippet.title; v.c = it.snippet.channelId; v.p = Math.floor(new Date(it.snippet.publishedAt) / 1000);
    v.d = isoSec(it.contentDetails?.duration); v.cat = it.snippet.categoryId; v.cc = it.contentDetails?.caption === 'true' ? 1 : 0;
    v.l = it.statistics.likeCount != null ? +it.statistics.likeCount : null; v.m = it.statistics.commentCount != null ? +it.statistics.commentCount : null;
    addPoint(v, +(it.statistics.viewCount || 0));
  }
  return fresh;
}

async function main() {
  const t0 = Date.now();
  const pinned = new Set(watch.pin || []);
  const refCh = (watch.channels || []).slice(0, 100);
  const keywords = (watch.keywords || []).slice(0, 30);

  // 1) 앱이 보낸 추적 요청
  for (const id of pinned) track(id, 'p', NOW + 3650 * DAY);
  for (const [id, until] of (watch.temp || [])) if (until > NOW) track(id, 'w', until);

  // 2) 레퍼런스 채널 최신 영상 (2시간마다)
  const newIds = new Set();
  await pool(HOUR % 2 === 0 || FORCE ? refCh : [], 6, async (ch) => {
    const c = db.channels[ch]; const up = c?.up || ('UU' + ch.slice(2));
    const j = await api('playlistItems', { part: 'contentDetails', playlistId: up, maxResults: 15 });
    for (const it of j?.items || []) {
      const id = it.contentDetails.videoId; const pub = Math.floor(new Date(it.contentDetails.videoPublishedAt || 0) / 1000);
      if (pub && NOW - pub > 30 * DAY) continue;
      if (!db.videos[id]) newIds.add(id);
      track(id, 'c', (pub || NOW) + 14 * DAY);
    }
  });

  // 3) 핫 비디오: 유튜브 인기 목록 (6시간마다)
  if (NOW - db.lastHot > 5.5 * 3600 || FORCE) {
    let cats = hot.cats && Object.keys(hot.cats).length ? hot.cats : null;
    if (!cats || NOW - (hot.catsAt || 0) > 7 * DAY) {
      const j = await api('videoCategories', { part: 'snippet', regionCode: 'KR', hl: 'ko' });
      cats = {}; for (const c of j?.items || []) if (c.snippet.assignable) cats[c.id] = c.snippet.title;
      hot.cats = cats; hot.catsAt = NOW;
    }
    const today = kstDate(NOW); const day = hot.days[today] || (hot.days[today] = {});
    const catIds = ['0', ...Object.keys(cats)];
    await pool(catIds, 4, async (cat) => {
      let token; for (let p = 0; p < 4; p++) {
        const j = await api('videos', { part: 'snippet,statistics,contentDetails', chart: 'mostPopular', regionCode: 'KR', videoCategoryId: cat === '0' ? undefined : cat, maxResults: 50, pageToken: token });
        if (!j) break;
        for (const it of j.items || []) {
          const pub = Math.floor(new Date(it.snippet.publishedAt) / 1000);
          const views = +(it.statistics.viewCount || 0);
          const prevE = day[it.id];
          day[it.id] = [it.snippet.title, it.snippet.channelId, pub, Math.max(views, prevE ? prevE[3] : 0), isoSec(it.contentDetails?.duration), it.snippet.categoryId, it.statistics.likeCount != null ? +it.statistics.likeCount : -1, it.statistics.commentCount != null ? +it.statistics.commentCount : -1];
          const v = track(it.id, 'h', NOW + 3 * DAY, { t: it.snippet.title, c: it.snippet.channelId, p: pub, d: isoSec(it.contentDetails?.duration), cat: it.snippet.categoryId, cc: it.contentDetails?.caption === 'true' ? 1 : 0, l: it.statistics.likeCount != null ? +it.statistics.likeCount : null, m: it.statistics.commentCount != null ? +it.statistics.commentCount : null });
          addPoint(v, views);
        }
        token = j.nextPageToken; if (!token) break;
      }
    });
    db.lastHot = NOW;
    const keepDays = Object.keys(hot.days).sort().slice(-7); for (const d of Object.keys(hot.days)) if (!keepDays.includes(d)) delete hot.days[d];
  }

  // 4) 키워드 발굴 (하루 1번)
  if (keywords.length && (NOW - db.lastDiscover > 20 * 3600 || FORCE)) {
    const after3 = new Date((NOW - 3 * DAY) * 1000).toISOString();
    const after30 = new Date((NOW - 30 * DAY) * 1000).toISOString();
    const after7 = new Date((NOW - 7 * DAY) * 1000).toISOString();
    for (const k of keywords) {
      const q = typeof k === 'string' ? k : k.q; const mode = (typeof k === 'object' && k.mode) || 'topic';
      const runs = mode === 'struct' ? [{ order: 'viewCount', publishedAfter: after7 }] : [{ order: 'date', publishedAfter: after3 }, { order: 'viewCount', publishedAfter: after30 }];
      for (const r of runs) {
        const j = await api('search', { part: 'snippet', type: 'video', q, maxResults: 50, regionCode: 'KR', relevanceLanguage: 'ko', ...r }, true);
        for (const it of j?.items || []) { const id = it.id?.videoId; if (!id) continue; if (!db.videos[id]) newIds.add(id); track(id, 'k', NOW + 10 * DAY, { kw: db.videos[id]?.kw || q }); }
      }
    }
    db.lastDiscover = NOW;
  }

  // 5) 새 영상 메타
  const needMeta = Object.keys(db.videos).filter(id => !db.videos[id].t || newIds.has(id));
  await hydrate(needMeta);

  // 6) 추적 정리 + 조회수 갱신
  for (const [id, v] of Object.entries(db.videos)) {
    if (pinned.has(id)) continue;
    if (v.src === 'h' && v.until < NOW) { delete db.videos[id]; continue; }
    if (v.until < NOW) delete db.videos[id];
  }
  let ids = Object.keys(db.videos);
  if (ids.length > MAX_TRACK) {
    const score = (id) => { const v = db.videos[id]; if (pinned.has(id)) return 1e12; const s = v.s || []; const g = s.length > 1 ? s[s.length - 1][1] - s[0][1] : 0; return (v.src.includes('w') ? 1e9 : 0) + (v.src.includes('c') ? 5e8 : 0) + g; };
    ids.sort((a, b) => score(b) - score(a)); for (const id of ids.slice(MAX_TRACK)) delete db.videos[id]; ids = ids.slice(0, MAX_TRACK);
  }
  const doneNow = new Set(needMeta);
  // 게시 7일 이내·수집 영상은 매시간, 그 외는 3시간마다
  const refresh = ids.filter(id => { const v = db.videos[id]; if (doneNow.has(id) || v.s?.[v.s.length - 1]?.[0] === HOUR) return false;
    const young = v.p && NOW - v.p < 7 * DAY; return young || pinned.has(id) || HOUR % 3 === 0 || FORCE; });
  await pool(chunk(refresh, 50), 6, async (part) => {
    const j = await api('videos', { part: 'statistics', id: part.join(','), maxResults: 50 });
    for (const it of j?.items || []) { const v = db.videos[it.id]; if (!v) continue; addPoint(v, +(it.statistics.viewCount || 0)); v.l = it.statistics.likeCount != null ? +it.statistics.likeCount : v.l; v.m = it.statistics.commentCount != null ? +it.statistics.commentCount : v.m; }
  });
  // 노출이 좋은 발굴 영상은 추적 연장
  for (const v of Object.values(db.videos)) {
    const s = v.s || []; if (s.length < 2 || !v.src.includes('k')) continue;
    const a = s[s.length - 1], b = s.find(p => p[0] >= a[0] - 30) || s[0];
    if (a[1] - b[1] > 2000) v.until = Math.max(v.until, NOW + 5 * DAY);
  }

  // 7) 채널 정보 (새 채널 즉시, 전체는 하루 1번)
  const chNeeded = new Set([...refCh]);
  for (const v of Object.values(db.videos)) if (v.c) chNeeded.add(v.c);
  for (const d of Object.values(hot.days)) for (const e of Object.values(d)) chNeeded.add(e[1]);
  const fullRefresh = NOW - db.lastChRefresh > 20 * 3600;
  const chIds = [...chNeeded].filter(id => fullRefresh || !db.channels[id]);
  await pool(chunk(chIds, 50), 6, async (part) => {
    const j = await api('channels', { part: 'snippet,statistics,contentDetails', id: part.join(','), maxResults: 50 });
    for (const c of j?.items || []) {
      const o = db.channels[c.id] || (db.channels[c.id] = { ss: [] });
      o.t = c.snippet.title; o.th = c.snippet.thumbnails?.default?.url || ''; o.h = c.snippet.customUrl || '';
      o.su = c.statistics.hiddenSubscriberCount ? null : +(c.statistics.subscriberCount || 0);
      o.vc = +(c.statistics.videoCount || 0); o.vw = +(c.statistics.viewCount || 0);
      o.cr = Math.floor(new Date(c.snippet.publishedAt) / 1000); o.up = c.contentDetails?.relatedPlaylists?.uploads || ''; o.at = NOW;
      o.co = c.snippet.country || '';
      const dd = Math.floor(NOW / DAY); const last = o.ss[o.ss.length - 1];
      if (o.su != null) { if (last && last[0] === dd) last[1] = o.su; else o.ss.push([dd, o.su]); o.ss = o.ss.slice(-60); }
    }
  });
  if (fullRefresh && !quotaHit) db.lastChRefresh = NOW;
  for (const id of Object.keys(db.channels)) if (!chNeeded.has(id)) delete db.channels[id];

  db.log = [{ at: NOW, tracked: Object.keys(db.videos).length, channels: Object.keys(db.channels).length, units: units.other, search: units.search, quota: quotaHit, sec: Math.round((Date.now() - t0) / 1000) }, ...db.log].slice(0, 30);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/yt_data.json', JSON.stringify(db));
  fs.writeFileSync('out/hot.json', JSON.stringify(hot));
  console.log(JSON.stringify(db.log[0]));
}
main().catch(e => { console.error(e); process.exit(1); });
