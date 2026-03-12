/**
 * NEXTHOME — app.js (MQTT Edition)
 * Kết nối: Web ↔ MQTT Broker (WebSocket) ↔ ESP32
 *
 *  [Browser]
 *     ↕ ws://broker:9001  (MQTT over WebSocket)
 *  [Mosquitto Broker]
 *     ↕ TCP 1883
 *  [ESP32]
 */

const App = (() => {
  'use strict';

  const CFG = {
    brokerIP: localStorage.getItem('brokerIP') || '10.0.18.18',
    wsPort:   localStorage.getItem('wsPort')   || '9001',
    doorPIN:  localStorage.getItem('doorPIN')  || '123456',
    mqttUser: localStorage.getItem('mqttUser') || '',
    mqttPass: localStorage.getItem('mqttPass') || '',
  };

  const T = {
    CMD_RELAY: 'home/cmd/relay',
    CMD_FAN:   'home/cmd/fan',
    CMD_SERVO: 'home/cmd/servo',
    CMD_DOOR:  'home/cmd/door',
    CMD_FP:    'home/cmd/fingerprint',
    SENSOR1:   'home/sensor/dht1',
    SENSOR2:   'home/sensor/dht2',
    DOOR_EVT:  'home/door/event',
    STATUS:    'home/status',
    ACK:       'home/ack',
    ONLINE:    'home/online',
  };

  const STATE = {
    temp:0, hum:0, temp2:0, hum2:0,
    doorLocked:true, pinBuffer:'',
    acOn:false, acTarget:22, acAutoThresh:28, acAuto:true,
    fanOn:false, fanSpeed:0,
    curtainPos:100, curtainAuto:true,
    tempHistory:[], mqttClient:null, mqttConnected:false,
    guestTimer:null, guestEnd:null,
  };


  /* =========================================================  MQTT  */
  function loadMqttLib(cb) {
    if (window.mqtt) { cb(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.0.5/mqtt.min.js';
    s.onload  = cb;
    s.onerror = () => { log('❌ mqtt.js không tải được — Demo mode','warn'); startDemoMode(); };
    document.head.appendChild(s);
  }

  function mqttConnect() {
    const url = `ws://${CFG.brokerIP}:${CFG.wsPort}/mqtt`;
    log(`📡 MQTT → ${url}`, 'info');
    const opts = {
      clientId: 'nexthome_' + Math.random().toString(16).slice(2,8),
      clean: true, reconnectPeriod: 4000, connectTimeout: 8000,
    };
    if (CFG.mqttUser) { opts.username = CFG.mqttUser; opts.password = CFG.mqttPass; }

    const client = mqtt.connect(url, opts);
    STATE.mqttClient = client;

    client.on('connect', () => {
      STATE.mqttConnected = true;
      updateMQTTStatus(true);
      log('✓ MQTT broker kết nối OK','ok');
      toast('✅ Kết nối MQTT broker!','ok');
      [T.SENSOR1,T.SENSOR2,T.DOOR_EVT,T.STATUS,T.ACK,T.ONLINE].forEach(t => client.subscribe(t,{qos:1}));
    });
    client.on('message', (topic, payload) => {
      try { handleMsg(topic, JSON.parse(payload.toString())); }
      catch { handleMsg(topic, {raw: payload.toString()}); }
    });
    client.on('error',     (e) => { STATE.mqttConnected=false; updateMQTTStatus(false); log('⚠ MQTT: '+e.message,'warn'); });
    client.on('close',     ()  => { STATE.mqttConnected=false; updateMQTTStatus(false); log('ℹ MQTT ngắt — đang thử lại...','info'); });
    client.on('reconnect', ()  => log('🔄 MQTT kết nối lại...','info'));
  }

  function pub(topic, payload) {
    const msg = JSON.stringify(payload);
    if (STATE.mqttClient && STATE.mqttConnected) {
      STATE.mqttClient.publish(topic, msg, {qos:1});
    }
    log(`📤 ${topic.split('/').pop()}: ${msg}`, 'info');
  }

  /* =========================================================  MESSAGE HANDLER  */
  function handleMsg(topic, msg) {
    if (topic === T.SENSOR1) {
      STATE.temp = +msg.temp || STATE.temp;
      STATE.hum  = +msg.hum  || STATE.hum;
      STATE.tempHistory.push(STATE.temp);
      if (STATE.tempHistory.length > 20) STATE.tempHistory.shift();
      updateSensorUI(); checkAutoRules();
    } else if (topic === T.SENSOR2) {
      STATE.temp2 = +msg.temp || STATE.temp2;
      STATE.hum2  = +msg.hum  || STATE.hum2;
    } else if (topic === T.DOOR_EVT) {
      handleDoorEvent(msg);
    } else if (topic === T.STATUS) {
      syncStatus(msg);
    } else if (topic === T.ACK) {
      log(`✓ ACK: ${msg.ack}=${msg.val}`,'ok');
    } else if (topic === T.ONLINE) {
      log('🟢 ESP32 ONLINE','ok'); toast('🟢 ESP32 kết nối!','ok');
    }
  }

  function handleDoorEvent(msg) {
    const ev = msg.event;
    if (ev === 'fingerprint_ok') {
      toast(`👆 Vân tay hợp lệ ID#${msg.id}`,'ok');
      STATE.doorLocked = false; updateDoorUI();
    } else if (ev === 'fingerprint_fail') {
      toast('❌ Vân tay không khớp!','err'); fingerprintFail();
    } else if (ev === 'door_unlocked') {
      STATE.doorLocked = false; updateDoorUI();
      log(`🔓 Cửa mở — ${msg.method||'?'}`,'ok');
    } else if (ev === 'door_locked') {
      STATE.doorLocked = true; updateDoorUI(); log('🔒 Cửa khóa','info');
    } else if (ev === 'fp_enrolled') {
      toast(`✅ Vân tay ID#${msg.id} đã lưu!`,'ok');
    } else if (ev === 'fp_enrolling') {
      toast('👆 Đặt ngón tay lên AS608...','info');
    }
  }

  function syncStatus(msg) {
    if (msg.temp1 !== undefined) { STATE.temp=msg.temp1; STATE.hum=msg.hum1; }
    if (msg.relay_ac !== undefined) { STATE.acOn=msg.relay_ac; applyAC(STATE.acOn); }
    if (msg.fan_pwm !== undefined) { setFanSpeedUI(Math.round(msg.fan_pwm/255*100)); }
    if (msg.servo_angle !== undefined) { updateCurtainVisual(Math.round((1-msg.servo_angle/90)*100)); }
    updateSensorUI();
    log(`📊 Sync ESP32: T=${msg.temp1}°C`,'ok');
  }

  function updateMQTTStatus(ok) {
    const el = document.getElementById('ws-status'); if(!el) return;
    el.innerHTML = ok
      ? '<span class="chip-dot"></span> MQTT Connected'
      : '<span style="color:var(--red)">⚠ MQTT Offline</span>';
    el.className = ok ? 'chip chip--green' : 'chip';
  }

  /* =========================================================  SENSORS  */
  function updateSensorUI() {
    setEl('temp-display',  STATE.temp.toFixed(1)+'°C');
    setEl('hum-display',   STATE.hum+'%');
    setEl('climate-temp',  STATE.temp.toFixed(1));
    setEl('climate-hum',   STATE.hum+'%');
    setEl('climate-feel',  heatIndex(STATE.temp,STATE.hum).toFixed(1)+'°');
    const hi = heatIndex(STATE.temp,STATE.hum);
    const ci = document.getElementById('climate-index');
    if(ci){ ci.textContent=hi<27?'Normal':hi<32?'Caution':'Warning'; ci.style.color=hi<27?'var(--green)':hi<32?'var(--yellow)':'var(--red)'; }
    const tb=document.getElementById('temp-bar'); if(tb) tb.style.width=((STATE.temp-15)/25*100).toFixed(0)+'%';
    const hb=document.getElementById('hum-bar');  if(hb) hb.style.width=STATE.hum+'%';
    const pw=(0.3+(STATE.acOn?.8:0)+(STATE.fanOn?.05*STATE.fanSpeed/100:0)).toFixed(1);
    setEl('power-display', pw+' kW');
    const act=[STATE.acOn,STATE.fanOn].filter(Boolean).length;
    setEl('device-active', act+'/7');
    updateGauge(STATE.temp); setEl('home-gauge-text',STATE.temp.toFixed(0)+'°');
    renderSparkline();
  }

  function heatIndex(T,H){ return +(T+0.33*(H/100*6.105*Math.exp(17.27*T/(237.7+T)))-4).toFixed(1); }

  function renderSparkline() {
    const c=document.getElementById('temp-sparkline'); if(!c||STATE.tempHistory.length<2) return;
    const mn=Math.min(...STATE.tempHistory), mx=Math.max(...STATE.tempHistory)||mn+1;
    c.innerHTML=STATE.tempHistory.map(v=>`<div class="spark-bar" style="height:${Math.max(4,((v-mn)/(mx-mn+.001)*36)).toFixed(0)}px" title="${v}°C"></div>`).join('');
  }

  function updateGauge(temp) {
    const c=document.getElementById('gauge-circle'); if(!c) return;
    c.setAttribute('stroke-dashoffset',(201-Math.min(1,Math.max(0,(temp-16)/22))*201).toFixed(1));
  }

  /* =========================================================  AUTO RULES  */
  function checkAutoRules() {
    if (STATE.acAuto) {
      if (STATE.temp>STATE.acAutoThresh && !STATE.acOn){ toggleAC(true); toast(`🌡️ Tự bật AC — ${STATE.temp}°C`,'warn'); }
      else if (STATE.temp<STATE.acAutoThresh-2 && STATE.acOn){ toggleAC(false); toast('✓ Tắt AC','info'); }
    }
    if (STATE.curtainAuto) {
      const h=new Date().getHours(), sunny=h>=9&&h<=16;
      if (STATE.temp>STATE.acAutoThresh&&sunny&&STATE.curtainPos>10){ setCurtain(0); toast('🪟 Tự đóng rèm','info'); }
      else if (STATE.temp<STATE.acAutoThresh-2&&STATE.curtainPos<90){ setCurtain(100); }
    }
  }

  /* =========================================================  DEMO  */
  function startDemoMode() {
    log('▶ Demo mode (không có broker)','warn');
    function sim(){
      STATE.temp=+(Math.max(18,Math.min(38,STATE.temp+(Math.random()-.48)*.3))).toFixed(1);
      STATE.hum=Math.round(Math.max(30,Math.min(95,STATE.hum+(Math.random()-.48))));
      STATE.tempHistory.push(STATE.temp); if(STATE.tempHistory.length>20) STATE.tempHistory.shift();
      updateSensorUI(); checkAutoRules();
    }
    sim(); setInterval(sim,4000);
  }

  /* =========================================================  CLOCK  */
  function startClock() {
    function tick(){
      const n=new Date(), p=v=>String(v).padStart(2,'0');
      const cl=document.getElementById('clock'); if(cl) cl.textContent=`${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
      const dl=document.getElementById('date-display');
      if(dl){ const D=['CN','T2','T3','T4','T5','T6','T7']; dl.textContent=`${D[n.getDay()]} ${p(n.getDate())}/${p(n.getMonth()+1)}/${n.getFullYear()}`; }
    }
    tick(); setInterval(tick,1000);
  }

  /* =========================================================  DOOR  */
  function updateDoorUI() {
    const lk=STATE.doorLocked;
    toggleClass('door-big','open',!lk); toggleClass('door-panel-home','open',!lk);
    setEl('lock-icon',lk?'🔒':'🔓');
    const sp=document.getElementById('door-status-pill');
    if(sp){sp.textContent=lk?'LOCKED':'UNLOCKED'; sp.className='status-pill'+(lk?'':' open');}
    const bh=document.getElementById('door-badge-home');
    if(bh){bh.textContent=lk?'🔒 Khóa':'🔓 Mở'; bh.className='status-badge'+(lk?'':' green');}
    const la=document.getElementById('door-last-action');
    if(la){const n=new Date();la.textContent=`Lần cuối: ${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')}`;}
  }

  function pinInput(d){ if(STATE.pinBuffer.length>=6)return; STATE.pinBuffer+=d; updatePinDisplay(); }
  function pinClear(){ STATE.pinBuffer=STATE.pinBuffer.slice(0,-1); updatePinDisplay(); }
  function pinConfirm(){
    const pd=document.getElementById('pin-display');
    if(STATE.pinBuffer===CFG.doorPIN){
      pd&&pd.classList.add('success');
      STATE.doorLocked=false; updateDoorUI();
      pub(T.CMD_DOOR,{action:'unlock',method:'pin'});
      toast('🔓 Mở bằng PIN','ok'); log('✓ PIN đúng','ok');
      STATE.pinBuffer=''; setTimeout(()=>pd&&pd.classList.remove('success'),1500);
    } else {
      pd&&pd.classList.add('error');
      toast('❌ Mã PIN sai!','err'); STATE.pinBuffer='';
      setTimeout(()=>{pd&&pd.classList.remove('error');updatePinDisplay();},800);
    }
    updatePinDisplay();
  }
  function updatePinDisplay(){
    const pd=document.getElementById('pin-display'); if(!pd) return;
    pd.textContent=('●'.repeat(STATE.pinBuffer.length)+' '+'_ '.repeat(6-STATE.pinBuffer.length)).trim()||'_ _ _ _ _ _';
  }

  function simulateFingerprint(){
    const sc=document.getElementById('fp-scanner'), lb=document.getElementById('fp-label'); if(!sc) return;
    sc.classList.add('scanning'); if(lb) lb.textContent='Đang quét...';
    pub(T.CMD_FP,{action:'scan'});
    if(!STATE.mqttConnected){
      setTimeout(()=>{
        if(Math.random()>.25){
          sc.classList.replace('scanning','success'); if(lb) lb.textContent='✓ Nhận dạng';
          STATE.doorLocked=false; updateDoorUI(); toast('👆 Vân tay hợp lệ!','ok');
          setTimeout(()=>{sc.classList.remove('success');if(lb)lb.textContent='Đặt ngón tay';},2000);
        } else fingerprintFail();
      },1800);
    }
  }
  function fingerprintFail(){
    const sc=document.getElementById('fp-scanner'),lb=document.getElementById('fp-label');
    if(sc) sc.classList.add('fail'); if(lb) lb.textContent='✗ Không nhận ra';
    toast('❌ Vân tay không khớp','err');
    setTimeout(()=>{if(sc)sc.classList.remove('fail','scanning');if(lb)lb.textContent='Đặt ngón tay';},1500);
  }
  function addFingerprint(){ pub(T.CMD_FP,{action:'enroll',id:3}); toast('📡 Gửi lệnh đăng ký vân tay','info'); }
  function remoteUnlock(){ STATE.doorLocked=false; updateDoorUI(); pub(T.CMD_DOOR,{action:'unlock',method:'remote'}); toast('🔓 Mở cửa từ xa','ok'); }
  function remoteLock(){
    STATE.doorLocked=true; updateDoorUI(); pub(T.CMD_DOOR,{action:'lock'}); toast('🔒 Khóa cửa','ok');
    if(STATE.guestTimer){clearInterval(STATE.guestTimer);STATE.guestTimer=null;}
    const gt=document.getElementById('guest-timer'); if(gt) gt.style.display='none';
  }
  function guestAccess(min){
    remoteUnlock(); if(STATE.guestTimer) clearInterval(STATE.guestTimer);
    if(min>0){
      STATE.guestEnd=Date.now()+min*60000;
      const gt=document.getElementById('guest-timer'),gc=document.getElementById('guest-countdown');
      if(gt) gt.style.display='block';
      STATE.guestTimer=setInterval(()=>{
        const r=STATE.guestEnd-Date.now();
        if(r<=0){clearInterval(STATE.guestTimer);remoteLock();toast('⏱ Hết giờ khách','warn');return;}
        const m=Math.floor(r/60000),s=Math.floor((r%60000)/1000);
        if(gc) gc.textContent=`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      },1000);
    }
    toast(`👥 Cửa mở cho khách${min>0?' — '+min+'ph':''}`,'ok');
    pub(T.CMD_DOOR,{action:'guest',minutes:min});
  }

  /* =========================================================  CLIMATE  */
  function toggleAC(on){
    STATE.acOn=on; applyAC(on);
    pub(T.CMD_RELAY,{relay:1,state:on?1:0});
    toast(on?'❄️ Bật điều hòa':'⭕ Tắt điều hòa',on?'ok':'info');
    log(`Relay 1 AC: ${on?'ON':'OFF'}`,on?'ok':'info');
    const b=document.getElementById('ac-badge-home');
    if(b){b.textContent=on?'❄️ ON':'OFF';b.className='status-badge'+(on?' green':'');}
  }
  function applyAC(on){
    const t=document.getElementById('ac-toggle'); if(t) t.checked=on;
    const d=document.getElementById('ac-relay-dot'); if(d) d.className='relay-dot'+(on?' on':'');
    const l=document.getElementById('ac-relay-label'); if(l) l.textContent=`Relay 1: ${on?'ON':'OFF'}`;
  }
  function adjustAC(delta){
    STATE.acTarget=Math.max(16,Math.min(30,STATE.acTarget+delta));
    setEl('ac-target',STATE.acTarget);
    pub(T.CMD_RELAY,{relay:1,target:STATE.acTarget});
  }
  function toggleACauto(on){ STATE.acAuto=on; }
  function setACThresh(v){ STATE.acAutoThresh=parseFloat(v); }

  function toggleFan(on){ STATE.fanOn=on; setFanSpeed(on?(STATE.fanSpeed||50):0); toast(on?'🌀 Bật quạt':'⭕ Tắt quạt',on?'ok':'info'); }
  function setFanSpeed(v){
    STATE.fanSpeed=parseInt(v); setFanSpeedUI(STATE.fanSpeed);
    pub(T.CMD_FAN,{pwm:Math.round(STATE.fanSpeed/100*255)});
  }
  function setFanSpeedUI(v){
    const s=document.getElementById('fan-speed'); if(s) s.value=v;
    setEl('fan-speed-val',v+'%');
    const bl=document.getElementById('fan-blades');
    if(bl) bl.style.animation=v===0?'none':`fan-spin ${((1-v/100)*1.2+0.15).toFixed(2)}s linear infinite`;
    const tg=document.getElementById('fan-toggle'); if(tg) tg.checked=v>0;
    STATE.fanOn=v>0;
  }
  function setFanPreset(v){ setFanSpeed(v); }

  function setCurtain(pos){
    pos=Math.max(0,Math.min(100,parseInt(pos))); STATE.curtainPos=pos;
    const sl=document.getElementById('curtain-slider'); if(sl) sl.value=pos;
    setEl('curtain-pos',pos+'%');
    pub(T.CMD_SERVO,{angle:Math.round((1-pos/100)*90)});
    updateCurtainVisual(pos);
    const cs=document.getElementById('curtain-status'); if(cs) cs.textContent=pos===0?'Đóng':pos===100?'Mở':pos+'%';
    const ol=document.getElementById('curtain-l'),or_=document.getElementById('curtain-r');
    const closed=(100-pos)/2; if(ol) ol.style.width=closed/2+'%'; if(or_) or_.style.width=closed/2+'%';
  }
  function updateCurtainVisual(pos){
    const closed=(100-pos)/2;
    const cl=document.getElementById('cl-big'),cr=document.getElementById('cr-big');
    if(cl) cl.style.width=closed+'%'; if(cr) cr.style.width=closed+'%';
  }
  function setCurtainPreset(pos){ setCurtain(pos); toast(`🪟 Rèm: ${pos===0?'Đóng':pos===100?'Mở':'50%'}`,'ok'); }
  function toggleCurtainAuto(on){ STATE.curtainAuto=on; const h=document.getElementById('curtain-auto-hint'); if(h) h.style.opacity=on?'1':'0.3'; }


  /* =========================================================  TABS  */
  function switchTab(btn){
    document.querySelectorAll('.nav-pill').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    document.querySelectorAll('.tab-section').forEach(s=>s.classList.remove('active'));
    const s=document.getElementById('tab-'+btn.dataset.tab); if(s) s.classList.add('active');
  }
  function switchTabById(tab){ const b=document.querySelector(`[data-tab="${tab}"]`); if(b) switchTab(b); }

  /* =========================================================  CONFIG  */
  function openModal(){ document.getElementById('config-modal').classList.add('open'); }
  function closeModal(){ document.getElementById('config-modal').classList.remove('open'); }
  function saveConfig(){
    CFG.brokerIP=document.getElementById('esp-ip').value.trim();
    CFG.wsPort=document.getElementById('esp-port').value.trim();
    CFG.doorPIN=document.getElementById('door-pin-conf').value.trim();
    localStorage.setItem('brokerIP',CFG.brokerIP); localStorage.setItem('wsPort',CFG.wsPort); localStorage.setItem('doorPIN',CFG.doorPIN);
    closeModal(); toast('💾 Đã lưu — kết nối lại MQTT','ok');
    if(STATE.mqttClient) STATE.mqttClient.end();
    setTimeout(mqttConnect,600);
  }

  /* =========================================================  HELPERS  */
  function toast(msg,type='info'){
    const c=document.getElementById('toast-container'); if(!c) return;
    const t=document.createElement('div'); t.className=`toast ${type}`; t.textContent=msg;
    c.appendChild(t); setTimeout(()=>t.remove(),3000);
  }
  function log(msg,type='info'){
    const l=document.getElementById('log-list'); if(!l) return;
    const r=document.createElement('div'); r.className=`log-row ${type}`; r.textContent=msg;
    l.insertBefore(r,l.firstChild); if(l.children.length>14) l.lastChild.remove();
  }
  function setEl(id,val){ const e=document.getElementById(id); if(e) e.textContent=val; }
  function toggleClass(id,cls,cond){ const e=document.getElementById(id); if(e) e.classList.toggle(cls,cond); }

  /* =========================================================  INIT  */
  function init(){
    startClock(); setCurtain(100);
    const ipEl=document.getElementById('esp-ip'); if(ipEl) ipEl.value=CFG.brokerIP;
    const pEl=document.getElementById('esp-port'); if(pEl) pEl.value=CFG.wsPort;
    log('✓ NEXTHOME khởi động','ok');
    log(`📡 MQTT: ${CFG.brokerIP}:${CFG.wsPort}`,'info');
    log('ℹ Relay1=AC | Relay2=Đèn PK | Relay3=Đèn PN','info');
    log('ℹ L298N ENA→GPIO25 | Servo→GPIO18 | AS608→UART2','info');
    loadMqttLib(()=>{ mqttConnect(); setTimeout(()=>{ if(!STATE.mqttConnected) startDemoMode(); },5000); });
  }

  return {
    init, switchTab, switchTabById,
    pinInput, pinClear, pinConfirm,
    simulateFingerprint, addFingerprint,
    remoteUnlock, remoteLock, guestAccess,
    toggleAC, adjustAC, toggleACauto, setACThresh,
    toggleFan, setFanSpeed, setFanPreset,
    setCurtain, setCurtainPreset, toggleCurtainAuto,
    openModal, closeModal, saveConfig,
  };
})();

document.addEventListener('DOMContentLoaded', ()=>App.init());