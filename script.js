(() => {
  "use strict";

  // ---------- Constants ----------
  const CANVAS_BASE_WIDTH = 420;
  const CANVAS_BASE_HEIGHT = 860; // base, actual size adapts to viewport
  const LANE_COUNT = 3;
  const ROAD_PADDING = 28;
  const OBSTACLE_SPAWN_INTERVAL_BASE_MS = 720; // spawn a bit more frequently
  const COIN_SPAWN_INTERVAL_BASE_MS = 1100;
  const MAX_SPEED = 15; // higher top speed
  const MIN_SPEED = 4;  // slightly faster baseline
  const ACCELERATION = 0.55;
  const DECELERATION = 0.7;
  const HZ = 60; // simulation ticks per second
  const DT = 1 / HZ;

  // ---------- Elements ----------
  const startScreen = document.getElementById("start-screen");
  const gameScreen = document.getElementById("game-screen");
  const overScreen = document.getElementById("over-screen");
  const playerForm = document.getElementById("player-form");
  const playerNameInput = document.getElementById("playerName");
  const playerAgeInput = document.getElementById("playerAge");
  const gameModeSelect = document.getElementById("gameMode");
  const carSelect = document.getElementById("carSelect");
  const carColorPicker = document.getElementById("carColor");
  const avatarSelect = document.getElementById("avatarSelect");
  const avatarCustom = document.getElementById("avatarCustom");
  const highscoreList = document.getElementById("highscoreList");
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let dpr = 1;
  let viewW = CANVAS_BASE_WIDTH;
  let viewH = CANVAS_BASE_HEIGHT;
  const scoreEl = document.getElementById("score");
  const speedEl = document.getElementById("speed");
  const timeEl = document.getElementById("time");
  const hudPlayer = document.getElementById("hudPlayer");
  const hudBadges = document.getElementById("hudBadges");
  const finalScoreEl = document.getElementById("finalScore");
  const earnedRewardsEl = document.getElementById("earnedRewards");
  const restartBtn = document.getElementById("restartBtn");
  const homeBtn = document.getElementById("homeBtn");
  const touchControls = document.getElementById("touch-controls");

  // ---------- Audio (simple oscillator-based fallback) ----------
  let audioCtx;
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
    }
  }
  function beep(frequency = 440, durationMs = 120, type = "sine", gain = 0.05) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    g.gain.value = gain;
    osc.connect(g).connect(audioCtx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); }, durationMs);
  }

  // ---------- Storage Helpers ----------
  const LS_KEY_SCORES = "speedrays_scores_v1";
  function readScores() {
    try {
      const raw = localStorage.getItem(LS_KEY_SCORES);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function writeScore(entry) {
    const all = readScores();
    all.push(entry);
    try { localStorage.setItem(LS_KEY_SCORES, JSON.stringify(all)); } catch {}
  }
  function renderHighscores() {
    const byScore = [...readScores()].sort((a,b)=>b.score-a.score).slice(0,10);
    highscoreList.innerHTML = byScore.map((e, i) => {
      const badges = Array.isArray(e.badges) && e.badges.length ? ` — ${e.badges.join(" ")}` : "";
      return `<li>#${i+1} ${e.name} (${e.age}) — ${e.score}${badges}</li>`;
    }).join("");
  }

  // ---------- UI State ----------
  let selectedCar = "sport";
  let selectedColor = carColorPicker.value;
  let selectedAvatar = "😎";

  function selectToggle(container, selector, valueAttr, onChange) {
    container.addEventListener("click", (e) => {
      const btn = e.target.closest(selector);
      if (!btn) return;
      container.querySelectorAll(selector).forEach(b=>b.setAttribute("aria-pressed","false"));
      btn.setAttribute("aria-pressed","true");
      const value = btn.getAttribute(valueAttr);
      onChange(value);
    });
  }
  selectToggle(carSelect, ".car-option", "data-car", v => selectedCar = v);
  selectToggle(avatarSelect, ".avatar-option", "data-avatar", v => { selectedAvatar = v; avatarCustom.value = ""; });
  carColorPicker.addEventListener("input", () => selectedColor = carColorPicker.value);
  avatarCustom.addEventListener("input", () => { if (avatarCustom.value.trim()) selectedAvatar = avatarCustom.value.trim(); });

  // ---------- Input ----------
  const inputState = { left:false, right:false, up:false, down:false, pause:false };
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === "ArrowLeft") inputState.left = true;
    if (e.key === "ArrowRight") inputState.right = true;
    if (e.key === "ArrowUp") inputState.up = true;
    if (e.key === "ArrowDown") inputState.down = true;
    if (e.key.toLowerCase() === "p") inputState.pause = !inputState.pause;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft") inputState.left = false;
    if (e.key === "ArrowRight") inputState.right = false;
    if (e.key === "ArrowUp") inputState.up = false;
    if (e.key === "ArrowDown") inputState.down = false;
  });

  // Touch controls
  touchControls.addEventListener("click", (e) => {
    const btn = e.target.closest(".ctrl");
    if (!btn) return;
    const act = btn.getAttribute("data-action");
    if (act === "left") pulseKey(inputState, "left");
    if (act === "right") pulseKey(inputState, "right");
    if (act === "up") pulseKey(inputState, "up");
    if (act === "down") pulseKey(inputState, "down");
  });
  function pulseKey(state, key) { state[key] = true; setTimeout(()=>state[key]=false, 120); }

  // Two-finger tap to pause
  let lastTouchCount = 0;
  window.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2 && lastTouchCount !== 2) {
      inputState.pause = !inputState.pause;
    }
    lastTouchCount = e.touches.length;
  });
  window.addEventListener("touchend", () => { lastTouchCount = 0; });

  // ---------- Game Types ----------
  /** @typedef {{x:number,y:number,w:number,h:number,type:'player'|'enemy'|'coin'|'wall'|'spot',lane?:number,color?:string,car?:string,vy?:number}} Entity */

  // ---------- Game State ----------
  const game = {
    running:false,
    over:false,
    t:0,
    elapsed:0,
    speed:MIN_SPEED,
    distance:0,
    score:0,
    player:null,
    enemies:[],
    coins:[],
    walls:[],
    spots:[],
    lanes:[],
    spawnTimers:{ enemy:0, coin:0 },
    playerMeta:null,
    badges:[],
    mode:'race',
  };

  function laneX(laneIndex) {
    const roadWidth = viewW - ROAD_PADDING*2;
    const laneWidth = roadWidth / LANE_COUNT;
    return ROAD_PADDING + laneWidth * laneIndex + laneWidth/2;
  }

  function resetGame(playerMeta){
    game.running = true;
    game.over = false;
    game.t = 0;
    game.elapsed = 0;
    game.speed = MIN_SPEED + 0.5;
    game.distance = 0;
    game.score = 0;
    game.enemies = [];
    game.coins = [];
    game.walls = [];
    game.spots = [];
    game.spawnTimers = { enemy: 0, coin: 0 };
    game.badges = [];
    game.playerMeta = playerMeta;
    game.player = /** @type {Entity} */({
      type:'player',
      x: laneX(1),
      y: viewH - 120,
      w: 54,
      h: 96,
      color: playerMeta.color,
      car: playerMeta.car,
    });
    updateHudPlayer();
    if (game.mode === 'parking') setupParkingLevel();
    ensureLevelSetup();
  }

  function setupParkingLevel(){
    // Create a simple parking lot with walls and a target spot
    const margin = 24;
    const lotW = viewW - margin*2;
    const lotH = viewH - 200;
    // outer walls
    game.walls.push({type:'wall', x:margin, y:margin+60, w:lotW, h:12});
    game.walls.push({type:'wall', x:margin, y:margin+60+lotH-12, w:lotW, h:12});
    game.walls.push({type:'wall', x:margin, y:margin+60, w:12, h:lotH});
    game.walls.push({type:'wall', x:margin+lotW-12, y:margin+60, w:12, h:lotH});
    // target parking spot (a rectangle to align into)
    const spotW = 80, spotH = 120;
    const spotX = margin + lotW - spotW - 24;
    const spotY = margin + 60 + 24;
    game.spots.push({type:'spot', x:spotX, y:spotY, w:spotW, h:spotH});
    // position player start
    if (game.player){
      game.player.x = margin + 36;
      game.player.y = margin + 60 + lotH - game.player.h - 24;
    }
  }

  function updateHudPlayer(){
    const meta = game.playerMeta;
    if (meta) {
      hudPlayer.textContent = `${meta.avatar} ${meta.name} (${meta.age})`;
      hudBadges.innerHTML = game.badges.map(b=>`<span class="badge">${b}</span>`).join("");
    }
    // Update CSS var for HUD height for precise canvas sizing
    const hud = document.getElementById("hud");
    if (hud) {
      const h = Math.ceil(hud.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--hudH', h + 'px');
    }
  }

  // ---------- Challenges ----------
  const challengeDefs = [
    { id:'time30', label:'Survive 30s', goal:30, type:'time' },
    { id:'avoid20', label:'Avoid 20 cars', goal:20, type:'avoid' },
    { id:'collect10', label:'Collect 10 coins', goal:10, type:'collect' },
    { id:'speed12', label:'Reach speed 12', goal:12, type:'speed' },
    { id:'score500', label:'Score 500 points', goal:500, type:'score' },
  ];
  const challenges = Object.fromEntries(challengeDefs.map(c=>[c.id,false]));
  let avoidedCount = 0;
  let collectedCount = 0;
  const toastContainer = document.getElementById('toastContainer');
  const levelEl = document.getElementById('level');

  function renderLevel(){ if (levelEl) levelEl.textContent = String(game.level || 1); }

  function toast(title, detail){
    if (!toastContainer) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="title">${title}</div><div>${detail||''}</div>`;
    toastContainer.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateY(6px)'; }, 2200);
    setTimeout(()=>{ el.remove(); }, 2800);
  }

  // Level objectives and progression
  const raceLevels = [
    { id:1, desc:'Survive 20s', check: () => game.elapsed >= 20 },
    { id:2, desc:'Reach score 400', check: () => game.score >= 400 },
    { id:3, desc:'Collect 8 coins', check: () => collectedCount >= 8 },
    { id:4, desc:'Survive 40s', check: () => game.elapsed >= 40 },
    { id:5, desc:'Reach score 900', check: () => game.score >= 900 },
  ];
  const parkingLevels = [
    { id:1, desc:'Park in the highlighted spot', check: () => game.over && game.badges.includes('🅿️ Parked!') },
    { id:2, desc:'Park again (smaller spot)', setup: () => shrinkSpot(0.8), check: () => game.over && game.badges.includes('🅿️ Parked!') },
    { id:3, desc:'Park again (tiny spot)', setup: () => shrinkSpot(0.65), check: () => game.over && game.badges.includes('🅿️ Parked!') },
  ];

  function shrinkSpot(scale){
    if (!game.spots[0]) return;
    const s = game.spots[0];
    const cx = s.x + s.w/2, cy = s.y + s.h/2;
    s.w = Math.max(50, Math.floor(s.w*scale));
    s.h = Math.max(80, Math.floor(s.h*scale));
    s.x = Math.floor(cx - s.w/2);
    s.y = Math.floor(cy - s.h/2);
  }

  function ensureLevelSetup(){
    if (!game.level) game.level = 1;
    renderLevel();
    if (game.mode === 'parking'){
      const def = parkingLevels.find(l=>l.id===game.level);
      def?.setup?.();
    }
  }

  // ---------- Spawning ----------
  function spawnEnemy(){
    const lane = Math.floor(Math.random()*LANE_COUNT);
    const x = laneX(lane);
    const h = 68 + Math.random()*22; // smaller obstacles
    const w = 46; // slightly narrower
    game.enemies.push({ type:'enemy', x: x - w/2, y:-h, w, h, lane, vy: game.speed + 1.2 + Math.random()*2.2 });
  }
  function spawnCoin(){
    const lane = Math.floor(Math.random()*LANE_COUNT);
    const x = laneX(lane);
    game.coins.push({ type:'coin', x:x-12, y:-18, w:24, h:24, lane, vy: game.speed + 1.4 });
  }

  // ---------- Physics ----------
  function aabb(a,b){ return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

  // ---------- Render ----------
  function drawRoad(){
    // background
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--road') || '#1a1f2e';
    ctx.fillRect(0,0,viewW,viewH);

    // scrolling lines
    const roadWidth = viewW - ROAD_PADDING*2;
    ctx.save();
    ctx.translate(ROAD_PADDING,0);
    ctx.fillStyle = "#2b3147";
    ctx.fillRect(0,0,roadWidth,canvas.height);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "rgba(203,213,255,0.18)";
    ctx.lineWidth = 4;
    const laneWidth = roadWidth / LANE_COUNT;
    const dashH = 28;
    const gap = 18;
    const offset = (game.t*game.speed*6) % (dashH+gap);
    for(let i=1;i<LANE_COUNT;i++){
      const x = i*laneWidth;
      for(let y=-offset;y<viewH;y+=dashH+gap){
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y+dashH);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawCar(ent){
    ctx.save();
    ctx.translate(ent.x + ent.w/2, ent.y + ent.h/2);
    // Car body
    ctx.fillStyle = ent.color || selectedColor;
    const bodyW = ent.w; const bodyH = ent.h;
    roundRect(-bodyW/2, -bodyH/2, bodyW, bodyH, 12);
    ctx.fill();
    // cockpit stripe style based on car type
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    const stripeW = ent.car === 'muscle' ? 16 : ent.car === 'retro' ? 10 : 12;
    ctx.fillRect(-stripeW/2, -bodyH/2+10, stripeW, bodyH-20);
    // wheels
    ctx.fillStyle = "#0b0b0f";
    const wW = 10, wH = 22;
    ctx.fillRect(-bodyW/2-4, -bodyH/2+14, wW, wH);
    ctx.fillRect(bodyW/2-6, -bodyH/2+14, wW, wH);
    ctx.fillRect(-bodyW/2-4, bodyH/2-14-wH, wW, wH);
    ctx.fillRect(bodyW/2-6, bodyH/2-14-wH, wW, wH);
    ctx.restore();
  }

  function drawEnemy(ent){
    ctx.save();
    ctx.translate(ent.x, ent.y);
    ctx.fillStyle = "#d33";
    roundRect(0,0, ent.w, ent.h, 10);
    ctx.fill();
    ctx.restore();
  }

  function drawCoin(ent){
    ctx.save();
    ctx.translate(ent.x + ent.w/2, ent.y + ent.h/2);
    ctx.fillStyle = "#ffd166";
    circle(0,0, ent.w/2);
    ctx.fill();
    ctx.fillStyle = "#b88900";
    ctx.beginPath();
    ctx.arc(0,0, ent.w/2-5, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }

  function drawParking(){
    // lot background
    ctx.fillStyle = '#24314f';
    ctx.fillRect(0,0,viewW,viewH);
    // spot
    for (const s of game.spots){
      ctx.save();
      ctx.strokeStyle = '#9ad3ff';
      ctx.setLineDash([10,8]);
      ctx.lineWidth = 3;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.restore();
    }
    // walls
    ctx.fillStyle = '#0d1326';
    for (const w of game.walls){
      roundRect(w.x, w.y, w.w, w.h, 4);
      ctx.fill();
    }
  }

  function roundRect(x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }
  function circle(x,y,r){ ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); }

  // ---------- Loop ----------
  let rafId = 0;
  function loop(ts){
    if (!game.running) return;
    if (inputState.pause){
      rafId = requestAnimationFrame(loop);
      return;
    }
    game.t += DT;
    game.elapsed += DT;

    // update speed
    if (inputState.up) game.speed = Math.min(MAX_SPEED, game.speed + ACCELERATION*DT*HZ);
    if (inputState.down) game.speed = Math.max(MIN_SPEED, game.speed - DECELERATION*DT*HZ);
    speedEl.textContent = game.speed.toFixed(0);
    timeEl.textContent = Math.floor(game.elapsed).toString();

    // player movement
    const player = game.player;
    const moveX = (inputState.left ? -1 : 0) + (inputState.right ? 1 : 0);
    const moveY = (inputState.up ? -1 : 0) + (inputState.down ? 1 : 0);
    if (game.mode === 'race'){
      player.x += moveX * 7.8;
      player.x = Math.max(ROAD_PADDING+6, Math.min(viewW - ROAD_PADDING - player.w - 6, player.x));
    } else {
      // parking free movement
      player.x += moveX * 5.2;
      player.y += moveY * 5.2;
    }

    if (game.mode === 'race'){
      // spawn timers scale with speed
      game.spawnTimers.enemy -= DT*1000;
      game.spawnTimers.coin -= DT*1000;
      const enemyInterval = Math.max(360, OBSTACLE_SPAWN_INTERVAL_BASE_MS - game.speed*40);
      const coinInterval = Math.max(420, COIN_SPAWN_INTERVAL_BASE_MS - game.speed*30);
      if (game.spawnTimers.enemy <= 0){ spawnEnemy(); game.spawnTimers.enemy = enemyInterval; }
      if (game.spawnTimers.coin <= 0){ spawnCoin(); game.spawnTimers.coin = coinInterval; }
    }

    // move enemies and coins
    const vy = game.speed * 3.9; // faster global scroll
    if (game.mode === 'race'){
      game.enemies.forEach(e => e.y += (e.vy ?? vy));
      game.coins.forEach(c => c.y += (c.vy ?? vy));
      // cull
      const beforeEnemies = game.enemies.length;
      game.enemies = game.enemies.filter(e => e.y < viewH + 60);
      avoidedCount += Math.max(0, beforeEnemies - game.enemies.length);
      game.coins = game.coins.filter(c => c.y < viewH + 40);
    }

    // collisions
    if (game.mode === 'race'){
      for (const e of game.enemies){
        if (aabb(player, e)){
          ensureAudio();
          beep(100,260,"sawtooth",0.08);
          return endGame();
        }
      }
      for (let i=game.coins.length-1;i>=0;i--){
        const c = game.coins[i];
        if (aabb(player, c)){
          game.coins.splice(i,1);
          collectedCount++;
          game.score += 15;
          ensureAudio();
          beep(1046,100,"square",0.05);
        }
      }
    } else {
      // parking collisions: walls stop player
      for (const w of game.walls){
        if (aabb(player, w)){
          // simple push back
          if (moveX > 0) player.x = w.x - player.w;
          if (moveX < 0) player.x = w.x + w.w;
          if (moveY > 0) player.y = w.y - player.h;
          if (moveY < 0) player.y = w.y + w.h;
        }
      }
      // success if player fully inside spot and aligned
      const s = game.spots[0];
      if (s && aabb(player, s)){
        ensureAudio();
        beep(1320,180,'square',0.06);
        game.badges.push('🅿️ Parked!');
        updateHudPlayer();
        return endGame();
      }
    }

    // score by survival and speed (slightly faster scoring)
    game.distance += game.speed * DT;
    game.score += Math.floor(game.speed * 0.7);
    scoreEl.textContent = game.score.toString();

    // level progression
    renderLevel();
    const currentLevels = game.mode === 'race' ? raceLevels : parkingLevels;
    const def = currentLevels.find(l=>l.id === (game.level||1));
    if (def && def.check()){
      ensureAudio();
      beep(1244,180,'sine',0.06);
      toast('Level Complete!', def.desc);
      game.level = (game.level||1) + 1;
      renderLevel();
      if (game.mode === 'race'){
        // gently increase difficulty
        game.speed = Math.min(MAX_SPEED, game.speed + 1);
      } else {
        // re-setup parking on next start
      }
    }

    // render
    ctx.clearRect(0,0,viewW,viewH);
    if (game.mode === 'race'){
      drawRoad();
      game.enemies.forEach(drawEnemy);
      game.coins.forEach(drawCoin);
      drawCar(player);
    } else {
      drawParking();
      drawCar(player);
    }

    rafId = requestAnimationFrame(loop);
  }

  function endGame(){
    game.running = false;
    game.over = true;
    cancelAnimationFrame(rafId);
    finalScoreEl.textContent = String(game.score);
    earnedRewardsEl.innerHTML = game.badges.map(b=>`<span class="badge">${b}</span>`).join("");

    // save JSON log
    const entry = {
      name: game.playerMeta.name,
      age: game.playerMeta.age,
      avatar: game.playerMeta.avatar,
      car: game.playerMeta.car,
      color: game.playerMeta.color,
      score: game.score,
      badges: [...game.badges],
      time: Math.floor(game.elapsed),
      at: new Date().toISOString()
    };
    writeScore(entry);
    renderHighscores();

    // switch screen
    gameScreen.classList.remove("active");
    overScreen.classList.add("active");
  }

  // ---------- Resize ----------
  function resizeCanvas(){
    const rect = canvas.getBoundingClientRect();
    viewW = Math.max(320, Math.floor(rect.width));
    viewH = Math.max(480, Math.floor(rect.height));
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // keep player within bounds after resize
    if (game.player){
      game.player.x = Math.max(ROAD_PADDING+6, Math.min(viewW - ROAD_PADDING - game.player.w - 6, game.player.x));
      game.player.y = Math.max(0, Math.min(viewH - 120, game.player.y));
    }
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // ---------- Navigation ----------
  playerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = playerNameInput.value.trim() || "Player";
    const age = parseInt(playerAgeInput.value, 10) || 18;
    const avatar = (avatarCustom.value.trim() || selectedAvatar).slice(0,2);
    const color = selectedColor;
    const car = selectedCar;
    const mode = (gameModeSelect?.value === 'parking') ? 'parking' : 'race';

    // JSON log: store the latest player profile in sessionStorage
    try { sessionStorage.setItem("speedrays_last_player", JSON.stringify({name, age, avatar, color, car})); } catch {}

    // setup hud
    gameScreen.classList.add("active");
    startScreen.classList.remove("active");
    document.body.classList.add('game-active');
    // reset counters
    avoidedCount = 0; collectedCount = 0; game.level = 1;
    // ensure correct canvas size before placing player
    resizeCanvas();
    renderLevel();

    // reset counters (legacy challenge flags removed)
    avoidedCount = 0; collectedCount = 0;

    game.mode = mode;
    resetGame({ name, age, avatar, color, car });
    ensureAudio();
    if (audioCtx?.state === 'suspended') { audioCtx.resume?.(); }
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  });

  restartBtn.addEventListener("click", () => {
    overScreen.classList.remove("active");
    gameScreen.classList.add("active");
    document.body.classList.add('game-active');
    avoidedCount = 0; collectedCount = 0; game.level = 1;
    resizeCanvas();
    renderLevel();
    avoidedCount = 0; collectedCount = 0;
    resetGame(game.playerMeta);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  });
  homeBtn.addEventListener("click", () => {
    overScreen.classList.remove("active");
    startScreen.classList.add("active");
    document.body.classList.remove('game-active');
  });

  // ---------- Init ----------
  renderHighscores();
  renderLevel();
  // build level grid after DOM ready
  (function buildLevelGridOnce(){
    const grid = document.getElementById('levelGrid');
    if (!grid) return;
    const total = 20;
    grid.innerHTML = '';
    for (let i=1;i<=total;i++){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'level-btn';
      btn.textContent = String(i);
      btn.addEventListener('click', () => {
        if (i > (game.unlocked||1)) return;
        game.level = i;
        renderLevel();
        // highlight
        [...grid.children].forEach(ch=>ch.classList.remove('current'));
        btn.classList.add('current');
      });
      grid.appendChild(btn);
    }
  })();
})();


