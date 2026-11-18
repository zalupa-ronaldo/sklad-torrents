"use strict";

const modules = [
  ["overview","Диспетчер","LayoutDashboard","Диски, файлы и обработка в локальной сети."],
  ["drives","Все файлы","HardDrive","Поиск по снимкам подключённых дисков и носителей на полке."],
  ["torrents","Торренты","ArrowDownUp",pages.torrents[2]],
  ["scheduler","Планировщик","Clock3","Одна активная загрузка на физический диск. Остальные ждут своего слота."],
  ["jobs","Задания","ListChecks","Ход операций на Mac mini и Windows PC."],
  ["games","Игровая полка","Gamepad2","Библиотека по платформам и подготовка игр с HDD на игровой SSD."],
  ["move","Перенос и копирование","ArrowDownUp","Выберите источник и назначение в каталоге."],
  ["integrity","Проверка SHA-256","Check","Манифесты файлов и сверка двух копий."],
  ["index","Индекс файлов","Database","Снимки NTFS и обход папок на Mac. Поиск доступен и без подключения носителя."],
  ["localsend","LocalSend","Network","Передача файлов между устройствами домашней сети."],
  ["optical","Оптические диски","Disc3","Сборка ISO, запись и проверка дисков, рисунок на поверхности."],
  ["policies","Правила раскладки","Layers3","Назначение диска, папки и обработки по типу контента."]
];
const navGroups = [[0,"Рабочее пространство"],[5,"Библиотека и инструменты"],[9,"Сеть и автоматика"]];
$("module-nav").innerHTML = modules.map(([id,label,symbol,desc],i) => {
  pages[id] = [label,id === "overview" ? "Диспетчер склада" : label,desc];
  const group = navGroups.find(g => g[0] === i);
  return (group ? '<p class="caption">' + group[1] + '</p>' : "") +
    `<button data-page="${id}">${icon(symbol)}${label}${id === "torrents" ? '<span id="nav-count" class="count"></span>' : ""}</button>`;
}).join("");

const disks = [
  {id:"archive",kind:"HDD",name:"Archive HDD",host:"Windows PC",fs:"NTFS",mount:"D:/",role:"Холодный архив",used:4380,total:8000,tint:"moss"},
  {id:"pool",kind:"SSD",name:"Game SSD",host:"Windows PC",fs:"NTFS",mount:"C:/",role:"Игровой пул",used:708,total:1000,tint:"amber"},
  {id:"vault",kind:"SSD",name:"Vault SSD",host:"Mac mini",fs:"APFS",mount:"/Volumes/vault/",role:"Временная обработка",used:1222,total:2000,tint:"aqua"},
  {id:"media",kind:"HDD",name:"Media HDD",host:"Windows PC",fs:"NTFS",mount:"S:/",role:"Медиатека",used:2410,total:4000,tint:"slate"},
  {id:"data",kind:"SSD",name:"Data SSD",host:"Mac mini",fs:"APFS",mount:"/System/Volumes/Data/",role:"Временная обработка",used:707,total:1000,tint:"aqua"},
  {id:"dvd",kind:"Оптика",name:"Архив № 07",host:"Windows PC",fs:"UDF",mount:"",role:"Полка · коробка 2",used:4.1,total:4.7,tint:"violet",offline:true}
];
// Each fixture is a physical carrier with a stable identity independent of its mount.
const collections = [
  ["HDD", "Архив", 12, 4000, "NTFS", "moss"],
  ["USB", "Флешка", 5, 64, "exFAT", "amber"],
  ["SD", "Камера SD", 4, 128, "exFAT", "aqua"],
  ["Оптика", "Диск", 5, 4.7, "UDF", "violet"]
];
for (const [kind, label, count, capacity, fs, tint] of collections) {
  for (let n=1; n<=count; n++) {
    const online = kind !== "Оптика" && n === 1;
    const host = kind === "HDD" ? "Windows PC" : "Mac mini";
    const optical = ["DVD-R","CD-R","BD-R","DVD-R","CD-R"];
    const name = (kind==="Оптика"?optical[n-1]:label) + " " + String(n).padStart(2,"0");
    const total = kind==="Оптика"?({"CD-R":.734,"DVD-R":4.7,"BD-R":25}[optical[n-1]]):capacity;
    disks.push({id:kind+"-"+n,kind,name,fs,tint,host,offline:!online,
      role:online ? "Подключён" : (kind==="HDD"?"Стеллаж A · ячейка ":kind==="Оптика"?"Альбом · карман ":"Органайзер · слот ")+n,
      mount:online ? (host==="Mac mini"?"/Volumes/"+name+"/":"T:/") : "",
      total,used:Math.round(total*(.28+(n%5)*.1)*100)/100});
  }
}
const disk = id => disks.find(d => d.id === id);
const catalog = [
  {id:"hades",name:"Hades",dir:"Games/",disk:"archive",type:"Игра",size:11.1,platform:"Windows",expectedSaving:.24},
  {id:"gothic",name:"Gothic II",dir:"Games/",disk:"archive",type:"Игра",size:3.6,platform:"Windows"},
  {id:"zelda",name:"Breath of the Wild",dir:"Switch/",disk:"archive",type:"Игра",size:14.4,platform:"Switch"},
  {id:"gow",name:"Chains of Olympus",dir:"PSP/",disk:"archive",type:"Игра",size:1.5,platform:"PSP"},
  {id:"hollow",name:"Hollow Knight.app",dir:"Games/",disk:"data",type:"Игра",size:7.8,platform:"macOS"},
  {id:"film",name:"Sintel.mkv",dir:"Movies/",disk:"media",type:"Видео",size:3.5},
  {id:"trailer",name:"Spring.mkv",dir:"Movies/",disk:"vault",type:"Видео",size:1.1},
  {id:"osm",name:"OpenStreetMap · Europe",dir:"Maps/",disk:"archive",type:"Данные",size:31.6,torrent:2},
  {id:"blend",name:"Blender Demo Files",dir:"Downloads/",disk:"vault",type:"Архив",size:8.4,torrent:3},
  {id:"debian",name:"Debian 13 · netinst",dir:"ISO/",disk:"media",type:"Образ",size:.784,torrent:5},
  {id:"offline",name:"Концерт.flac",dir:"Audio/",disk:"dvd",type:"Музыка",size:.48},
  {id:"book",name:"Каталог.pdf",dir:"Documents/",disk:"dvd",type:"Документ",size:.024}
];
for (const [source, targets] of [
  ["film", ["HDD-2","USB-1","Оптика-1"]], ["hades", ["HDD-5","HDD-11"]],
  ["trailer", ["SD-2","USB-3"]], ["book", ["SD-1","USB-4","Оптика-4"]]
]) {
  const f=catalog.find(item=>item.id===source);
  for (const target of targets) catalog.push({...f,id:source+"-"+target,content:source,disk:target});
}
for (const d of disks.filter(d=>!catalog.some(f=>f.disk===d.id) && d.id!=="pool")) {
  const photo=d.kind==="SD";
  catalog.push({id:"sample-"+d.id,disk:d.id,dir:photo?"DCIM/":"Documents/",
    name:photo?"Съёмка "+d.name.slice(-2)+".jpg":"Опись — "+d.name+".pdf",
    type:photo?"Фото":"Документ",size:photo?.012:.003});
}
for (const d of disks) {
  const indexed=catalog.filter(f=>f.disk===d.id).reduce((sum,f)=>sum+f.size,0);
  d.used=Math.max(d.used,indexed);
}
const contentKey = f => f.content || f.id;
const fileById = id => catalog.find(f => f.id === id);
const sizeText = gb => gb >= 1000 ? num(gb/1000) + " ТБ" : gb >= 1 ? num(gb) + " ГБ" : num(gb*1000) + " МБ";
const filePath = f => disk(f.disk).mount + f.dir + f.name;
const jobs = [];
let serial = 0;
let shelfFilter = "all";
let shelfKind = "";
let shelfQuery = "";
let shelfLimit = 6;
let catalogDisk = "";
let catalogQuery = "";
let platform = "Все";
const platforms = ["Все","Windows","macOS","Switch","PSP","PS2","PS4"];
const manifests = new Map();
const pending = j => ["running","waiting","paused"].includes(j.state);
const phaseLabel = j => j.state === "done" ? "Готово" : j.state === "cancelled" ? "Отменено" :
  j.state === "paused" ? "На паузе" : j.state === "waiting" ? "В очереди" :
  j.phases[Math.min(j.phases.length-1,Math.floor(j.percent*j.phases.length/100))];
