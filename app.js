const SAVE_KEY = "memory_stage_save_v1";

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
HP: ${state.enemy.hp}
잔향: ${state.enemy.echoStacks}`;

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
}

function nextTurn(state) {
  state.battle.turn += 1;
  // 적의 “압박” 같은 간단 룰(턴마다 불안정도 조금 상승)
  state.battle.collapse = Math.min(state.battle.collapseLimit, state.battle.collapse + 5);
}

function onChooseCard(state, db, card) {
  const charId = card.character_id;
  const attitude = db.charactersById[charId].attitude;
  const activeAttr = resolveActiveAttr(card, attitude);

  addLog(`【기록】${db.charName[charId]}: ${card.card_name}`);
  addLog(`【개입: ${activeAttr}】${card.desc}`);

  const { dmg, logExtra } = applyAction(state, charId, card, activeAttr);
  addLog(`→ ${state.enemy.name}에게 ${dmg} 피해. ${logExtra ? "(" + logExtra + ")" : ""}`);

  const end = checkEnd(state);
  if (end) {
    if (end === "WIN") addLog("【종료】장면이 정상적으로 완결되었다.");
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
  const [cards, characters, battles] = await Promise.all([
    loadCSV("data/character_cards.csv"),
    loadCSV("data/characters.csv"),
    loadCSV("data/battles.csv"),
  ]);

  const charactersById = Object.fromEntries(characters.map(c => [c.id, c]));
  const battlesById = Object.fromEntries(battles.map(b => [b.id, b]));

  const charName = {};
  for (const c of characters) charName[c.id] = c.name;

  const db = {
    cards,
    charactersById,
    battlesById,
    charName,
  };

  // battle maxTurn 동기화
  const state = loadState();
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
