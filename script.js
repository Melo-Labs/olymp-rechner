// Item: [Name, max, Limit, Menge/Zyklus, Dauer(Std), [[Rohstoff, Menge]]]
const CATS=[
{id:"zap",t:"ZAP!",grp:"Drogen",items:[["Roher ZAP!",6405,20,4,1,[ ["Schachtel Pseudoephedrin",8,1350],["Roter Phosphor",4,700],["Aceton",4,1175],["Toluol",4,825],["Luftfilter II",1,2000]]],["ZAP!-Tütchen",6510,20,4,40/60,[ ["Roher ZAP!",4],["Polyethylenfolie",4,65],["Klebeband",4,50]]],["ZAP!-Beutel",32550,4,4,0.5,[ ["ZAP!-Tütchen",20],["Polyethylenfolie",4,65]]],["ZAP!-Container",309750,0,1,0.75,[ ["ZAP!-Beutel",5],["Polyethylenfolie",2,65]]]]},
{id:"poof",t:"POOF",grp:"Drogen",items:[["POOF-Paste",6090,21,4,1.5,[ ["Kokablätter",12,400],["Benzinkanister",4,360],["Phosphorsäure",4,1050],["Wismutsäure",4,1400],["Luftfilter III",1,3150]]],["POOF-Tütchen",6195,21,4,40/60,[ ["POOF-Paste",4],["Klebeband",4,50]]],["Kleines POOF-Päckchen",18480,7,4,0.5,[ ["POOF-Tütchen",12],["Klebeband",4,50]]],["POOF-Beutel",55650,2,4,0.5,[ ["Kleines POOF-Päckchen",12],["Polyethylenfolie",4,65]]],["POOF-Container",609000,0,1,0.75,[ ["POOF-Beutel",5],["Polyethylenfolie",2,65]]]]},
{id:"stank",t:"STANK",grp:"Drogen",items:[["Roher STANK-Busch",420,312,9,2,[ ["STANK-Samen",18],["Dünger I",6,500]]],["STANK-Päckchen",1150,41,12,2,[ ["Roher STANK-Busch",36],["Dünger I",12,500],["Benzinkanister",6,360],["Luftfilter I",12,1350],["Klebeband",12,50],["Drehpapier",12,55]]],["STANK-Block",15750,8,2,0.5,[ ["STANK-Päckchen",10],["Polyethylenfolie",2,65],["Klebeband",2,50]]],["STANK-Container",372750,1,1,0.75,[ ["STANK-Block",5],["Polyethylenfolie",2,65]]]]},
{id:"geld",t:"Falschgeld",items:[
["Falsche Dollar",0.3,595238,12000,0.75,[['Papier I',6,280],['Farbe I',3,420]]],
["Falsche Euro",0.3,694444,36000,2,[['Papier II',6],['Farbe II',3,1341]]],
["Falsche Pfund",0.3,833333,100000,4,[['Papier III',6,2505],['Farbe III',3]]],
["Falsche Franken",0.3,416666,170000,5,[['Papier III',9,2505],['Farbe III',5]]]]},
{id:"docs",t:"Gefälschte Dokumente",items:[["Bündel gefälschter Ausweise",1680,250,2,27/60,[ ["Papier I",2,280],["Farbe I",1,420]]],["Akte einer Scheinfirma",6615,56,2,81/60,[ ["Papier II",3],["Farbe II",2,1341]]],["Notarielle Akte",43365,8,1,162/60,[ ["Papier III",4,2505],["Farbe III",2]]],["Offshore-Portfolio",30240,4,1,216/60,[ ["Papier III",8,2505],["Farbe III",4]]]]}];
const KEY="produktionsrechner-v2";
const LAB_UPGRADES={
equipment:{title:"Ausrüstung",levels:[{label:"Keine Stufe",reduction:0},{label:"Zyklus 10 % kürzer · Zelle 24 Std.",reduction:0.1},{label:"Zyklus 20 % kürzer · Zelle 72 Std.",reduction:0.2},{label:"Zyklus 30 % kürzer · Zelle 168 Std.",reduction:0.3}]},
autonomy:{title:"Autonomie",levels:[{label:"Keine Stufe"},{label:"Ladung +8 Std. · Zelle 24 Std."},{label:"Ladung +16 Std. · Zelle 72 Std."},{label:"Ladung +24 Std. · Zelle 168 Std."}]},
storage:{title:"Speicher",levels:[{label:"Keine Stufe"},{label:"25 % größer · Zelle 24 Std."},{label:"50 % größer · Zelle 72 Std."},{label:"100 % größer · Zelle 168 Std."}]}
};
function fresh(){const s={hrs:24,chainEnabled:false,upgrades:{equipment:0,autonomy:0,storage:0},P:{}};CATS.forEach(c=>c.items.forEach((it,i)=>{s.P[c.id+i]={price:it[1],q:it[3]??1,h:it[4]??1,m:(it[5]||[]).map(r=>({n:r[0],a:r[1],p:Number(r[2])||0}))}}));return s}
let S=fresh();
try{const s=JSON.parse(localStorage.getItem(KEY)||"null");if(s&&s.P){S.hrs=s.hrs||24;if(typeof s.chainEnabled==="boolean")S.chainEnabled=s.chainEnabled;Object.assign(S.upgrades,s.upgrades||{});for(const k in s.P)if(s.P[k]&&Array.isArray(s.P[k].m))S.P[k]=s.P[k]}}catch(e){}
let page="geld";try{const h=location.hash.slice(1);if(CATS.some(c=>c.id===h))page=h}catch(e){}
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=(v,d=0)=>isFinite(v)?v.toLocaleString("de-DE",{minimumFractionDigits:d,maximumFractionDigits:d}):"–";
const money=v=>fmt(v,Math.abs(v)<100&&Math.round(v*100)%100!==0?2:0)+" $";
const duration=h=>{const total=Math.round(h*60),hours=Math.floor(total/60),minutes=total%60;return [hours?`${hours} Std.`:"",minutes?`${minutes} Min.`:""].filter(Boolean).join(" ")||"0 Min."};
const cycleFactor=()=>1-(LAB_UPGRADES.equipment.levels[S.upgrades.equipment]?.reduction||0);
const cls=v=>v>=0?"pos":"neg";
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}};
const cur=()=>CATS.find(c=>c.id===page);
function productId(name){for(const c of CATS){const i=c.items.findIndex(it=>it[0]===name);if(i>=0&&c.items[i][5]?.length)return c.id+i}return null}
function itemUnitCost(id,stack=new Set()){
const p=S.P[id];if(!p?.m?.length||stack.has(id))return 0;
stack.add(id);const cost=p.m.reduce((sum,r)=>sum+(Number(r.a)||0)*materialUnitCost(r,stack),0);stack.delete(id);
return cost/(Number(p.q)||1);
}
function materialUnitCost(r,stack=new Set()){
const id=productId(r.n);return id&&!stack.has(id)?itemUnitCost(id,stack):(Number(r.p)||0);
}
const productionUtils=window.ProductionUtils;
function productionProducts(){
const products={};
for(const c of CATS)for(let index=0;index<c.items.length;index++){
const id=c.id+index,p=S.P[id];
products[id]={name:c.items[index][0],price:Number(p.price),quantityPerCycle:Number(p.q),cycleHours:Number(p.h)*cycleFactor(),materials:(p.m||[]).map(material=>({name:material.n,quantity:Number(material.a)||0,productId:productId(material.n),unitCost:materialUnitCost(material)}))};
}
return products;
}
function selfProductionSummary(category){
const products=productionProducts();
const categoryIds=category.items.map((_,index)=>category.id+index);
const runs=productionUtils.terminalProductIds(products,categoryIds).map(id=>{
const product=products[id],result=productionUtils.calculateProductionRun(products,id);
if(result.error)return{error:result.error};
const revenue=product.price*product.quantityPerCycle;
if(!Number.isFinite(revenue))return{error:"Der Verkaufserlös kann nicht berechnet werden."};
return{id,name:product.name,quantity:product.quantityPerCycle,revenue,cost:result.cost,profit:revenue-result.cost,hours:result.hours,chain:result.chain,missing:result.missing};
});
const failed=runs.find(run=>run.error);
if(failed)return`<h2>Eigenproduktion</h2><p class="chain-warning" role="status">${esc(failed.error)}</p>`;
const totalHours=runs.reduce((sum,run)=>sum+run.hours,0),totalProfit=runs.reduce((sum,run)=>sum+run.profit,0),profitPerHour=totalHours>0?totalProfit/totalHours:0;
const missing=[...new Set(runs.flatMap(run=>run.missing))];
return`<h2>Eigenproduktion · ${esc(category.t)}</h2>
<p class="chain-copy">Vom Rohstoff bis zum Endprodukt. Vorprodukte werden in vollständigen Zyklen selbst hergestellt und nacheinander produziert. Pro Endprodukt wird eine Charge gerechnet; Produktionsreste bleiben auf Lager und werden nicht als Verkauf gezählt. Die Hochrechnung setzt durchgehende Produktion und Verkauf zum eingetragenen Maximalpreis voraus.</p>
<div class="chain-summary">
<div class="chain-stat"><span>Gesamtdauer des Laufs</span><strong>${duration(totalHours)}</strong></div>
<div class="chain-stat"><span>Gewinn pro Lauf</span><strong class="${cls(totalProfit)}">${money(totalProfit)}</strong></div>
<div class="chain-stat"><span>Gewinn / Stunde</span><strong class="${cls(profitPerHour)}">${money(profitPerHour)}</strong></div>
<div class="chain-stat"><span>Gewinn / Tag · 24 Std.</span><strong class="${cls(profitPerHour*24)}">${money(profitPerHour*24)}</strong></div>
<div class="chain-stat"><span>Gewinn / Woche · 168 Std.</span><strong class="${cls(profitPerHour*168)}">${money(profitPerHour*168)}</strong></div>
<div class="chain-stat"><span>Gewinn / 30 Tage · 720 Std.</span><strong class="${cls(profitPerHour*720)}">${money(profitPerHour*720)}</strong></div>
</div>
<div class="chain-runs">${runs.map(run=>`<article class="chain-run"><h3>${esc(run.name)}</h3><p class="chain-path">Rohstoffe → ${run.chain.map(esc).join(" → ")}</p><div class="kv"><span>Menge je Endprodukt-Charge</span><span>${fmt(run.quantity)}</span><span>Dauer der Kette</span><span>${duration(run.hours)}</span><span>Umsatz</span><span>${money(run.revenue)}</span><span>Kosten aller Produktionsstufen</span><span>${money(run.cost)}</span><span>Gewinn pro Charge</span><span class="${cls(run.profit)}">${money(run.profit)}</span></div></article>`).join("")}</div>
${missing.length?`<p class="chain-warning" role="status">Für ${missing.map(esc).join(", ")} ist aktuell kein Preis hinterlegt. Diese Rohstoffe werden mit 0 $ gerechnet; die Gewinnschätzung kann dadurch zu hoch sein.</p>`:""}`;
}