function startJob(name, host, phases, done, key = name, resources = []) {
  if (jobs.some(j=>pending(j) && (j.key === key || resources.some(r=>j.resources.includes(r))))) {
    notify("Для этого источника уже есть задание"); return false;
  }
  jobs.unshift({id:++serial,name,host,phases,done,key,resources,state:"waiting",percent:0});
  if(!key.startsWith("auto-")) notify("В очереди · " + name);
  refreshJobs();
  return true;
}
function jobList(compact = false) {
  const list = compact ? jobs.slice(0,2) : jobs;
  return list.map(j => `<article class="job-row" data-job-row="${j.id}">
    <span class="job-icon">${icon(j.state === "done" ? "Check" : "Activity")}</span>
    <div class="job-body"><b>${escapeHtml(j.name)}</b><small>${j.host} · <span data-phase>${phaseLabel(j)}</span></small>
    ${track(j.percent)}</div><output>${j.percent}%</output>
    ${compact ? "" : pending(j) ? `<button class="icon-button" data-job-toggle="${j.id}" aria-label="${j.state==="paused"?"Продолжить":"Приостановить"}">${icon(j.state==="paused"?"Play":"Pause")}</button><button class="icon-button" data-job-cancel="${j.id}" aria-label="Отменить задание">${icon("X")}</button>` : ""}
    </article>`).join("") || '<p class="empty-hint">Заданий пока нет.</p>';
}
function refreshJobs() {
  $("queue-preview").innerHTML = `<div class="card-heading"><h2>${icon("ListChecks")}Очередь задач</h2><button class="secondary-action" data-page="jobs">Все задания</button></div>${jobList(true)}`;
  if (page === "jobs") $("secondary").innerHTML = `<div class="card job-list">${jobList()}</div>`;
}
function tickJobs() {
  let changed = false;
  for (const host of ["Mac mini","Windows PC"]) {
    let j = jobs.find(j=>j.host === host && j.state === "running");
    if (!j) {
      j = jobs.findLast(j=>j.host === host && j.state === "waiting");
      if (!j) continue;
      j.state = "running";
    }
    j.percent = Math.min(100,j.percent+8);
    if (j.percent === 100) {
      j.state = "done"; j.done?.(); changed = true;
      if(!j.key.startsWith("auto-")) notify("Готово · " + j.name);
    }
    document.querySelectorAll(`[data-job-row="${j.id}"]`).forEach(el=>{
      el.querySelector("[data-phase]").textContent = phaseLabel(j);
      el.querySelector(".track span").style.width = j.percent+"%";
      el.querySelector("output").textContent = j.percent+"%";
    });
  }
  if (changed) {
    refreshJobs();
    if (page === "games") renderGames();
    if (page === "drives" || page === "index") renderFiles();
    if (page === "overview" && Number($("carrier-count")?.textContent)!==disks.length) renderShelf();
    if (page === "integrity") renderManifests();
  }
}
function openJobs() { navigate("jobs"); }
function launch(name,host,phases,done,key,resources) {
  if (startJob(name,host,phases,done,key,resources)) openJobs();
}
const moduleButtons = ["games","move","integrity","localsend","optical","policies","index","scheduler"];
const accents = ["#ddae80","#88ccaf","#a5c4ec","#82cdd0","#e5b2d2","#c3bd97","#aebcd1","#edd194"];
const actions = ["Библиотека игр","Файлы и раздачи","Сверка копий","Отправка и приём","Образы и запись","Назначения по типу","Поиск по снимкам","Слоты носителей"];
const families = [
  ["HDD","Жёсткие диски","moss"],["SSD","SSD","slate"],["USB","USB-флешки","amber"],
  ["SD","Карты памяти","aqua"],["Оптика","CD / DVD / BD","violet"]
];
function landing() {
  $("desk").innerHTML = `<section class="shelf-block"><div class="block-title"><h2>Коллекция носителей <span class="count" id="carrier-count"></span></h2><button class="secondary-action" data-every-file>Поиск файлов ${icon("Search")}</button></div>
    <div class="families" id="families"></div>
    <div class="inventory-controls"><label class="search">${icon("Search")}<input type="search" id="shelf-query" placeholder="Носитель, хост или место хранения" aria-label="Найти носитель"></label>
    <select id="shelf-filter" aria-label="Подключение"><option value="all">Любое подключение</option><option value="on">Подключены</option><option value="off">На полке</option></select></div>
    <div class="inventory" id="rack"></div><div class="inventory-foot"><span id="shelf-result"></span><button class="secondary-action" id="more-disks">Показать ещё</button></div></section>
    <section class="action-section"><div class="block-title"><h2>Библиотека и операции</h2></div><div class="action-grid">${moduleButtons.map((id,i)=>{
      const [,label,symbol] = modules.find(m=>m[0]===id);
      return `<button class="tool-tile" data-page="${id}" style="--tool:${accents[i]}"><i>${icon(symbol)}</i><span><b>${label}</b><small>${actions[i]}</small></span></button>`;
    }).join("")}</div></section>`;
  $("shelf-filter").value=shelfFilter;
  $("shelf-query").value=shelfQuery;
  $("shelf-query").oninput=e=>{shelfQuery=e.target.value;shelfLimit=6;renderShelf();};
  $("shelf-filter").onchange=e=>{shelfFilter=e.target.value;shelfLimit=6;renderShelf();};
  $("more-disks").onclick=()=>{shelfLimit+=12;renderShelf();};
  renderShelf();
}
function renderShelf() {
  if (!$("families")) return;
  $("carrier-count").textContent=disks.length;
  $("families").innerHTML=families.map(([kind,label,tint])=>{
    const group=disks.filter(d=>d.kind===kind);
    return `<button class="family ${tint}" data-family="${kind}" aria-pressed="${kind===shelfKind}">
      <span class="drive-art"><span class="hardware model-${kind} ${kind==="Оптика"?"opt-disc":""}"><span class="hw-label">${kind}</span><i></i></span></span>
      <span class="family-title">${label}<b>${group.length}</b></span><small>Подключено · ${group.filter(d=>!d.offline).length}</small></button>`;
  }).join("");
  const q=shelfQuery.trim().toLocaleLowerCase("ru");
  const matches=disks.filter(d=>(!shelfKind || d.kind===shelfKind) && (shelfFilter==="all" || Boolean(d.offline)===(shelfFilter==="off")) &&
    [d.name,d.host,d.role,d.kind,d.fs].join(" ").toLocaleLowerCase("ru").includes(q));
  if(!shelfKind && !q) {
    const first=families.map(([kind])=>matches.find(d=>d.kind===kind)).filter(Boolean);
    matches.splice(0,matches.length,...first,...matches.filter(d=>!first.includes(d)));
  }
  $("rack").innerHTML=matches.slice(0,shelfLimit).map(d=>`<button class="inventory-drive ${d.tint}" data-open-disk="${d.id}">
    <span class="carrier-type">${d.kind==="Оптика"?"DISC":d.kind}</span><span class="carrier-label"><b>${escapeHtml(d.name)}</b><small>${escapeHtml(d.offline ? d.role : d.host)} · ${sizeText(d.total)}</small></span>
    <span class="connect-state ${d.offline?"off":""}">${d.offline?"На полке":"В сети"}</span></button>`).join("") || '<p class="empty-hint">Носители не найдены.</p>';
  $("more-disks").hidden=matches.length<=shelfLimit;
  $("shelf-result").innerHTML=`Показано ${Math.min(matches.length,shelfLimit)} из ${matches.length}${shelfKind||shelfFilter!=="all"||q?' · <button class="clear-shelf" data-clear-shelf>Сбросить фильтры</button>':""}`;
}
function chooser(id, label, entries) {
  return `<label class="field">${label}<select id="${id}">${entries.map(([v,s])=>`<option value="${escapeHtml(v)}">${escapeHtml(s)}</option>`).join("")}</select></label>`;
}
function block(title,inner) {
  return `<section class="card work-card"><h2>${title}</h2>${inner}</section>`;
}
function renderCatalog() {
  $("secondary").innerHTML = block(page==="index"?"Поиск по индексу":"Файлы на носителях",
    `<div class="catalog-controls"><label class="search">${icon("Search")}<input type="search" id="catalog-q" placeholder="Имя файла или путь" aria-label="Имя файла или путь"></label>${chooser("disk-filter","Носитель",[["","Все носители"],...disks.map(d=>[d.id,d.name])])}</div><div id="index-info"></div><div id="file-list"></div>`);
  $("catalog-q").value=catalogQuery; $("disk-filter").value=catalogDisk;
  $("catalog-q").oninput=e=>{catalogQuery=e.target.value; renderFiles();};
  $("disk-filter").onchange=e=>{catalogDisk=e.target.value; renderFiles();};
  renderFiles();
}
function renderFiles() {
  const list=$("file-list"); if (!list) return;
  const d=disk(catalogDisk);
  $("index-info").innerHTML = d ? `<div class="info-strip">${icon("HardDrive")}<span>${d.offline?"Отключён · "+d.role:d.host+" · "+d.fs+" · "+(d.fs==="NTFS"?"снимок MFT":"обход папок")+(d.lastScan?" · обновлён "+d.lastScan:"")}</span>${d.offline?"":`<button class="secondary-action" data-reindex="${d.id}">Обновить индекс</button>`}</div>` : "";
  const q=catalogQuery.toLowerCase().trim();
  const matches=catalog.filter(f=>(!catalogDisk||f.disk===catalogDisk) && (filePath(f)+" "+disk(f.disk).name+" "+disk(f.disk).role).toLowerCase().includes(q));
  const grouped=new Map();
  for (const f of matches) {
    const key=contentKey(f);
    if(!grouped.has(key) || disk(grouped.get(key).disk).offline) grouped.set(key,f);
  }
  const counts=new Map();
  for(const f of catalog) counts.set(contentKey(f),(counts.get(contentKey(f))||0)+1);
  list.innerHTML = Array.from(grouped.values(), f=>{
    const count=counts.get(contentKey(f));
    return `<button class="file-line" data-file="${f.id}"><i>${icon(f.platform?"Gamepad2":f.type==="Видео"?"Film":"File")}</i><span><b>${escapeHtml(f.name)}</b><small>${escapeHtml(filePath(f))}</small></span><em>${escapeHtml(disk(f.disk).name)}${count>1?" · копий: "+count:disk(f.disk).offline?" · на полке":""}</em><small>${sizeText(f.size)}</small>${icon("ChevronRight")}</button>`;
  }).join("") || '<p class="empty-hint">Совпадений в снимках нет.</p>';
}
function openFile(f) {
  const d=disk(f.disk);
  const copies=catalog.filter(c=>contentKey(c)===contentKey(f));
  showDialog(f.name,`<p class="capacity-label">${f.type} · ${sizeText(f.size)}${f.compressed?" · занято "+sizeText(f.allocated):""}</p>
    <h3 class="copies-heading">Где хранится · ${copies.length}</h3>
    <div class="copy-list">${copies.map(c=>{
      const v=disk(c.disk);
      return `<button class="copy-place" data-copy="${c.id}" aria-pressed="${c.id===f.id}"><b>${escapeHtml(v.name)}</b><span>${v.kind} · ${v.offline?"На полке · "+v.role:v.host}</span><small>${escapeHtml(filePath(c))}</small></button>`;
    }).join("")}</div>
    ${d.offline?`<p class="info-strip">Подключите «${escapeHtml(d.name)}» для работы с этой копией.</p>`:`<div class="file-actions">${[["move","Перенести или скопировать"],["localsend","Отправить через LocalSend"],["integrity","Рассчитать SHA-256"]].map(([m,label])=>`<button class="secondary-action" data-file-op="${m}" data-src="${f.id}">${label}</button>`).join("")}</div>`}`);
}
function selectSource(id) {
  if (!$("source") || !Array.from($("source").options).some(o=>o.value===id)) return;
  $("source").value=id; $("source").dispatchEvent(new Event("change"));
}
const opSpecs = {
  move:["Файлы и раздачи","Поставить в очередь"],
  integrity:["Контрольные суммы","Поставить проверку в очередь"],
  localsend:["Передача LocalSend","Поставить передачу в очередь"],
  optical:["Мастер оптического диска","Поставить задание в очередь"]
};
const onlineFiles = () => catalog.filter(f=>!disk(f.disk).offline);
const fromOptions = files => files.map(f=>[f.id,f.name+" · "+disk(f.disk).name]);
const pair = (...items) => items.map(x=>[x,x]);
let copyId = 0;
function publishCopy(f,target,dir=f.dir,changes={}) {
  const copy={...f,id:"copy-"+(++copyId),disk:target,dir,content:f.content || f.id,...changes};
  delete copy.torrent;
  catalog.push(copy); disk(target).used += copy.allocated ?? copy.size;
  return copy;
}
function renderOperation() {
  const [title,submit]=opSpecs[page];
  const available=onlineFiles();
  $("secondary").innerHTML=block(title,`<form id="operation"><div class="form-grid">
    ${chooser("source","Источник из каталога",fromOptions(available))}
    <div id="op-fields"></div></div><div id="placement"></div><div class="route-preview" id="route-preview"></div><button class="primary" id="run-op">${icon("Play")}${submit}</button></form>`) +
    (page==="integrity"?block("Манифесты SHA-256",'<div id="manifests"></div>'):"");
  const field=(id,label,values)=>chooser(id,label,pair(...values));
  function fields() {
    const f=fileById($("source").value); if (!f) return;
    const d=disk(f.disk);
    const mode=(page==="move" && f.torrent!=null)?["Перенос раздачи","Копирование"]:["Копирование","Перенос файла"];
    const devices=disks.filter(x=>!x.offline && x.id!==d.id && x.fs!=="UDF");
    const options={
      move:()=>field("mode","Операция",mode)+chooser("dest","Диск назначения",devices.map(x=>[x.id,x.name+" · "+x.host])),
      integrity:()=>chooser("compare","Сверить с копией",[["","Только записать манифест"],...fromOptions(onlineFiles().filter(x=>x.id!==f.id))]),
      localsend:()=>field("direction","Направление",["Отправить","Принять"])+field("peer","Устройство",d.host==="Mac mini"?["Windows PC","Планшет"]:["Mac mini","Планшет"]),
      optical:()=>field("disc-action","Операция",["Собрать ISO","Записать и проверить","Рисунок на поверхности"])+field("medium","Носитель",["DVD-5","DVD-DL","CD-R","BD-R 25 ГБ"])
    };
    const previous = Array.from($("op-fields").querySelectorAll("select"), el => [el.id, el.value]);
    $("op-fields").innerHTML=options[page]();
    if (page==="move") {
      const dest=devices.find(x=>x.host===d.host && x.id!=="pool") || devices.find(x=>x.host===d.host);
      if(dest) $("dest").value=dest.id;
    }
    for(const [id,value] of previous){
      const el=$(id);
      if(id!=="mode" && id!=="dest" && el && Array.from(el.options).some(o=>o.value===value)) el.value=value;
    }
    if(page==="move"){
      $("placement").innerHTML=`<div class="drop-source" draggable="true" id="grab-file">${icon("FileArchive")}<span>${escapeHtml(f.name)}</span><small>Перетащите на диск или выберите его нажатием</small></div><div class="drop-grid">${devices.map(x=>`<button type="button" class="drop-target" data-place="${x.id}">${icon("HardDrive")}<b>${x.name}</b><small>${sizeText(x.total-x.used)} свободно</small></button>`).join("")}</div>`;
      $("grab-file").ondragstart=e=>{e.dataTransfer.setData("text/plain",f.id);e.dataTransfer.effectAllowed="move";};
      document.querySelectorAll("[data-place]").forEach(btn=>{
        const choose=()=>{$("dest").value=btn.dataset.place;update();};
        btn.onclick=choose;
        btn.ondragover=e=>{e.preventDefault();btn.classList.add("drag-over");};
        btn.ondragleave=()=>btn.classList.remove("drag-over");
        btn.ondrop=e=>{e.preventDefault();btn.classList.remove("drag-over");if(e.dataTransfer.getData("text/plain")===f.id)choose();};
      });
    }
    if(page==="localsend") $("op-fields").insertAdjacentHTML("beforeend",'<div id="receive-target"></div>');
    if(page==="optical") $("op-fields").insertAdjacentHTML("beforeend",'<div id="art-controls"></div>');
    update();
  }
  function update() {
    const f=fileById($("source").value); if(!f) return;
    const d=disk(f.disk);
    let plan="",reason="";
    switch(page) {
      case "move": {
        const dest=disk($("dest").value), mode=$("mode").value;
        reason= mode==="Перенос раздачи" && d.host!==dest.host?"Для setLocation выберите диск на том же хосте.":
          dest.id==="pool" && !f.platform?"Игровой SSD предназначен для игр.":
          dest.total-dest.used<f.size?"Недостаточно свободного места.":"";
        document.querySelectorAll("[data-place]").forEach(btn=>btn.setAttribute("aria-pressed",String(btn.dataset.place===dest.id)));
        plan=d.name+" → "+dest.name+" · "+sizeText(f.size)+(mode==="Перенос раздачи"?" · setLocation":" · сверка SHA-256");
        break;
      }
      case "integrity": plan=$("compare").value?f.name+" ↔ "+fileById($("compare").value).name:"Создать манифест файла "+f.name; break;
      case "localsend": {
        const incoming=$("direction").value==="Принять";
        if(incoming && !$("recv-disk")) $("receive-target").innerHTML=chooser("recv-disk","Папка приёма",disks.filter(d=>!d.offline && d.id!=="pool").map(d=>[d.id,d.name+" / Inbox"]));
        if(!incoming) $("receive-target").innerHTML="";
        plan=incoming?$("peer").value+" → "+disk($("recv-disk").value).name+" / Inbox · демофайл "+f.name:d.host+" → "+$("peer").value+" · "+f.name; break;
      }
      case "optical": {
        const action=$("disc-action").value,medium=$("medium").value;
        const capacity={"CD-R":.7340032,"DVD-5":4.700372992,"DVD-DL":8.543666176,"BD-R 25 ГБ":25}[medium];
        const art=action==="Рисунок на поверхности";
        $("source").closest("label").hidden=art;
        if(art && !$("art-file")) {
          $("art-controls").innerHTML='<label class="field">Рисунок на диск<input type="file" id="art-file" accept="image/png,image/jpeg,image/webp"></label><div class="surface-preview" id="surface"><span>Склад</span></div>';
          $("art-file").onchange=e=>{
            const image=e.target.files[0];if(!image)return;
            const reader=new FileReader();reader.onload=()=>{const img=document.createElement("img");img.src=reader.result;img.alt="Предпросмотр рисунка";$("surface")?.replaceChildren(img);};reader.readAsDataURL(image);
          };
        }
        if(!art) $("art-controls").innerHTML="";
        reason=art && medium==="DVD-DL"?"Для рисунка нужен однослойный носитель.":!art && f.size>capacity?"Набор больше ёмкости "+medium+".":"";
        plan=art?"DiscImageStudio · "+medium+" → "+(medium==="CD-R"?"WAV":"ISO"):f.name+" · "+sizeText(f.size)+" / "+sizeText(capacity)+" · Windows PC"; break;
      }
    }
    $("route-preview").textContent=reason || plan;
    $("route-preview").classList.toggle("blocked",Boolean(reason));
    $("run-op").disabled=Boolean(reason);
  }
  $("source").onchange=fields;
  $("op-fields").onchange=update;
  fields(); renderManifests();
  $("operation").onsubmit=async e=>{
    e.preventDefault(); update(); if($("run-op").disabled) return;
    const f=fileById($("source").value), d=disk(f.disk);
    const lock=["file:"+f.id];
    if(page==="move") {
      const dest=disk($("dest").value), mode=$("mode").value, src=f.disk;
      launch(mode+" · "+f.name,d.host,["Подготовка","Перенос","Сверка SHA-256"],()=>{
        if(mode==="Копирование") processArrival(publishCopy(f,dest.id));
        else {disk(src).used-=f.allocated ?? f.size;dest.used+=f.allocated ?? f.size;f.disk=dest.id; if(f.torrent!=null)torrents.find(t=>t.id===f.torrent).disk=dest.id;processArrival(f);}
      },mode+f.id+dest.id,lock);
    } else if(page==="integrity") {
      const other=fileById($("compare").value);
      // Hash deterministic fixture bytes. Copies share bytes, encoded outputs have a distinct content key.
      const digest=async x=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode("sklad-demo/"+(x.content||x.id)))),b=>b.toString(16).padStart(2,"0")).join("");
      const [first,second]=await Promise.all([digest(f),other?digest(other):null]);
      launch("SHA-256 · "+f.name,d.host,["Чтение демофайла","Запись манифеста"],()=>{
        manifests.set(f.id,first); if(other) manifests.set(other.id,second);
        if(other) comparisons.push([f.id,other.id,first===second]);
      },"hash:"+f.id+other?.id,lock);
    } else if(page==="localsend") {
      const receive=$("direction").value==="Принять", peer=$("peer").value, target=$("recv-disk")?.value;
      launch("LocalSend · "+(receive?"Приём":"Отправка")+" · "+f.name, receive?disk(target).host:d.host,
        ["Согласование","Передача","Сверка SHA-256"],()=>{if(receive) processArrival(publishCopy(f,target,"Inbox/"));},[f.id,peer,target,receive].join(":"));
    } else if(page==="optical") {
      const action=$("disc-action").value, medium=$("medium").value;
      const art=action==="Рисунок на поверхности", artwork=$("art-file")?.files?.[0]?.name || "Склад", burn=action==="Записать и проверить";
      launch(action+" · "+medium,"Windows PC",burn?["Сборка образа","Запись","Проверка чтением"]:["Подготовка","Сборка образа"],()=>{
        if(burn) {
          const id="disc-"+(++copyId);
          disks.push({id,kind:"Оптика",name:"Запись № "+copyId,host:"Windows PC",fs:"UDF",mount:"",role:"Полка · новая запись",used:0,total:{"CD-R":.7340032,"DVD-5":4.700372992,"DVD-DL":8.543666176,"BD-R 25 ГБ":25}[medium],tint:"violet",offline:true});
          publishCopy(f,id);
        } else {
          publishCopy(f,"media","Images/",{name:(art?artwork:f.name)+"."+(art&&medium==="CD-R"?"wav":"iso"),platform:undefined,type:"Образ",content:"disc:"+medium+f.id});
        }
      },[action,medium,art?artwork:f.id].join(":"));
    }
  };
}
const comparisons=[];
function renderManifests() {
  const el=$("manifests"); if(!el) return;
  el.innerHTML=Array.from(manifests,([id,sum])=>`<div class="info-strip">${icon("Check")}${escapeHtml(fileById(id).name)} · демофайл <code>${sum}</code></div>`).join("") ||
    '<p class="empty-hint">Выберите файл выше, чтобы создать первый манифест.</p>';
  el.innerHTML+=comparisons.map(([a,b,same])=>`<div class="info-strip">${escapeHtml(fileById(a).name)} ↔ ${escapeHtml(fileById(b).name)} · ${same?"Копии совпали":"Контрольные суммы различаются"}</div>`).join("");
}
function renderGames() {
  const games=catalog.filter(f=>f.platform && !f.original && !f.content);
  const visible=games.filter(f=>platform==="Все" || platform===f.platform);
  $("secondary").innerHTML=`<div class="platforms">${platforms.map(p=>`<button class="secondary-action" aria-pressed="${p===platform}" data-platform="${p}">${p}</button>`).join("")}</div><div class="game-grid">${visible.map(f=>{
    const copy=catalog.find(c=>c.original===f.id);
    return `<article class="card game-card"><div class="game-cover cover-${f.id}">${icon("Gamepad2")}<b>${escapeHtml(f.name.replace(".app",""))}</b></div><div class="game-meta"><small>${f.platform} · ${sizeText(f.size)}</small><p>${copy?"Проверенная копия на Game SSD":disk(f.disk).name}</p>
    <button class="secondary-action" data-game="${f.id}">${copy?"Запустить":f.platform==="macOS"?"Открыть карточку":"Подготовить на SSD"}</button></div></article>`;
  }).join("") || '<p class="empty-hint">В демокаталоге игр для этой платформы пока нет.</p>'}</div>`;
}
function gameAction(f) {
  const c=catalog.find(x=>x.original===f.id);
  if(f.platform==="macOS") return openFile(f);
  if(c) return showDialog(f.name,`<p>Демозапуск с Game SSD · ${escapeHtml(filePath(c))}</p><p class="capacity-label">Архивная копия на ${disk(f.disk).name} сохранена.</p>`);
  if(disk("pool").total-disk("pool").used<f.size) return notify("Недостаточно места на игровом SSD");
  launch("Подготовить игру · "+f.name,"Windows PC",["Копирование на SSD","Сверка SHA-256","Подготовка запуска"],()=>{const local=publishCopy(f,"pool","Games/",{original:f.id});processArrival(local);},"game:"+f.id,["file:"+f.id]);
}
const rules = new Map();
const categories=["Игры","Фильмы","Сериалы","Музыка","Софт","Документы","Прочее"];
for(const c of categories) rules.set(c,{disk:"group",folder:c,index:"Обход папок",after:c==="Игры"?"Сжатие NTFS":["Фильмы","Сериалы"].includes(c)?"HandBrake":"Без обработки"});
// This demo opens with an already approved ruleset. Editing it requires another preview.
let category="Игры",dryRun=true,auto=true;
function destination(rule, size, host) {
  let candidates=rule.disk==="group"?disks.filter(d=>d.kind==="HDD"):[disk(rule.disk)];
  candidates=candidates.filter(d=>d && !d.offline && (!host || d.host===host) && d.total-d.used>=size);
  return candidates.sort((a,b)=>(b.total-b.used)-(a.total-a.used))[0];
}
function processArrival(f) {
  if(!auto || !dryRun || disk(f.disk).offline) return;
  const source=disk(f.disk);
  const category=f.platform?"Игры":f.type==="Видео"?"Фильмы":"Прочее";
  const rule=rules.get(category);
  if(rule.after==="Сжатие NTFS" && f.platform==="Windows" && source.host==="Windows PC" &&
     source.fs==="NTFS" && (f.expectedSaving||0)>=.1 && !f.compressed) {
    startJob("Подготовка игры · "+f.name,source.host,["Оценка экономии","Фоновое сжатие","Проверка копии"],()=>{
      f.compressed="XPRESS16K";f.allocated=f.size*(1-f.expectedSaving);source.used-=f.size-f.allocated;
    },"auto-game:"+f.id,["file:"+f.id]);
  }
  if(rule.after!=="HandBrake" || f.type!=="Видео" || f.optimized) return;
  const key="auto-av1:"+contentKey(f);
  if(catalog.some(c=>c.content===key) || jobs.some(j=>j.key===key && pending(j))) return;
  const size=f.size*.67;
  const target=destination(rule,size);
  if(!target){notify("Для обработанного видео нужен подключённый носитель со свободным местом");return;}
  startJob("Подготовка видео · "+f.name,"Mac mini",["Копия во временную папку","Фоновая обработка","Проверка дорожек и длительности","Сохранение на "+target.name],()=>{
    publishCopy(f,target.id,rule.folder+"/",{name:f.name.replace(/\.[^.]+$/,"")+".sklad-av1.mkv",size,allocated:size,content:key,optimized:true});
  },key,["file:"+f.id]);
}
function renderPolicies() {
  const rule=rules.get(category);
  $("secondary").innerHTML=block("Назначение контента",`<div class="form-grid">${chooser("category","Категория",pair(...categories))}${chooser("rule-disk","Куда размещать",[["group","Любой архивный HDD со свободным местом"],...disks.filter(d=>!d.offline && d.id!=="pool").map(d=>[d.id,d.name])])}<label class="field">Папка<input id="folder"></label>${chooser("rule-index","Индексация",pair("Нет","Обход папок",...((rule.disk==="group" || disk(rule.disk).fs==="NTFS")?["NTFS MFT"]:[])))}${chooser("after","После загрузки",pair("Без обработки",...(category==="Фильмы"||category==="Сериалы"?["HandBrake"]:[]),...(category==="Игры" && (rule.disk==="group" || disk(rule.disk).fs==="NTFS")?["Сжатие NTFS"]:[])))}</div>
    <div class="file-actions"><button class="primary" id="dry">Пробный прогон</button><button class="secondary-action" id="automate"></button></div><div id="rule-output"></div>`);
  $("category").value=category; $("rule-disk").value=rule.disk; $("folder").value=rule.folder; $("rule-index").value=rule.index; $("after").value=rule.after;
  function output() {
    $("dry").disabled=Array.from(rules.values()).some(r=>!r.folder.trim());
    $("automate").disabled=!dryRun;
    $("automate").textContent=auto?"Выключить автоматику":"Включить автоматику";
    $("rule-output").innerHTML=dryRun?`<p class="info-strip">${auto?"Демоавтоматика включена":"Результат пробного прогона"}</p>`+categories.map(c=>{
      const r=rules.get(c);return `<div class="policy-line"><b>${c}</b><span>${escapeHtml((r.disk==="group"?"Группа HDD / ":disk(r.disk).name+" / ")+r.folder)}/</span><small>${r.index} · ${r.after}</small></div>`;
    }).join(""):'<p class="info-strip">Перед включением автоматики выполните пробный прогон текущих правил.</p>';
  }
  $("category").onchange=e=>{category=e.target.value;renderPolicies();};
  $("rule-disk").onchange=e=>{rule.disk=e.target.value;if((rule.disk!=="group" && disk(rule.disk).fs!=="NTFS")){if(rule.index==="NTFS MFT")rule.index="Обход папок";if(rule.after==="Сжатие NTFS")rule.after="Без обработки";}dryRun=false;auto=false;renderPolicies();};
  for(const [id,key] of [["folder","folder"],["rule-index","index"],["after","after"]]) $(id).oninput=e=>{rule[key]=e.target.value;dryRun=false;auto=false;output();};
  $("dry").onclick=()=>{dryRun=true;output();}; $("automate").onclick=()=>{auto=!auto;output();};output();
}
states.wait=["В очереди","Clock3"];
const diskForTorrent=t=>t.disk || (t.host==="Mac mini"?"vault":"archive");
torrents.forEach((t,i)=>{t.disk=["vault","archive","archive","vault","data","media"][i];});
torrents.push({id:6,name:"Fedora Workstation",kind:"image",size:"2,4 ГБ",host:"Windows PC",disk:"archive",state:"wait",percent:0,down:0,up:0,rank:2},
  {id:7,name:"Linux Mint Cinnamon",kind:"image",size:"2,9 ГБ",host:"Windows PC",disk:"archive",state:"wait",percent:0,down:0,up:0,rank:3});
