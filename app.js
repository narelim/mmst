// =======================
// 기본 설정
// =======================
const SAVE_KEY = "memory_stage_save_v1";
const STAGE_ORDER = ["stage1", "stage2", "stage3", "stage4", "boss"];
const $ = (id) => document.getElementById(id);
const ATTR_LABEL = { erosion: "침식", anchor: "고정", echo: "잔향" };

// =======================
// CSV 로딩
// =======================
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(s => s.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(",").map(s => s.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = cols[i] ?? "");
    return obj;
  });
}

async function loadCSV(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`CSV load failed: ${path}`);
  return parseCSV(await res.text());
}

// =======================
// 상태 저장
// =======================
function defaultState() {
  return {
    progress: { stageIndex: 0 },
    battle: {
      id: "stage1",
      turn: 1,
      maxTurn: 5,
      collapse: 60,
      collapseLimit: 100
    },
    enemy: null,
    party: {
      adel: { level: 1, hp: 120 },
      estel: { level: 1, hp: 150 },
      vanessa: { level: 1, hp: 100 },
    }
  };
}

function loadState() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return defaultState();
  try { return JSON.parse(raw); } catch { return defaultState(); }
}

function saveState(state) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
}

// =======================
// 적 초기화
// =======================
function initEnemy(state, db, enemyId) {
  const e = db.enemiesById[enemyId];
  if (!e) throw new Error(`Unknown enemy_id: ${enemyId}`);

  const patternQueue = (e.patterns || "")
    .split("|")
    .map(s => s.trim())
    .filter(Boolean);

  state.enemy = {
    id: enemyId,
    name: e.name,
    hp: Number(e.max_hp),
    maxHp: Number(e.max_hp),
    type: e.type,
    basePressure: Number(e.base_pressure || 0),
    patternQueue,
    patternIndex: 0,
    echoStacks: 0,
    seal: { erosion: 0, anchor: 0, echo: 0 }
  };
}

// =======================
// 속성 처리
// =======================
function resolveActiveAttr(card, attitude) {
  const a1 = card.attr1;
  const a2 = card.attr2 || "";
  if (a1 && a1 === a2) return a1;
  if (a1 === attitude) return a1;
  if (a2 === attitude) return a2;
  return a1;
}

// =======================
// 전투 로직
// =======================
function applyAction(state, card, attr) {
  const enemy = state.enemy;
  const battle = state.battle;

  let dmg = 12;
  let logExtra = "";

  if (attr === "erosion") {
    dmg = 16;
    battle.collapse = Math.min(battle.collapseLimit, battle.collapse + 15);
    logExtra = "불안정도 +15";
  } else if (attr === "anchor") {
    dmg = 10;
    battle.collapse = Math.max(0, battle.collapse - 10);
    logExtra = "불안정도 -10";
  } else if (attr === "echo") {
    dmg = 8;
    enemy.echoStacks += 1;
    logExtra = "잔향 +1";
  }

  enemy.hp = Math.max(0, enemy.hp - dmg);
  return { dmg, logExtra };
}

function applyEnemyPattern(state, db) {
  const enemy = state.enemy;

  // 기본 압박
  if (enemy.basePressure > 0) {
    state.battle.collapse = Math.min(
      state.battle.collapseLimit,
      state.battle.collapse + enemy.basePressure
    );
    addLog(`【왜곡】${enemy.name}의 압박 (+${enemy.basePressure})`);
  }

  const pid = enemy.patternQueue[enemy.patternIndex];
  if (!pid) return;

  const p = db.patternsById[pid];
  if (!p) return;

  const value = Number(p.value || 0);

  if (p.kind === "collapse") {
    state.battle.collapse += value;
    addLog(`【패턴】${p.desc}`);
  } else if (p.kind === "echo") {
    enemy.echoStacks += value;
    addLog(`【패턴】${p.desc}`);
  } else if (p.kind === "seal") {
    enemy.seal.anchor = Math.max(enemy.seal.anchor, value);
    addLog(`【패턴】${p.desc}`);
  }

  enemy.patternIndex =
    (enemy.patternIndex + 1) % enemy.patternQueue.length;
}

function nextTurn(state, db) {
  state.battle.turn += 1;

  const seal = state.enemy.seal;
  seal.erosion = Math.max(0, seal.erosion - 1);
  seal.anchor = Math.max(0, seal.anchor - 1);
  seal.echo = Math.max(0, seal.echo - 1);

  applyEnemyPattern(state, db);
}