function nav(){
const g=a=>a.map(c=>`<a href="#${c.id}" data-nav="${c.id}" class="${c.id===page?"on":""}">${c.t}</a>`).join("");
const droga = CATS.filter(c => c.grp === "Drogen").map(c => ({id:c.id,t:c.t}));
const weiter = CATS.filter(c => !c.grp).map(c => ({id:c.id,t:c.t}));
$("nav").innerHTML = `
  <div class="group">
    <div class="grp">Drogen</div>
    <div class="sub">${g(droga)}</div>
  </div>
  <div class="group">
    <div class="grp">Produktion</div>
    <div class="sub">${g(weiter)}</div>
  </div>
`;
}
function card(c,it,i){
const id=c.id+i,p=S.P[id];
return `<article class="card" id="c-${id}"><span class="tag">BESTE</span>
<div><h3>${esc(it[0])}</h3><div class="meta">Limit ${fmt(it[2])} · max ${money(it[1])}${it[3]===undefined?" · Menge/Dauer nicht hinterlegt":""}</div></div>
<div class="mats"><div><label>Verkaufspreis ($)</label><output class="fixed-value">${money(p.price)}</output></div><div><label>Menge / Zyklus</label><output class="fixed-value">${fmt(p.q)}</output></div><div><label>Dauer</label><output class="fixed-value">${duration(p.h*cycleFactor())}</output></div></div>
<div class="lbl">Rohstoffe pro Zyklus</div>
${p.m.length?`<div class="mrow-head"><span>Rohstoff</span><span>Menge</span><span>Preis/Stk.</span></div>
${p.m.map((r,j)=>{const inherited=productId(r.n)!==null;return `<div class="mrow"><span class="fixed-material">${esc(r.n)}</span><span class="fixed-material amount">${fmt(Number(r.a)||0)}</span><input type="number" min="0" step="any" data-id="${id}" data-j="${j}" data-f="p" value="${materialUnitCost(r)}" placeholder="Preis" ${r.fixed||inherited?`readonly title="${inherited?"Aus Produktionskosten berechnet":"Festpreis, nicht änderbar"}" aria-label="${inherited?"Berechneter Preis für":"Festpreis für"} ${esc(r.n)}"`:""}></div>`}).join("")}`:`<div class="note">Rohstoffdaten noch nicht hinterlegt.</div>`}
<div id="res-${id}"></div></article>`;
}
function render(){
const c=cur();$("ttl").textContent=(c.grp?c.grp+" · ":"")+c.t;nav();
for (const [idx, item] of c.items.entries()) {
  const key = c.id + idx;
  if (!S.P[key]) S.P[key] = { price: item[1], q: item[3] ?? 1, h: item[4] ?? 1, m: [] };
  const existing = Array.isArray(S.P[key].m) ? S.P[key].m : [];
  S.P[key].m = (item[5] || []).map((r, i) => ({
    n: r[0],
    a: Number(r[1]) || 0,
    p: r[2] != null ? Number(r[2]) : (Number(existing.find(x => x.n === r[0])?.p) || 0),
    fixed: r[2] != null
  }));
  S.P[key].price = item[1];
  if (item[3] != null) S.P[key].q = item[3];
  if (item[4] != null) S.P[key].h = item[4];
}
const upgradePanel=`<details class="panel upgrades"><summary>Labor-Upgrades</summary><div class="upgrade-grid">${Object.entries(LAB_UPGRADES).map(([key,upgrade])=>`<label class="upgrade-control"><span>${upgrade.title}</span><select data-upgrade="${key}" aria-label="${upgrade.title}">${upgrade.levels.map((level,index)=>`<option value="${index}" ${S.upgrades[key]===index?"selected":""}>${level.label}</option>`).join("")}</select></label>`).join("")}</div></details>`;
$("view").innerHTML=upgradePanel+`<section class="panel"><div class="lbl">Verkaufspreise: Maximalpreis · Hochrechnung: ${fmt(S.hrs)} Std.</div><div class="btns"><button id="chain-toggle" class="primary chain-toggle" type="button" aria-controls="chain-forecast" aria-pressed="${S.chainEnabled}">${S.chainEnabled?"Eigenproduktion ausblenden":"Eigenproduktion berechnen"}</button></div></section>
<section class="panel chain-forecast" id="chain-forecast" ${S.chainEnabled?"":"hidden"}></section>
<section class="panel best-box" id="best"></section><section class="cards">${c.items.map((it,i)=>card(c,it,i)).join("")}</section>`;
calc();
}
function calc(){
const c=cur(),H=S.hrs||1;
const R=c.items.map((it,i)=>{const id=c.id+i,p=S.P[id],h=(p.h||0.01)*cycleFactor(),rev=p.q*p.price,cost=p.m.reduce((s,r)=>s+(Number(r.a)||0)*materialUnitCost(r),0),prof=rev-cost;return{id,it,p,rev,cost,prof,ph:prof/h,pz:prof/h*H,h:p.h}});
const best=R.reduce((a,b)=>b.ph>a.ph?b:a,R[0]),mx=Math.max(...R.map(r=>r.ph),1);
R.forEach(r=>{
$("c-"+r.id).classList.toggle("best",r===best&&R.length>1);
$("c-"+r.id).querySelectorAll('input[data-f="p"]').forEach((input,j)=>{input.value=materialUnitCost(r.p.m[j]);input.readOnly=!!r.p.m[j].fixed||productId(r.p.m[j].n)!==null});
const tot=r.p.m.reduce((s,x)=>s+(x.a||0),0);
let be=`Max. Kosten / Zyklus: <b>${money(r.rev)}</b>`;
if(tot>0)be+=`<br>Max. Ø je Rohstoff-Einheit: <b>${money(r.rev/tot)}</b>`;
r.p.m.forEach(x=>{if(x.n&&x.a>0)be+=`<br>Max. ${esc(x.n)}: <b>${money((r.rev-r.cost+x.a*materialUnitCost(x))/x.a)}</b>`});
$("res-"+r.id).innerHTML=`<div><div class="hero"><small>Gewinn / Std.</small><span class="${cls(r.ph)}">${money(r.ph)}</span></div><div class="bar"><i style="width:${Math.max(0,r.ph/mx*100)}%"></i></div></div>
<div class="kv"><span>Umsatz / Zyklus</span><span>${money(r.rev)}</span><span>Kosten / Zyklus</span><span>${money(r.cost)}</span><span>Gewinn / Zyklus</span><span class="${cls(r.prof)}">${money(r.prof)}</span><span>Gewinn / ${fmt(H)} Std.</span><span class="${cls(r.pz)}">${money(r.pz)}</span></div>
<div class="be"><div class="lbl">Break-even (übrige Preise wie eingetragen)</div>${be}</div>`;
});
$("best").innerHTML=`<div><div class="lbl">Lohnt sich am meisten</div><div class="big">${esc(best.it[0])}</div></div>
<div><div class="lbl">Gewinn / Std.</div><div class="big ${cls(best.ph)}">${money(best.ph)}</div></div>
<div><div class="lbl">Gewinn / ${fmt(H)} Std.</div><div class="big ${cls(best.pz)}">${money(best.pz)}</div></div>
<div><div class="lbl">Gewinn / Zyklus</div><div class="big">${money(best.prof)}</div></div>`;
const chainToggle=$("chain-toggle"),chainForecast=$("chain-forecast");
chainToggle.setAttribute("aria-pressed",String(S.chainEnabled));
chainToggle.textContent=S.chainEnabled?"Eigenproduktion ausblenden":"Eigenproduktion berechnen";
chainForecast.hidden=!S.chainEnabled;
if(S.chainEnabled)chainForecast.innerHTML=selfProductionSummary(c);
}
document.addEventListener("input",e=>{
const t=e.target,v=parseFloat(t.value)||0;
if(t.dataset.f){
  const p=S.P[t.dataset.id];
  if(t.dataset.j!==undefined){
    if(t.dataset.f==="p") p.m[t.dataset.j].p=v;
  } else {
    p[t.dataset.f]=v;
  }
} else return;
save();calc();
});
document.addEventListener("change",e=>{
const t=e.target;
if(t.dataset.upgrade===undefined)return;
S.upgrades[t.dataset.upgrade]=Number(t.value)||0;save();render();
});
document.addEventListener("click",e=>{
const b=e.target.closest("[data-nav],#burger,#ov,#chain-toggle");if(!b)return;
const d=b.dataset;
if(b.id==="chain-toggle"){S.chainEnabled=!S.chainEnabled;save();calc();return}
if(b.id==="burger"){document.body.classList.toggle("open");return}
if(b.id==="ov"){document.body.classList.remove("open");return}
if(d.nav){e.preventDefault();page=d.nav;try{history.replaceState(null,"","#"+page)}catch(x){}document.body.classList.remove("open");render();window.scrollTo(0,0);return}
});
document.addEventListener("contextmenu",e=>e.preventDefault());
document.addEventListener("keydown",e=>{
const key=e.key.toLowerCase();
if(key==="f12"||((e.ctrlKey||e.metaKey)&&(key==="u"||(e.shiftKey&&["i","j","c"].includes(key)))))e.preventDefault();
});
render();
