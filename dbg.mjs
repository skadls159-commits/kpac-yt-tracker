
const id='qcMZbH8a5yk';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const r=await fetch('https://www.youtube.com/watch?v='+id+'&hl=ko',{headers:{'User-Agent':UA,'Accept-Language':'ko,en;q=0.8','Cookie':'CONSENT=YES+1; SOCS=CAI'}});
const html=await r.text();
console.log('watch', r.status, html.length, 'hasPR', /ytInitialPlayerResponse/.test(html), 'hasCT', /captionTracks/.test(html), 'consent', /consent\.youtube/.test(html), 'title', (html.match(/<title>([^<]*)/)||[])[1]);
for (const [name, ctx] of [['ANDROID',{clientName:'ANDROID',clientVersion:'19.09.37',androidSdkVersion:30,hl:'ko',gl:'KR'}],['WEB',{clientName:'WEB',clientVersion:'2.20240101.00.00',hl:'ko',gl:'KR'}],['TVHTML5',{clientName:'TVHTML5_SIMPLY_EMBEDDED_PLAYER',clientVersion:'2.0',hl:'ko',gl:'KR'}]]){
  const p=await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':name==='ANDROID'?'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip':UA},body:JSON.stringify({context:{client:ctx},videoId:id,contentCheckOk:true,racyCheckOk:true})});
  const j=await p.json().catch(()=>({}));
  const ct=j?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  console.log(name, p.status, 'status', j?.playabilityStatus?.status, j?.playabilityStatus?.reason||'', 'tracks', ct?ct.map(t=>t.languageCode+(t.kind||'')).join('/'):'none');
  if (ct){ const u=ct[0].baseUrl; const c=await fetch(u+'&fmt=json3',{headers:{'User-Agent':UA}}); const tx=await c.text(); console.log('  caption fetch', c.status, tx.length, tx.slice(0,120).replace(/\n/g,' ')); }
}