function rebalance() {
  disks.forEach(d=>{
    const group=torrents.filter(t=>diskForTorrent(t)===d.id);
    const running=group.filter(t=>t.state==="down");
    running.slice(d.offline?0:1).forEach(t=>{t.state="wait";});
    if(!d.offline && running.length===0){
      const next=group.filter(t=>t.state==="wait").sort((a,b)=>(a.rank||0)-(b.rank||0))[0];
      if(next){next.state="down";next.down ||= 12.6;}
    }
  });
}
function renderScheduler() {
  const groups=disks.filter(d=>torrents.some(t=>diskForTorrent(t)===d.id && t.percent<100));
  $("secondary").innerHTML=groups.map(d=>{
    const list=torrents.filter(t=>diskForTorrent(t)===d.id && t.percent<100)
      .sort((a,b)=>Number(b.state==="down")-Number(a.state==="down") || (a.rank||0)-(b.rank||0));
    return block(d.name,`<p class="capacity-label">${d.host} · ${d.offline?"диск отключён":"слот занят "+list.filter(t=>t.state==="down").length+" / 1"}</p>`+list.map(t=>`<div class="schedule-line"><b>${escapeHtml(t.name)}</b>${pill(t.state)}${t.state==="down"?`<button class="secondary-action" data-finish="${t.id}">Завершить в демо</button>`:t.state==="wait"?`<button class="secondary-action" data-next="${t.id}">Следующим</button>`:`<button class="secondary-action" data-detail="${t.id}">Открыть</button>`}</div>`).join(""));
  }).join("") || block("Слоты дисков",'<p class="empty-hint">Загрузок в очереди нет.</p>');
}
function renderWorkbench(){
  if(page==="overview") landing();
  if(page==="drives"||page==="index") renderCatalog();
  if(page==="games") renderGames();
  if(page==="policies") renderPolicies();
  if(page==="scheduler") renderScheduler();
  if(opSpecs[page]) renderOperation();
  refreshJobs();
}
document.addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b) return;
  const a=b.dataset;
  if(b.hasAttribute("data-clear-shelf")){shelfKind="";shelfQuery="";shelfFilter="all";shelfLimit=6;landing();}
  if(a.family){shelfKind=shelfKind===a.family?"":a.family;shelfLimit=6;renderShelf();document.querySelector('[data-family="'+a.family+'"]').focus();}
  if(b.hasAttribute("data-every-file")){catalogDisk="";catalogQuery="";navigate("drives");$("catalog-q").focus();}
  if(a.copy)openFile(fileById(a.copy));
  if(a.openDisk){catalogDisk=a.openDisk;catalogQuery="";navigate("drives");}
  if(a.file)openFile(fileById(a.file));
  if(a.fileOp){$("dialog").close();navigate(a.fileOp);selectSource(a.src);}
  if(a.platform){platform=a.platform;renderGames();}
  if(a.game)gameAction(fileById(a.game));
  if(a.reindex){const d=disk(a.reindex);launch("Обновить индекс · "+d.name,d.host,[d.fs==="NTFS"?"Чтение MFT":"Обход папок","Публикация снимка"],()=>{d.lastScan=new Date().toLocaleTimeString("ru-RU");},"index:"+d.id);}
  if(a.jobToggle || a.jobCancel){
    const j=jobs.find(x=>x.id===Number(a.jobToggle||a.jobCancel));
    if(pending(j)) { j.state=a.jobCancel?"cancelled":j.state==="paused"?"waiting":"paused";refreshJobs();}
  }
  if(a.next){const t=torrents.find(x=>x.id===Number(a.next));t.rank=Math.min(0,...torrents.map(x=>x.rank||0))-1;renderScheduler();notify("Следующей начнётся "+t.name);}
  if(a.finish){
    const t=torrents.find(x=>x.id===Number(a.finish)), dest=diskForTorrent(t);
    t.state="seed";t.percent=100;t.down=0;t.up=2.6;
    if(!catalog.some(f=>f.torrent===t.id)){
      const size=parseFloat(t.size.replace(",",".")) || 0;
      const f={id:"torrent-"+t.id,name:t.name,type:kinds[t.kind][0],size:t.size.includes("МБ")?size/1000:size,disk:dest,dir:"Downloads/",torrent:t.id};
      catalog.push(f);disk(dest).used+=f.size;
      if(auto) {
        const cat={image:"Софт",video:"Фильмы",audio:"Музыка"}[t.kind] || "Прочее",r={...rules.get(cat)};
        const target=destination(r,f.size,t.host);
        if(target) startJob("Раскладка · "+f.name,t.host,["Размещение","Обновление каталога"],()=>{
          disk(f.disk).used-=f.size;target.used+=f.size;f.disk=target.id;t.disk=target.id;f.dir=r.folder+"/";
          processArrival(f);
        },"policy:"+f.id,["file:"+f.id]);
        else processArrival(f);
      }
    }
    rebalance();renderScheduler();renderChart();renderRows();
  }
});
processArrival(fileById("film"));
startJob("Индекс · Archive HDD","Windows PC",["Чтение снимка","Публикация индекса"]);
$("notice").textContent="";
renderChart();
navigate("overview");
setInterval(tickJobs,1200);
