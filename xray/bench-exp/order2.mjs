// Comme order.mjs, mais la distribution (et ses photos) est reprise d'un banc précédent : mêmes entrées à chaque passage.
const J=process.env.JELLYFIN_URL, JH={Authorization:`MediaBrowser Token="${process.env.JELLYFIN_API_KEY}"`};
const prev=JSON.parse(Buffer.from(process.env.XB_CAST,'base64').toString());
const item=process.env.XB_ITEM;
const users=await (await fetch(J+'/Users',{headers:JH})).json();const uid=users.find(u=>u.Policy?.IsAdministrator).Id;
const it=await (await fetch(`${J}/Users/${uid}/Items/${item}?Fields=MediaSources,Path`,{headers:JH})).json();
const ms=it.MediaSources[0];
const body={itemId:item,path:ms.Path,etag:ms.ETag||`size:${ms.Size}`,priority:'normal',startAt:0,seriesId:it.SeriesId||null,cast:prev.cast};
const X='http://'+process.env.XB_HOST+':8000', XH={Authorization:`Bearer ${process.env.XRAY_API_KEY}`,'Content-Type':'application/json'};
const t0=Date.now();
let r;for(let i=0;;i++){try{r=await fetch(X+'/jobs',{method:'POST',headers:XH,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});break}catch(e){if(i>200)throw e;await new Promise(s=>setTimeout(s,15000))}}
console.log(JSON.stringify({orderedAt:t0,status:r.status,resp:await r.json(),path:ms.Path,etag:body.etag,seriesId:body.seriesId,cast:prev.cast}));