function checkEnd(state) {
  if (state.enemy.hp <= 0) return "WIN";
  if (state.battle.collapse >= state.battle.collapseLimit) return "COLLAPSE";
  if (state.battle.turn > state.battle.maxTurn) return "TIMEOUT";
  return null;
}

// =======================
// UI
// =======================
function addLog(text) {
  const div = document.createElement("div");
  div.className = "logline";
  div.textContent = text;
  $("log").prepend(div);
}

function render(state, db) {
  const battleName =
    db.battlesById[state.battle.id]?.name ?? state.battle.id;

  $("battleTitle").textContent = `전투: ${battleName}`;
  $("battleMeta").textContent =
    `턴 ${state.battle.turn}/${state.battle.maxTurn} · 불안정도 ${state.battle.collapse}%`;

  $("enemyPanel").textContent =
`이름: ${state.enemy.name}
HP: ${state.enemy.hp}/${state.enemy.maxHp}
잔향: ${state.enemy.echoStacks}`;

  $("partyPanel").textContent =
`아델 HP ${state.party.adel.hp}
에스델 HP ${state.party.estel.hp}
바네사 HP ${state.party.vanessa.hp}`;

  $("choices").innerHTML = "";
  db.cards.forEach(card => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    const a1 = ATTR_LABEL[card.attr1] ?? "-";
    const a2 = card.attr2 ? (ATTR_LABEL[card.attr2] ?? "-") : "-";
    btn.textContent = `${db.charName[card.character_id]} · ${card.card_name}  [${a1}/${a2}]`;
    btn.onclick = () => onChooseCard(state, db, card);
    $("choices").appendChild(btn);
  });
}

// =======================
// 입력 처리
// =======================
function startNextBattle(state, db) {
  state.progress.stageIndex = Math.min(
    state.progress.stageIndex + 1,
    STAGE_ORDER.length - 1
  );

  const nextBattleId = STAGE_ORDER[state.progress.stageIndex];
  const b = db.battlesById[nextBattleId];

  state.battle.id = nextBattleId;
  state.battle.turn = 1;
  state.battle.maxTurn = Number(b.max_turn);
  state.battle.collapseLimit = Number(b.collapse_limit);
  state.battle.collapse = 40;

  initEnemy(state, db, b.enemy_id);
  addLog(`【전환】${b.name}: ${state.enemy.name}`);
}

function onChooseCard(state, db, card) {
  const charId = card.character_id;
  const attitude = db.charactersById[charId].attitude;
  const attr = resolveActiveAttr(card, attitude);
  const p = ATTR_LABEL[predicted] ?? predicted;
btn.textContent += ` → ${p}`;

  addLog(`【기록】${db.charName[charId]}: ${card.card_name}`);
  addLog(`【개입: ${attr}】${card.desc}`);

  applyAction(state, card, attr);

  const end = checkEnd(state);
  if (end === "WIN") {
    addLog("【종료】장면이 완결되었다.");
    startNextBattle(state, db);
  } else if (end === "COLLAPSE") {
    addLog("【붕괴】기록이 무너진다.");
  } else if (end === "TIMEOUT") {
    addLog("【퇴장】시간이 흘렀다.");
  } else {
    nextTurn(state, db);
  }

  saveState(state);
  render(state, db);
}

// =======================
// 부트
// =======================
(async function boot() {
  const [cards, characters, battles, enemies, patterns] = await Promise.all([
    loadCSV("data/character_cards.csv"),
    loadCSV("data/characters.csv"),
    loadCSV("data/battles.csv"),
    loadCSV("data/enemies.csv"),
    loadCSV("data/enemy_patterns.csv"),
  ]);

  const db = {
    cards,
    charactersById: Object.fromEntries(characters.map(c => [c.id, c])),
    battlesById: Object.fromEntries(battles.map(b => [b.id, b])),
    enemiesById: Object.fromEntries(enemies.map(e => [e.enemy_id, e])),
    patternsById: Object.fromEntries(patterns.map(p => [p.pattern_id, p])),
    charName: Object.fromEntries(characters.map(c => [c.id, c.name]))
  };

  const state = loadState();

  if (!state.enemy) {
    const b = db.battlesById[state.battle.id];
    initEnemy(state, db, b.enemy_id);
  }

  $("resetBtn").onclick = () => {
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  };

  addLog("【기록】무대가 열렸다. 기억은 스스로를 재현한다.");
  render(state, db);
})();
