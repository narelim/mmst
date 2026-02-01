const SAVE_KEY = "memory_stage_save_v1";
const ENEMY_ORDER = ["distorted_core", "loop_fragment", "anchor_guard", "collapse_beast", "boss_mask"];

// ---------- CSV 파서(간단 버전) ----------
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(s => s.trim());
  return lines.slice(1).map(line => {
    // desc에 쉼표 들어갈 경우 대비는 MVP에선 생략(나중에 PapaParse로 교체 가능)
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

// ---------- 게임 상태 ----------
function defaultState() {
  return {
    progress: { enemyIndex: 0 },
    battle: { id: "purify", turn: 1, maxTurn: 5, collapse: 60, collapseLimit: 100 },
    enemy: { name: "왜곡된 기억", hp: 200, echoStacks: 2 },
    party: {
      adel: { level: 1, hp: 120 },
      estel: { level: 1, hp: 150 },
      vanessa: { level: 1, hp: 100 },
    },
    cleared: {},
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
    patternQueue,          // ["pressure", "echo_loop", ...]
    patternIndex: 0,       // 현재 적용할 패턴 인덱스
    echoStacks: 0,
    seal: { erosion: 0, anchor: 0, echo: 0 } // “봉인” 턴 수 (0이면 없음)
  };
}
// ---------- 속성/성향 로직 ----------
function resolveActiveAttr(card, characterAttitude) {
  const a1 = card.attr1;
  const a2 = card.attr2 || "";
  if (a1 && a1 === a2) return a1;               // echo|echo 같은 “고정”
  if (a1 === characterAttitude) return a1;
  if (a2 === characterAttitude) return a2;
  return a1;                                     // 기본값
}

// ---------- 전투 처리(초간단) ----------
function applyAction(state, actorId, card, activeAttr) {
  // “공격 1회 = 속성 1개” 고정.
  // MVP에선 속성마다 효과를 단순화:
  // erosion: 붕괴 +, 피해 + / anchor: 붕괴 -, 피해 중 / echo: 잔향 +, 피해 -
  const enemy = state.enemy;
  const battle = state.battle;

  let dmg = 12;
  let logExtra = "";

  if (activeAttr === "erosion") {
    dmg = 16;
    battle.collapse = Math.min(battle.collapseLimit, battle.collapse + 15);
    logExtra = `불안정도 +15`;
  } else if (activeAttr === "anchor") {
    dmg = 10;
    battle.collapse = Math.max(0, battle.collapse - 10);
    logExtra = `불안정도 -10`;
  } else if (activeAttr === "echo") {
    dmg = 8;
    enemy.echoStacks += 1;
    logExtra = `잔향 +1`;
  }

  enemy.hp = Math.max(0, enemy.hp - dmg);

  return { dmg, logExtra };
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);

function addLog(text) {
  const div = document.createElement("div");
  div.className = "logline";
  div.textContent = text;
  $("log").prepend(div);
}

function render(state, db) {
  const battleName = db.battlesById[state.battle.id]?.name ?? state.battle.id;
  $("battleTitle").textContent = `전투: ${battleName}`;
  $("battleMeta").textContent = `턴 ${state.battle.turn}/${state.battle.maxTurn} · 불안정도 ${state.battle.collapse}%`;

$("enemyPanel").textContent =
`이름: ${state.enemy.name}
HP: ${state.enemy.hp}/${state.enemy.maxHp}
잔향: ${state.enemy.echoStacks}
패턴: ${state.enemy.patternQueue[state.enemy.patternIndex] ?? "-"}

(봉인) 침식:${state.enemy.seal.erosion} 고정:${state.enemy.seal.anchor} 잔향:${state.enemy.seal.echo}`;
  $("partyPanel").textContent =
`아델 HP ${state.party.adel.hp} (Lv ${state.party.adel.level})
에스델 HP ${state.party.estel.hp} (Lv ${state.party.estel.level})
바네사 HP ${state.party.vanessa.hp} (Lv ${state.party.vanessa.level})`;

  // 선택지: “캐릭터 카드” 버튼들
  $("choices").innerHTML = "";
  db.cards.forEach(card => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${db.charName[card.character_id]} · ${card.card_name}`;
    btn.onclick = () => onChooseCard(state, db, card);
    $("choices").appendChild(btn);
  });
}

function checkEnd(state) {
  if (state.enemy.hp <= 0) return "WIN";
  if (state.battle.collapse >= state.battle.collapseLimit) return "COLLAPSE";
  if (state.battle.turn > state.battle.maxTurn) return "TIMEOUT";
  return null;

function nextTurn(state, db) {
  state.battle.turn += 1;

  // 봉인 턴 감소
  const seal = state.enemy.seal;
  seal.erosion = Math.max(0, seal.erosion - 1);
  seal.anchor  = Math.max(0, seal.anchor  - 1);
  seal.echo    = Math.max(0, seal.echo    - 1);

  // 적 패턴 적용
  applyEnemyPattern(state, db);
}
  
function applyEnemyPattern(state, db) {
  // 보스 페이즈 예시: HP 50% 이하가 되면 패턴 인덱스를 강제로 1로(두 번째 패턴부터)
if (enemy.type === "boss" && enemy.hp <= enemy.maxHp * 0.5) {
  enemy.patternIndex = Math.max(enemy.patternIndex, 1);
}
  
  const enemy = state.enemy;

  // 기본 압박 (매턴 공통)
  if (enemy.basePressure > 0) {
    state.battle.collapse = Math.min(
      state.battle.collapseLimit,
      state.battle.collapse + enemy.basePressure
    );
    addLog(`【왜곡】${enemy.name}의 압박. (불안정도 +${enemy.basePressure})`);
  }

  // 패턴 큐에서 현재 패턴 하나 적용
  const pid = enemy.patternQueue[enemy.patternIndex];
  if (!pid) return;

  const p = db.patternsById[pid];
  if (!p) return;

  const kind = p.kind;
  const value = Number(p.value || 0);

  if (kind === "collapse") {
    state.battle.collapse = Math.min(
      state.battle.collapseLimit,
      state.battle.collapse + value
    );
    addLog(`【패턴: ${p.name}】${p.desc} (불안정도 +${value})`);
  } else if (kind === "echo") {
    enemy.echoStacks += value;
    addLog(`【패턴: ${p.name}】${p.desc} (잔향 +${value})`);
  } else if (kind === "seal") {
    // 간단 룰: 다음 1턴 동안 "고정"을 봉인 (원하면 랜덤/순환도 가능)
    enemy.seal.anchor = Math.max(enemy.seal.anchor, value);
    addLog(`【패턴: ${p.name}】${p.desc} (고정 봉인 ${value}턴)`);
  }

  // 다음 패턴으로 이동(순환)
  enemy.patternIndex = (enemy.patternIndex + 1) % enemy.patternQueue.length;
}

function startNextBattle(state, db) {
  state.progress = state.progress || { enemyIndex: 0 };
  state.progress.enemyIndex = Math.min(state.progress.enemyIndex + 1, ENEMY_ORDER.length - 1);

  const nextId = ENEMY_ORDER[state.progress.enemyIndex];
  initEnemy(state, db, nextId);

  // 전투 상태 리셋(원하는 만큼만)
  state.battle.turn = 1;
  state.battle.collapse = 40; // 다음 전투 시작 불안정도(취향)
  addLog(`【전환】다음 장면이 열렸다: ${state.enemy.name}`);
}
  
function onChooseCard(state, db, card) {
  const charId = card.character_id;
  const attitude = db.charactersById[charId].attitude;
  const activeAttr = resolveActiveAttr(card, attitude);

// 봉인 처리: 봉인된 속성이 발현되려 하면, 카드의 다른 속성으로 우회하거나 실패
const seal = state.enemy.seal;
if (activeAttr === "anchor" && seal.anchor > 0) {
  // 카드에 다른 속성이 있으면 그쪽으로 우회
  const fallback = (card.attr1 === "anchor") ? (card.attr2 || "") : card.attr1;
  if (fallback && fallback !== "anchor") {
    addLog(`【봉인】고정이 막혔다. 개입이 ${fallback}로 변환된다.`);
    // 우회
    // (주의: 우회 시에도 공격 1회=속성1개 원칙 유지)
    var finalAttr = fallback;
  } else {
    addLog(`【봉인】고정이 막혔다. 개입이 실패했다.`);
    saveState(state);
    render(state, db);
    return;
  }
} else {
  var finalAttr = activeAttr;
}
  
  addLog(`【기록】${db.charName[charId]}: ${card.card_name}`);
  addLog(`【개입: ${activeAttr}】${card.desc}`);

  const { dmg, logExtra } = applyAction(state, charId, card, finalAttr);
  addLog(`【개입: ${finalAttr}】${card.desc}`);

  const end = checkEnd(state);
  if (end) {
   if (end === "WIN") {
  addLog("【종료】장면이 정상적으로 완결되었다.");
  startNextBattle(state, db);
}
    if (end === "COLLAPSE") addLog("【붕괴】기록이 불안정해졌다. 현실에 혼란이 번진다.");
  if (end === "TIMEOUT") addLog("【퇴장】시간이 흘렀다. 장면은 다음 회차로 이월된다.");
    saveState(state);
    render(state, db);
    return;
  }

  nextTurn(state);
  saveState(state);
  render(state, db);
}

// ---------- 부트 ----------
(async function boot() {
const [cards, characters, battles, enemies, patterns] = await Promise.all([
  loadCSV("data/character_cards.csv"),
  loadCSV("data/characters.csv"),
  loadCSV("data/battles.csv"),
  loadCSV("data/enemies.csv"),
  loadCSV("data/enemy_patterns.csv"),
]);

  const charactersById = Object.fromEntries(characters.map(c => [c.id, c]));
  const battlesById = Object.fromEntries(battles.map(b => [b.id, b]));
  const enemiesById = Object.fromEntries(enemies.map(e => [e.enemy_id, e]));
  const patternsById = Object.fromEntries(patterns.map(p => [p.pattern_id, p]));

  const charName = {};
  for (const c of characters) charName[c.id] = c.name;

  const db = {
    cards,
    charactersById,
    battlesById,
    enemiesById,
    patternsById,
    charName,
  };
  
  // battle maxTurn 동기화
  const state = loadState();
  state.enemy = {
  id: "distorted_core",
  name: enemyData.name,
  hp: enemyData.max_hp,
  maxHp: enemyData.max_hp,
  pattern: enemyData.pattern
};
  // 적 초기화 (처음 시작할 때만)
if (!state.enemy || !state.enemy.id) {
  const enemyId = "distorted_core"; // 임시: 기본 적
  const enemyData = db.enemiesById[enemyId];

  state.enemy = {
    id: enemyId,
    name: enemyData.name,
    hp: Number(enemyData.max_hp),
    maxHp: Number(enemyData.max_hp),
    pattern: enemyData.pattern,
    echoStacks: 0
  };
}
  const b = battlesById[state.battle.id];
  if (b) {
    state.battle.maxTurn = Number(b.max_turn);
    state.battle.collapseLimit = Number(b.collapse_limit);
  }
  saveState(state);

  $("resetBtn").onclick = () => {
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  };

  addLog("【기록】무대가 열렸다. 기억은 스스로를 재현한다.");
  render(state, db);
})();
