const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function app() {
  const elements = new Map();
  function element() { return {style:{},children:[],value:'5',innerHTML:'',textContent:'',firstChild:{style:{}},
    addEventListener(){}, appendChild(x){this.children.push(x)}, querySelector(){return element()}, querySelectorAll(){return []},focus(){},classList:{add(){},remove(){}}}; }
  const context = vm.createContext({document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},addEventListener(){},createElement:element},
    location:{protocol:'file:'},localStorage:{getItem(){return null},setItem(){}},window:{},setTimeout(){return 1},clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({})}),AbortSignal,console});
  vm.runInContext(source.replace('renderPts();updateState();initMap();\nrefreshGoogleStatus();',''),context);
  return {run:code=>vm.runInContext(code,context),elements};
}
const {run,elements}=app();
const plain=x=>JSON.parse(JSON.stringify(x));
async function main(){
  // Çoklu kaynak: yaklaşık numara kesinleşmez, farklı binalar engellenir.
  const multi=app();
  multi.run(`var addr={street:'Örnek Sokak',no:'12A',mah:'Göztepe',ilce:'Kadıköy'};
    var exact={lat:41,lon:29,road:'Örnek Sokak',no:'12A',areas:['Göztepe','Kadıköy'],ilce:'Kadıköy',types:['street_address'],precision:'exact',source:'HERE'};`);
  assert.equal(multi.run(`reconcileCandidates(addr,null,[exact]).quality`),'Kapı');
  assert.equal(multi.run(`reconcileCandidates(addr,null,[{...exact,precision:'approximate'}])`),null);
  assert.equal(multi.run(`reconcileCandidates(addr,null,[{...exact,no:'12'}])`),null);
  assert.equal(multi.run(`reconcileCandidates(addr,null,[{...exact,ilce:'Ümraniye'}])`),null);
  assert.equal(multi.run(`reconcileCandidates(addr,null,[exact,{...exact,lat:41.01,source:'TomTom'}]).quality`),'Kontrol');
  assert.ok(multi.run(`addr.placeError.includes('Çelişkili')`));
  assert.equal(multi.run(`reconcileCandidates(addr,{...exact,quality:'Kapı'},[{...exact,lat:41.01}]).quality`),'Kontrol');
  assert.equal(multi.run(`reconcileCandidates(addr,null,[exact,{...exact,lat:41.0001}]).quality`),'Kapı');
  multi.run(`var fetchCalls=0;fetch=async()=>{fetchCalls++;return {ok:false,json:async()=>({code:'network',error:'Geçici bağlantı hatası'})}};yKey='test';`);
  await multi.run(`yandexSearch('İstanbul')`);
  assert.ok(multi.elements.get('yWarn').textContent.includes('Geçici bağlantı'));
  assert.ok(!multi.elements.get('yWarn').textContent.includes('izni yok'));
  await multi.run(`yandexSearch('İstanbul')`);
  assert.equal(multi.run('fetchCalls'),1,'Bekleme sırasında servis tekrar zorlanmamalı');
  multi.run(`yRetryAt=0;fetch=async()=>({ok:true,json:async()=>({candidates:[{...exact,areas:['Kadıköy','Göztepe Mahallesi']}]})})`);
  assert.equal((await multi.run(`yandexSearch('İstanbul')`)).length,1,'Servis düzelince kendiliğinden kullanılmalı');
  assert.equal(multi.elements.get('yWarn').style.display,'none');
  multi.run(`configuredProviders={maptiler:true,tomtom:true};providerSearch=async p=>{if(p==='maptiler')throw new Error('timeout');return [exact]}`);
  assert.equal((await multi.run(`extraProviderSearch('adres')`)).length,1,'Tek servis hatası diğer sonucu silmemeli');
  assert.equal(run(`parseSheet([['Alıcı','Adres'],['A','Canpark']]).length`),1,'Kısa AVM adı kaybolmamalı');
  // AVM kodlu alıcı: mağaza kodu yerine AVM adı, aynı AVM tek durak
  assert.equal(run(`mallFromCode('TUR.Ist.GS.mll.METROGARDEN.I')`),'Metrogarden');
  assert.equal(run(`mallFromCode('TUR.Ist.GS.mII.CANPARK.I')`),'Canpark','fotoğrafta mII okunsa da bulunmalı');
  assert.equal(run(`mallFromCode('Fatih Katalıoğlu')`),'');
  assert.equal(run(`(()=>{const st=buildStops([{alici:'TUR.Ist.GS.mll.METROGARDEN.I',musteri:'İpekyol',ilce:'Ümraniye',raw:'Necip Fazıl Mah. Alemdağ Cad. No:940 Zemin kat 68'},{alici:'TUR.Ist.GS.mll.METROGARDEN.I',musteri:'İpekyol',ilce:'ÜMRANİYE',raw:'Necip Fazıl Mah. Alemdağ Cad. No:940 Zemin kat 68 '}]);return st.length+'|'+st[0].mall+'|'+st[0].orders[0].alici})()`),'1|Metrogarden|Metrogarden AVM (İpekyol)');
  // "4/2": önce 4/2 kapı no, sonra 4 (2 = daire); "4-6": önce aralık, sonra 4
  assert.equal(run(`JSON.stringify(noVariants('4/2'))`),JSON.stringify([{no:'4/2',daire:''},{no:'4',daire:'2'}]));
  assert.equal(run(`JSON.stringify(noVariants('4-6').map(v=>v.no))`),JSON.stringify(['4-6','4']));
  assert.equal(run(`JSON.stringify(noVariants('12A').map(v=>v.no))`),JSON.stringify(['12A']),'12A ile 12 farklı bina');
  assert.equal(run(`noMatches('32','32/17')`),true,'32/17 evrakı 32 numaralı binayla eşleşmeli');
  assert.equal(run(`noMatches('3','32/17')`),false);
  assert.equal(run(`parseAddress('Göztepe mah. tepegöz sk. 32/17','Kadıköy').no`),'32/17');
  for(const s of ['Canpark','Canpark AVM','Canpark AVM Kat:2 Mağaza:17']){
    assert.equal(run(`placeCore(parseAddress(${JSON.stringify(s)},'Ümraniye').place)`),'canpark');
  }
  assert.equal(run(`parseAddress('Canpark AVM Ümraniye','').ilce`),'Ümraniye');
  const apt=plain(run(`parseAddress('Atatürk Mah. Çam Apartmanı No:12A','Ümraniye')`));
  assert.equal(apt.place,'Çam Apartmanı');assert.equal(apt.no,'12A');
  const numbered=plain(run(`parseAddress('Fatih Sultan Mehmet Mah. 123. Sokak No:12A','Ümraniye')`));
  assert.equal(numbered.mah,'Fatih Sultan Mehmet');assert.equal(numbered.street,'123 Sokak');
  assert.equal(run(`parseAddress('Örnek Sokak No:4-6 B Blok','Kadıköy').no`),'4-6');
  assert.equal(run(`parseAddress('Örnek Sokak No:9/2 Daire:202','Kadıköy').no`),'9/2');
  assert.equal(run(`parseAddress('Örnek Sokak Dicle Apt. No:5 GÖZTEPE MAH.','Kadıköy').mah`),'GÖZTEPE');
  assert.equal(run(`parseAddress('Örnek Sokak Dicle Apt. No:5 GÖZTEPE MAH.','Kadıköy').place`),'Dicle Apt.');
  assert.equal(run(`parseAddress('Örnek Sokak no 8 Engin apt. Daire 19','Kadıköy').place`),'Engin apt.');
  assert.equal(run(`noOk('12A','12')`),false);assert.equal(run(`noOk('12A','12A')`),true);
  assert.equal(run(`buildStops([{raw:'Güzel Sokak',ilce:'Ümraniye'},{raw:'Güzel Sokak',ilce:'Kadıköy'}]).length`),2);
  assert.equal(run(`buildStops([{raw:'Canpark AVM Kat:1',ilce:'Ümraniye'},{raw:'Canpark AVM Kat:2',ilce:'Ümraniye'}]).length`),2);
  assert.equal(run(`readyStop({lat:41,lon:29,quality:'Sokak'})`),false);
  assert.equal(run(`readyStop({lat:41,lon:29,quality:'Mahalle'})`),false);
  assert.equal(run(`readyStop({lat:41,lon:null,quality:'Kapı'})`),false);
  assert.equal(run(`readyStop({lat:41,lon:29,quality:'Google'})`),true);
  // İlk durak eve en uzak değil, depoya karayoluyla en yakın olanıdır.
  run(`var D=[[0,1,50,20,10],[1,0,50,20,1],[50,50,0,20,90],[20,20,20,0,40],[10,1,90,40,0]]`);
  assert.equal(run("solve(D,3,['A','B','C'])[1]"),1);
  assert.deepEqual(plain(run('solve([[0,1],[1,0]],0,[])')),[0,1]);
  assert.throws(()=>run('solve([[0,null],[1,0]],0,[])'));
  // Aynı mahallede 10 müşteri varken başka mahalleye kaçmamalı.
  run(`var n=12;var D=Array.from({length:n+2},(_,i)=>Array.from({length:n+2},(_,j)=>i===j?0:j>10?1:50));D[0][1]=0.5;var keys=Array.from({length:n},(_,i)=>i<10?'A':'B')`);
  assert.deepEqual(plain(run('solve(D,n,keys).slice(1,11).map(i=>keys[i-1])')),Array(10).fill('A'));
  // Dağıtım başladıysa başka mahalledeki daha yakın müşteri için mevcut mahalleyi bırakma.
  assert.equal(run("keys[solve(D,n,keys,D,'B')[1]-1]"),'B');
  // Yakınlık mesafeye göre; hız farkı ilk durağı değiştirmesin.
  run(`var distMatrix=D.map(r=>r.slice());distMatrix[0][2]=0.1`);
  assert.equal(run('solve(D,n,keys,distMatrix)[1]'),2);
  // Eve dönüş maliyeti son mahalle seçiminde gerçekten etkili olmalı.
  run(`var E=Array.from({length:5},(_,i)=>Array.from({length:5},(_,j)=>i===j?0:10));E[0][1]=1;E[1][2]=1;E[1][3]=2;E[2][3]=1;E[3][2]=1;E[2][4]=1;E[3][4]=100`);
  assert.deepEqual(plain(run("solve(E,3,['A','B','C'])")),[0,1,3,2,4]);
  assert.notEqual(run("neighborhoodKey({id:1,mah:'Atatürk',ilce:'Kadıköy'})"),run("neighborhoodKey({id:2,mah:'Atatürk',ilce:'Ümraniye'})"));
  assert.notEqual(run("neighborhoodKey({id:1})"),run("neighborhoodKey({id:2})"));
  for(let seed=1;seed<=250;seed++){
    run(`var n=${seed%23+1};var keys=Array.from({length:n},(_,i)=>'mahalle'+(i%5));var D=Array.from({length:n+2},(_,i)=>Array.from({length:n+2},(_,j)=>i===j?0:((i+7)*(j+13)*${seed})%97+1));var p=solve(D,n,keys);`);
    const r=plain(run('({p,keys,n,D})'));
    assert.equal(r.p.length,r.n+2);assert.equal(new Set(r.p).size,r.n+2);
    const min=Math.min(...r.D[0].slice(1,-1));assert.equal(r.D[0][r.p[1]],min);
    const closed=new Set();let current;
    for(const i of r.p.slice(1,-1)){const key=r.keys[i-1];if(key!==current){assert.ok(!closed.has(key),'Mahalleye geri dönülmemeli');if(current)closed.add(current);current=key}}
    assert.deepEqual(plain(run('solve(D,n,keys)')),r.p);
  }
  run(`var originalMatrix=getMatrix;var originalOsrm=osrm;depot={lat:40.9,lon:29};home={lat:41.4,lon:29};
    var sourceOrders=Array.from({length:9},(_,i)=>({raw:'Örnek '+i+' Sokak No:1',ilce:'Kadıköy',alici:'Müşteri '+i,sip:String(i)}));
    getMatrix=async pts=>{const d=pts.map((a,i)=>pts.map((b,j)=>i===j?0:Math.round(Math.abs(a.lat-b.lat)*10000/200)*200+100));return {dist:d,dur:d.map(r=>r.map(v=>v/10)),osrm:true}};osrm=async()=>null;`);
  let expected;
  for(let seed=0;seed<30;seed++){
    run(`var shuffled=sourceOrders.slice().sort((a,b)=>((Number(a.sip)*7+${seed})%11)-((Number(b.sip)*7+${seed})%11));
      stops=buildStops(shuffled);stops.forEach(s=>{const k=Number(s.orders[0].sip);Object.assign(s,{lat:41+k*.01,lon:29,quality:'Elle',mah:'Mahalle '+(k%3)})});`);
    await run('buildRoute()');
    const result=plain(run('routeOrder.map(s=>s.orders[0].sip)'));
    if(!expected)expected=result;else assert.deepEqual(result,expected,'Karışık evrak aynı müşteri rotasını üretmeli');
  }
  run('getMatrix=originalMatrix;osrm=originalOsrm;stops=[];routeOrder=null');
  // Google adı tek başına yeterli değil: ilçe/mahalle, bina türü ve numara tutmalı.
  run(`var candidate={name:'Canpark Alışveriş Merkezi',ilce:'Ümraniye',areas:['Ümraniye','Yamanevler'],types:['shopping_mall']}`);
  assert.equal(run(`exactPlaceMatch({place:'Canpark',ilce:'Ümraniye'},candidate)`),true);
  assert.equal(run(`exactPlaceMatch({place:'Canpark',ilce:'Kadıköy'},candidate)`),false);
  assert.equal(run(`exactPlaceMatch({place:'Canpark'},candidate)`),false);
  assert.equal(run(`exactPlaceMatch({place:'Canpark',ilce:'Ümraniye',mah:'Atatürk'},candidate)`),false);
  assert.equal(run(`exactPlaceMatch({place:'Canpark',ilce:'Ümraniye'},{...candidate,types:['locality']})`),false);
  // Canpark'ın canlı Photon yanıtından alınan örnek: arazi, bina, otopark ve AVM birbirine karışmasın.
  const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'photon-canpark.json'),'utf8'));
  run(`var livePlaces=${JSON.stringify(fixture.features)}.map(photonCandidate);var originalStreet=locateStreet;var originalPlaces=placeSearchForStop;locateStreet=async()=>null;placeSearchForStop=async()=>livePlaces;googleSearch=async()=>{throw new Error('Ücretli API çağrılmamalı')}`);
  const mall=await run(`locate({place:'Canpark',ilce:'Ümraniye'})`);
  assert.equal(mall.quality,'OSM');assert.equal(mall.source,'OpenStreetMap');assert.ok(mall.types.includes('shopping_mall'));
  assert.equal(mall.mah,'Yamanevler');assert.equal(mall.road,'Alemdağ Caddesi');
  run('locateStreet=originalStreet;placeSearchForStop=originalPlaces');
  run(`yandexSearch=async()=>[]; photonSearch=async()=>[{source:'OSM'}]`);
  assert.equal((await run(`search('test')`))[0].source,'OSM');
  run(`locateStreet=async()=>null; googleSearch=async()=>{throw new Error('Ücretli API çağrılmamalı')};placeSearchForStop=async()=>[{...candidate,lat:41,lon:29}]`);
  assert.equal((await run(`locate({place:'Canpark',ilce:'Ümraniye'})`)).quality,'OSM');
  run(`placeSearchForStop=async()=>[{...candidate,lat:41,lon:29},{...candidate,lat:41.01,lon:29}]`);
  assert.equal(await run(`locate({place:'Canpark',ilce:'Ümraniye'})`),null,'İki eşleşme otomatik seçilmemeli');
  run(`placeSearchForStop=async()=>{throw new Error('Servis yanıt vermiyor')};var pending={place:'Canpark',ilce:'Ümraniye'}`);
  assert.equal(await run(`locate(pending)`),null);assert.equal(run('pending.placeError'),'Servis yanıt vermiyor');
  // Null matris hücresini 0 gibi yorumlamak yerine açık tahmine geç.
  run(`osrm=async()=>({durations:[[0,1],[1,0]],distances:[[0,null],[1,0]]})`);
  assert.equal((await run(`getMatrix([{lat:41,lon:29},{lat:41.1,lon:29.1}])`)).osrm,false);
  // Rota, eksik adresleri sessizce atlamamalı.
  run(`depot={lat:41,lon:29}; home={lat:41.1,lon:29.1}; stops=[{lat:null,lon:null,quality:'Bulunamadı'}]; var matrixCalls=0; getMatrix=async()=>{matrixCalls++;throw new Error('çağrılmamalı')}`);
  await run('buildRoute()');assert.equal(run('matrixCalls'),0);assert.equal(elements.get('routeBtn').disabled,true);
  // Evrak sırasındaki ilk (uzak) adres yerine yaklaşık yakın adres öne gelmeli.
  run(`stops=[{id:1,lat:41.2,lon:29,quality:'Elle',orders:[{alici:'Uzak kayıt'}],raw:'Uzak'},
    {id:2,lat:41.05,lon:29,quality:'Sokak',orders:[{alici:'Yakın kayıt'}],raw:'Yakın'}];
    getMatrix=async pts=>{const ids=[0,...pts.slice(1,-1).map(s=>s.id),3],dur=[[0,900,120,300],[900,0,800,400],[120,800,0,200],[300,400,200,0]],dist=[[0,9000,1200,3000],[9000,0,8000,4000],[1200,8000,0,2000],[3000,4000,2000,0]];return {dur:ids.map(i=>ids.map(j=>dur[i][j])),dist:ids.map(i=>ids.map(j=>dist[i][j])),osrm:true}};osrm=async()=>null;`);
  await run('buildRoute()');
  assert.equal(run('routeOrder[0].id'),2);
  assert.ok(elements.get('routeTitle').innerHTML.includes('Rota taslağı'));
  assert.ok(elements.get('result').innerHTML.includes('Depodan ilk durak: Yakın kayıt'));
  assert.ok(elements.get('result').innerHTML.includes('konum yaklaşık'));
  assert.ok(!elements.get('result').innerHTML.includes('Rotayı Yandex'));
  assert.ok(!elements.get('result').innerHTML.includes('id="deliveredBtn"'));
  run(`$('deliveredBtn').onclick()`);assert.equal(run('delivered.length'),0,'Taslak teslimata başlatılmamalı');
  run(`stops[1].quality='Elle'`);await run('buildRoute()');
  assert.ok(elements.get('result').innerHTML.includes('Rotayı Yandex'));
  assert.ok(elements.get('result').innerHTML.includes('id="deliveredBtn"'));
  // Dağıtım devamında depo yerine son teslimat kullanılır; sonrasında yalnızca ev kalır.
  run(`stops=[{id:1,lat:41.2,lon:29,quality:'Elle',orders:[],raw:'A'},{id:2,lat:41.15,lon:29,quality:'Elle',orders:[],raw:'B'}]; delivered=[stops[0]];
    var seenPts;getMatrix=async pts=>{seenPts=pts;return {dur:[[0,1,2],[1,0,1],[2,1,0]],dist:[[0,100,200],[100,0,100],[200,100,0]],osrm:true}};osrm=async()=>null;`);
  await run('buildRoute()');assert.equal(run('seenPts[0].lat'),41.2);assert.equal(run('routeOrder[0].id'),2);
  run(`delivered.push(stops[1]);getMatrix=async()=>({dur:[[0,1],[1,0]],dist:[[0,100],[100,0]],osrm:true})`);
  await run('buildRoute()');assert.equal(run('routeOrder.length'),0);assert.ok(elements.get('result').innerHTML.includes('Eve dönüş'));
  // Eski ağ yanıtı, değişmiş adres/konum sonrası yeni rotayı ezmemeli.
  run(`delivered=[];var release;getMatrix=()=>new Promise(r=>release=r);var inFlight=buildRoute();clearRoute();`);
  run(`release({dur:[[0,1,2,3],[1,0,1,2],[2,1,0,1],[3,2,1,0]],dist:[[0,1,2,3],[1,0,1,2],[2,1,0,1],[3,2,1,0]],osrm:true})`);
  await run('inFlight');assert.equal(run('routeOrder'),null);
  console.log('OK: adres/AVM ayrıştırma, ücretsiz yer teyidi, 250 mahalle rotası senaryosu, teslimat devamı ve eski yanıt koruması');
}
main().catch(e=>{console.error(e);process.exitCode=1});
