// Attend la fin d'un ordre ; résiste à un service momentanément muet (conteneur en pause).
const X='http://'+process.env.XB_HOST+':8000', XH={Authorization:`Bearer ${process.env.XRAY_API_KEY}`};
const item=process.env.XB_ITEM;const t0=Date.now();
const get=async u=>{for(;;){try{return await (await fetch(u,{headers:XH,signal:AbortSignal.timeout(30000)})).json()}catch(e){console.log(new Date().toISOString(),'injoignable',e.cause?.code||e.name);await new Promise(s=>setTimeout(s,15000))}}};
for(;;){const r=await get(`${X}/items/${item}`);
console.log(new Date().toISOString(),((Date.now()-t0)/1000).toFixed(0),r.status,r.progress,r.analyzedUntil,r.error||'');
if(r.status==='done'||r.status==='failed'){console.log('ITEM '+JSON.stringify(r));break}await new Promise(s=>setTimeout(s,10000))}
const s=await get(`${X}/items/${item}/scenes`);
console.log('SCENES '+JSON.stringify(s));
