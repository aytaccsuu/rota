const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function app() {
  const elements = new Map();
  function element() { return {style:{},children:[],value:'5',innerHTML:'',textContent:'',firstChild:{style:{}},
    addEventListener(){}, appendChild(x){this.children.push(x)}, querySelector(){return element()}, querySelectorAll(){return []},focus(){},classList:{add(){},remove(){}}}; }
  const context = vm.createContext({document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},addEventListener(){},createElement:element,querySelectorAll(){return []},querySelector(){return element()},body:element()},
    location:{protocol:'file:'},localStorage:{getItem(){return null},setItem(){}},window:{},setTimeout(){return 1},clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({})}),AbortSignal,console});
  vm.runInContext(source.replace(/renderPts\(\);updateState\(\);initMap\(\);\r?\nrefreshGoogleStatus\(\);/,'').replace(/uygulamaBaslat\(\);\r?\n/,''),context);
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
  // Fotoğrafta iki kez okunan satır (aynı sipariş no) tek durak/tek sipariş olmalı
  assert.equal(run(`(()=>{const st=buildStops([{sip:'162409262477306',alici:'NAZİF ÖCAL',ilce:'Kadıköy',raw:'Göztepe mah. Arı apartmanı no: 171 / Daire :6'},{sip:'162409262477306',alici:'NAZİF ÖCAL',ilce:'Kadıköy',raw:'Göztepe mah. Arı apartmanı no: 171 / Dalre :6'}]);return st.length+'|'+st[0].orders.length})()`),'1|1');
  // Yapay zekâ düzeltmesi: harita doğrulamazsa sıradaki aday, en son evraktaki yazım denenir
  {
    const ai=app();
    ai.run(`var tried=[];locateCore=async a=>{tried.push(a.street);return a.street==='Tünek Sokak'?{lat:41,lon:29,quality:'Kapı'}:{lat:41,lon:29,quality:'Mahalle'}};`);
    const r=await ai.run(`locate({raw:'x',street:'Tünelc Sokak',no:'17',mah:'Göztepe',parsed:{street:'Tünelc Sok.',no:'17'},ai:{sokak_adaylari:['Tünek Sokak'],kapi_no:'17'}})`);
    assert.equal(r.quality,'Kapı');
    assert.deepEqual(plain(ai.run('tried')),['Tünelc Sokak','Tünek Sokak']);
    ai.run(`tried=[];locateCore=async a=>{tried.push(a.street);return a.street==='Su yanı Sokak'?{quality:'Sokak'}:{quality:'Mahalle'}}`);
    const r2=await ai.run(`locate({raw:'x',street:'Çetin Emeç Bulvarı',parsed:{street:'Su yanı Sokak',no:'7'},ai:{sokak_adaylari:[]}})`);
    assert.equal(r2.quality,'Sokak','evraktaki yazım son çare olarak denenmeli');
    const r3=await ai.run(`(tried=[],locate({raw:'x',street:'A Sokak',parsed:{street:'A Sk.'},ai:{sokak_adaylari:[]}}))`);
    assert.equal(r3.quality,'Mahalle','hiçbiri bulunamazsa ilk sonuç döner');
  }
  // Yandex için KML: sıra numaralı müşteri adları, özel karakterler kaçırılmış
  {
    const k=app();
    k.run(`routeOrder=[{lat:41.01,lon:29.1,raw:'Tepegöz Sk. No:32 <A&B>',quality:'Kapı',orders:[{alici:'Berna Gülsan',musteri:'IKEA',sip:'123'}]},{lat:41.02,lon:29.2,raw:'x',quality:'Mahalle',orders:[{alici:'Can Suar'}]}];lastCoords=null;`);
    const kml=k.run(`buildKml([{lat:40.96,lon:29.21},{lat:41.01,lon:29.1},{lat:41.02,lon:29.2},{lat:41.05,lon:29.12}],false)`);
    assert.ok(kml.includes('<name>01. Berna Gülsan</name>'));
    assert.ok(kml.includes('<name>02. Can Suar</name>'));
    assert.ok(kml.includes('<name>03. Ev</name>'));
    assert.ok(kml.includes('&lt;A&amp;B&gt;'),'özel karakterler kaçırılmalı');
    assert.ok(kml.includes('29.100000,41.010000,0'),'KML koordinatı boylam,enlem olmalı');
    assert.ok(kml.includes('Konum yaklaşık'));
  }
  assert.equal(run(`buildStops([{sip:'162409262477306',alici:'NAZİF ÖCAL',ilce:'Kadıköy',raw:'Göztepe mah. Arı apartmanı no: 171'},{sip:'162609262477306',alici:'NAZİF ÖCAL',ilce:'Kadıköy',raw:'Göztepe mah. Arı apartmanı no: 171'}]).reduce((a,s)=>a+s.orders.length,0)`),1,'sipariş no farklı okunsa da aynı alıcı+adres tek sipariş');
  // Ayrıştırma: virgül sınırı ve numaradan önceki yol
  // kapı numarası farklı yazımlarla: "No 334", "N:334", "Nu 334", "numara 334", ":" olmadan
  for(const t of ['no 334','No334','No.334 D:5','N:334','N 334','Nu:334','Nr 334','numara 334','No :334','334'])
    assert.equal(run(`parseAddress('Bostancı mah. Bahçe sok ${t}','Kadıköy').no`),'334',t);
  assert.equal(run(`parseAddress('Kozyatağı mah. Baytur Kozyatağı Konutları, Şakacı Sokak, No: 16, C Blok','Kadıköy').street`),'Şakacı Sokak');
  assert.equal(run(`parseAddress('Kozyatağı mah. Baytur Kozyatağı Konutları, Şakacı Sokak, No: 16, C Blok','Kadıköy').no`),'16');
  assert.equal(run(`parseAddress('Suadiye mah. Çetin emeç bulvarı Su yanı Sokak yalı apartmanı No:7 D:1','Kadıköy').street`),'Su yanı Sokak');
  assert.equal(run(`parseAddress('Suadiye mah. Çetin emeç bulvarı Su yanı Sokak yalı apartmanı No:7 D:1','Kadıköy').no`),'7');
  assert.equal(run(`parseAddress('Göztepe mah. Göztepe mahallesi fahrettinkerimgökay caddesi Göztepe apartmanı no:254 kat:3','Kadıköy').no`),'254');
  assert.equal(run(`parseAddress('Göztepe mah. Bestekar ziya sokak Aydoğan apartmanı no8 daire 42','Kadıköy').street`),'Bestekar ziya Sokak');
  assert.equal(run(`parseAddress('Göztepe mah. Bestekar ziya sokak Aydoğan apartmanı no8 daire 42','Kadıköy').no`),'8');
  assert.equal(run(`parseAddress('Göztepe mah. Tepegöz Sk. Utku Apt. No:49/21 Kat:11','Kadıköy').street`),'Tepegöz Sokak');
  assert.equal(run(`parseAddress('X mah. Alan Sokak No:5, Bağdat Caddesi yakını','Kadıköy').street`),'Alan Sokak');
  assert.equal(run(`sameLoose('Suadiye Camii Sok.','Cami Sokak')`),true);
  assert.equal(run(`sameLoose('Çamlı Sok.','Cami Sokak')`),false,'Çamlı ile Cami farklı');
  assert.equal(run(`baseNoOk('16/1','16')`),true);
  assert.equal(run(`baseNoOk('16/1','16/2')`),false);
  assert.equal(run(`baseNoOk('161','16')`),false);
  // Plan kaydı: aday listeleri atılır, sıra ve teslim edilenler kimlikle saklanır
  {
    const pl=app();
    pl.run(`stops=[{id:1,raw:'a',lat:41,lon:29,placeCandidates:[{x:1}],match:{road:'A',candidates:[1,2]},orders:[]},{id:2,raw:'b',lat:41.1,lon:29.1,orders:[]}];delivered=[stops[1]];routeOrder=[stops[0]];lastRoute={seq:[],legs:[]};`);
    const d=plain(pl.run('planData()'));
    assert.equal(d.v,1);assert.deepEqual(d.delivered,[2]);assert.deepEqual(d.route.order,[1]);
    assert.ok(!('placeCandidates' in d.stops[0])&&!('candidates' in d.stops[0].match),'büyük aday listeleri kaydedilmez');
  }
  // Hakediş: RutPro ucretHesapla ile aynı sonuçlar (Anadolu tek ilçe: 20 nokta / 5000 ₺, +150 ₺/nokta, %20 KDV)
  {
    const H=(nokta,ex={})=>plain(run(`ucretHesapla(${JSON.stringify({bolge:'anadolu',ilceSayisi:1,nokta,...ex})})`));
    for(const [nokta,tip,net,top] of [[18,'1',5000,6000],[25,'1',5750,6900],[29,'1',6350,7620],[30,'1.5',7500,9000],[32,'1.5',7800,9360],[45,'2',10750,12900]]){
      const h=H(nokta);assert.equal(h.rutTip,tip,nokta+' nokta rut tipi');assert.equal(h.net,net,nokta+' nokta KDVsiz');assert.equal(Math.round(h.toplam),top,nokta+' nokta toplam');
    }
    assert.equal(H(30,{rutTip:'1'}).net,5000+10*150,'elle 1 rut seçilirse kapasite üstü eklenir');
    assert.equal(plain(run(`ucretHesapla({bolge:'anadolu',ilceSayisi:2,nokta:18})`)).rutTip,'1','2+ ilçede baz 18');
    assert.equal(plain(run(`ucretHesapla({bolge:'anadolu',ilceSayisi:2,nokta:27})`)).rutTip,'1.5','2+ ilçe: 18+9=27 → 1,5 rut');
    run(`fiyat={...fiyat,kmUcret:10}`);
    const ek=H(18,{hammaliye:300,ekKm:20});assert.equal(ek.net,5000+200+300,'ek km ve hammaliye KDV matrahına eklenir');assert.equal(Math.round(ek.toplam),6600);
    assert.equal(run(`ucretHesapla({bolge:'anadolu',ilceSayisi:1,nokta:0})`),null);
    assert.equal(run(`bolgeBul(['Kadıköy','Ümraniye','Şişli'])`),'anadolu');
    assert.equal(run(`bolgeBul(['KADIKÖY','Beşiktaş'])`),'anadolu','eşitlikte Anadolu');
    assert.equal(run(`bolgeBul(['Bakırköy','Bağcılar','Kadıköy'])`),'avrupa2');
  }
  // Gün düzenleme: işareti kaldırılan (teslim edilemeyen) müşteri sayılmaz; gidilmeyen günde hakediş yok
  {
    run(`fiyat=JSON.parse(JSON.stringify(DEF_FIYAT))`);
    run(`var sira=Array.from({length:31},(_,i)=>({ad:'Müşteri '+i,adres:'Adres '+i,ilce:'Kadıköy'}))`);
    assert.equal(plain(run(`gunHesap({durum:'calisti',rota:{sira}})`)).rutTip,'1.5','31 müşteri → 1,5 rut');
    const az=plain(run(`gunHesap({durum:'calisti',rota:{sira},haric:[musteriKey(sira[0]),musteriKey(sira[1])]})`));
    assert.equal(az.nokta,29);assert.equal(az.rutTip,'1','2 müşteri çıkarılınca 29 → 1 rut');assert.equal(az.net,5000+9*150);
    assert.equal(run(`gunHesap({durum:'gidilmedi',neden:'İzin',rota:{sira}})`),null);
    assert.equal(plain(run(`gunHesap({durum:'calisti',hammaliye:200,rota:{sira:sira.slice(0,10)}})`)).net,5200);
  }
  // AVM kodlu alıcı: mağaza kodu yerine AVM adı, aynı AVM tek durak
  assert.equal(run(`mallFromCode('TUR.Ist.GS.mll.METROGARDEN.I')`),'Metrogarden');
  assert.equal(run(`mallFromCode('TUR.Ist.GS.mII.CANPARK.I')`),'Canpark','fotoğrafta mII okunsa da bulunmalı');
  assert.equal(run(`mallFromCode('Fatih Katalıoğlu')`),'');
  assert.equal(run(`(()=>{const st=buildStops([{alici:'TUR.Ist.GS.mll.METROGARDEN.I',musteri:'İpekyol',ilce:'Ümraniye',raw:'Necip Fazıl Mah. Alemdağ Cad. No:940 Zemin kat 68'},{alici:'TUR.Ist.GS.mll.METROGARDEN.I',musteri:'İpekyol',ilce:'ÜMRANİYE',raw:'Necip Fazıl Mah. Alemdağ Cad. No:940 Zemin kat 68 '}]);return st.length+'|'+st[0].mall+'|'+st[0].orders[0].alici})()`),'1|Metrogarden|Metrogarden AVM (İpekyol)');
  // "4/2": önce 4/2 kapı no, sonra 4 (2 = daire); "4-6": önce aralık, sonra 4
  assert.equal(run(`JSON.stringify(noVariants('4/2'))`),JSON.stringify([{no:'4/2',daire:''},{no:'4',daire:'2'}]));
  assert.equal(run(`JSON.stringify(noVariants('4-6').map(v=>v.no))`),JSON.stringify(['4-6','4']));
  assert.equal(run(`JSON.stringify(noVariants('12A').map(v=>v.no))`),JSON.stringify(['12A']),'12A ile 12 farklı bina');
  assert.equal(run(`JSON.stringify(noVariants('45-47/1').map(v=>v.no))`),JSON.stringify(['45-47/1','45-47','45']));
  assert.equal(run(`JSON.stringify(noVariants('465/A').map(v=>v.no))`),JSON.stringify(['465/A','465','465A']));
  assert.equal(run(`noVariants('45-47/1').at(-1).daire`),'1');
  assert.equal(run(`noMatches('32','32/17')`),true,'32/17 evrakı 32 numaralı binayla eşleşmeli');
  assert.equal(run(`noOk('No:49','49')`),true,'Yandex No:49 yazar');
  assert.equal(run(`noOk('No:47A','49')`),false);
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
  assert.deepEqual(plain(run('solve([[0,1],[1,0]],0,[])')),[0,1]);
  assert.throws(()=>run('solve([[0,null],[1,0]],0,[])'));
  // Eve dönüş maliyeti son durak seçiminde gerçekten etkili olmalı.
  run(`var E=Array.from({length:5},(_,i)=>Array.from({length:5},(_,j)=>i===j?0:10));E[0][1]=1;E[1][2]=1;E[1][3]=2;E[2][3]=1;E[3][2]=1;E[2][4]=1;E[3][4]=100`);
  assert.deepEqual(plain(run("solve(E,3,['A','B','C'])")),[0,1,3,2,4]);
  // Mahalle sınırı rotayı uzatmamalı: sınırdaki durak komşu mahallenin duraklarıyla birlikte gidilmeli.
  run(`var pts=[[0,0],[1,0],[2,0],[3,0],[4,0],[5,0]];var D6=pts.map(a=>pts.map(b=>Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])));`);
  assert.deepEqual(plain(run("solve(D6,4,['A','B','A','B'])")),[0,1,2,3,4,5],'mahalle adı sırayı bozmamalı');
  assert.notEqual(run("neighborhoodKey({id:1,mah:'Atatürk',ilce:'Kadıköy'})"),run("neighborhoodKey({id:2,mah:'Atatürk',ilce:'Ümraniye'})"));
  const pathCost=(D,p)=>p.slice(1).reduce((s,j,i)=>s+D[p[i]][j],0);
  for(let seed=1;seed<=250;seed++){
    run(`var n=${seed%23+1};var keys=Array.from({length:n},(_,i)=>'mahalle'+(i%5));var D=Array.from({length:n+2},(_,i)=>Array.from({length:n+2},(_,j)=>i===j?0:((i+7)*(j+13)*${seed})%97+1));var p=solve(D,n,keys);`);
    const r=plain(run('({p,keys,n,D})'));
    assert.equal(r.p.length,r.n+2);assert.equal(new Set(r.p).size,r.n+2);
    assert.equal(r.p[0],0);assert.equal(r.p.at(-1),r.n+1);
    // en yakın-komşu sırasından asla kötü olmamalı
    const rem=new Set(Array.from({length:r.n},(_,i)=>i+1)),g=[0];let cur=0;
    while(rem.size){let b=-1,bd=Infinity;for(const j of rem)if(r.D[cur][j]<bd){bd=r.D[cur][j];b=j}g.push(b);rem.delete(b);cur=b}g.push(r.n+1);
    assert.ok(pathCost(r.D,r.p)<=pathCost(r.D,g)+1e-9,'en yakın komşudan uzun olmamalı');
    assert.deepEqual(plain(run('solve(D,n,keys)')),r.p,'aynı girdi aynı plan');
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
  run(`stops[1].quality='Elle'`);await run('buildRoute()');
  assert.ok(elements.get('result').innerHTML.includes('Rotayı Yandex'));
  assert.ok(!elements.get('result').innerHTML.includes('id="deliveredBtn"'),'Teslim edildi düğmesi kaldırıldı');
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
  // Elle düzenlenen sıra çözücü yerine kullanılır; duraklar değişince geçersiz olur.
  await new Promise(r=>setTimeout(r,50));run(`clearTimeout(autoT);delivered=[];stops=[{id:1,lat:41.2,lon:29,quality:'Elle',orders:[],raw:'A'},{id:2,lat:41.15,lon:29,quality:'Elle',orders:[],raw:'B'},{id:3,lat:41.1,lon:29,quality:'Elle',orders:[],raw:'C'}];elleSira=[3,1,2];
    getMatrix=async p=>{const m=p.map((_,i)=>p.map((_,j)=>Math.abs(i-j)));return {dur:m,dist:m,osrm:true}};osrm=async()=>null;`);
  await run('buildRoute()');assert.equal(run('routeOrder.map(s=>s.id).join()'),'3,1,2','elle sıra korunur');
  run(`stops.pop();clearTimeout(autoT)`);await run('buildRoute()');assert.equal(run('elleSira'),null,'durak değişince elle sıra düşer');assert.equal(run('routeOrder.length'),2);
  // Elle rut: bölge ve ilçe sayısı seçilir (24 nokta, Avrupa 1, 2+ ilçe → 1,5 rut 8.700)
  assert.equal(run(`gunHesap({durum:'calisti',nokta:24,bolge:'avrupa1',ilceSayisi:2,ilceler:[]}).net`),8700);
  assert.equal(run(`gunHesap({durum:'calisti',nokta:28,parcalar:[{nokta:24,bolge:'avrupa1',ilceSayisi:2},{nokta:4,bolge:'anadolu',ilceSayisi:1}]}).net`),13700);
  // günün km'si: ev → depo + dağıtım ve eve dönüş
  assert.equal(run(`gunKm({rota:{km:31.7,evDepoKm:18.5,toplamKm:50.2}})`),50.2);
  assert.equal(run(`gunKm({rota:{km:31.7,evDepoKm:18.5}})`),50.2);
  assert.equal(run(`gunKm({rota:null})`),null);
  console.log('OK: adres/AVM ayrıştırma, ücretsiz yer teyidi, 250 rota senaryosu, teslimat devamı ve eski yanıt koruması');
}
main().catch(e=>{console.error(e);process.exitCode=1});
