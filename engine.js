/** Clockwork Wardens — deterministic, serializable simulation. No DOM dependencies. */
export const COLS = 6;
export const ROWS = 5;
export const MAX_WAVES = 12;
export const MAX_LEVEL = 3;
export const FIXED_STEP = 1 / 60;
export const TYPES = Object.freeze({
  laser: Object.freeze({ name: 'Sunlance', short: 'LASER', cost: 55, damage: 19, cooldown: 0.9, color: '#ffd166', description: 'A precise beam. Reliable single-target damage.', cells: 2 }),
  chain: Object.freeze({ name: 'Stormcoil', short: 'CHAIN', cost: 80, damage: 17, cooldown: 1.15, color: '#9a8bff', description: 'Lightning jumps to three nearby invaders.', cells: 2 }),
  mortar: Object.freeze({ name: 'Emberbell', short: 'MORTAR', cost: 95, damage: 34, cooldown: 1.9, color: '#ff987d', description: 'Explosive shells damage clustered invaders.', cells: 2 }),
  frost: Object.freeze({ name: 'Frostwheel', short: 'FROST', cost: 65, damage: 10, cooldown: 1.2, color: '#79dfe7', description: 'Chills invaders, cutting their speed in half.', cells: 2 }),
  relay: Object.freeze({ name: 'Link Gear', short: 'RELAY', cost: 18, damage: 0, cooldown: 0, color: '#c6b79a', description: 'A one-cell gear. Carries power into tight spaces.', cells: 1 }),
});

const DIRECTIONS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const isType = type => Object.hasOwn(TYPES, type);
const key = ({ x, y }) => `${x},${y}`;
const validRotation = rot => Number.isInteger(rot) && rot >= 0 && rot <= 3;
const failure = reason => ({ ok: false, reason });
const isBuild = state => state.phase === 'build';

export function cells(piece) {
  if (!piece || !isType(piece.type) || !Number.isInteger(piece.x) || !Number.isInteger(piece.y) || !validRotation(piece.rot)) return [];
  const anchor = { x: piece.x, y: piece.y };
  if (TYPES[piece.type].cells === 1) return [anchor];
  const dir = DIRECTIONS[piece.rot];
  return [anchor, { x: piece.x + dir.x, y: piece.y + dir.y }];
}

/** Returns a boolean and never mutates state. excludeId allows moving a piece. */
export function canPlace(state, piece, excludeId = null) {
  const footprint = cells(piece);
  if (!footprint.length) return false;
  const occupied = new Set([key(state.grid.core)]);
  for (const existing of state.pieces) {
    if (existing.id !== excludeId) for (const cell of cells(existing)) occupied.add(key(cell));
  }
  return footprint.every(cell => cell.x >= 0 && cell.x < state.grid.cols && cell.y >= 0 && cell.y < state.grid.rows && !occupied.has(key(cell)));
}

/** Ephemeral graph result. The state itself contains no Sets or Maps. */
export function network(state) {
  const owners = new Map([[key(state.grid.core), 'core']]);
  const adjacency = new Map([['core', new Set()]]);
  for (const piece of state.pieces) {
    adjacency.set(piece.id, new Set());
    for (const cell of cells(piece)) owners.set(key(cell), piece.id);
  }
  for (const [position, owner] of owners) {
    const [x, y] = position.split(',').map(Number);
    for (const dir of DIRECTIONS) {
      const other = owners.get(key({ x: x + dir.x, y: y + dir.y }));
      if (other !== undefined && other !== owner) adjacency.get(owner).add(other);
    }
  }
  const distanceById = new Map([['core', 0]]);
  const queue = ['core'];
  for (let i = 0; i < queue.length; i++) {
    const owner = queue[i];
    for (const other of adjacency.get(owner)) {
      if (!distanceById.has(other)) {
        distanceById.set(other, distanceById.get(owner) + 1);
        queue.push(other);
      }
    }
  }
  distanceById.delete('core');
  const connectedIds = new Set(distanceById.keys());
  const powerById = new Map(state.pieces.map(piece => [piece.id, connectedIds.has(piece.id) ? 1 + 0.2 / distanceById.get(piece.id) : 0]));
  return { connectedIds, powerById, distanceById, adjacency };
}

function makePiece(id, type, x, y, rot) {
  return { id, type, x, y, rot, level: 1, cooldown: 0, invested: TYPES[type].cost };
}

export function createGame() {
  return {
    version: 1,
    grid: { cols: COLS, rows: ROWS, core: { x: 2, y: 2 } },
    pieces: [makePiece('p1', 'laser', 2, 1, 3), makePiece('p2', 'mortar', 3, 2, 0)],
    coins: 100,
    wallHp: 100,
    maxWallHp: 100,
    wave: 0,
    maxWaves: MAX_WAVES,
    phase: 'build',
    paused: false,
    time: 0,
    waveTime: 0,
    accumulator: 0,
    enemies: [],
    spawnQueue: [],
    shots: [],
    nextPieceId: 3,
    nextEnemyId: 1,
    nextShotId: 1,
    lastReward: 0,
    waveEnemyCount: 0,
    waveSpawned: 0,
    stats: { kills: 0, leaks: 0, wavesCleared: 0, damage: 0, coinsEarned: 0 },
  };
}

export function buyPlace(state, type, x, y, rot = 0) {
  if (!isBuild(state)) return failure('Wait for the build phase.');
  if (!isType(type)) return failure('Unknown guardian.');
  const piece = makePiece(`p${state.nextPieceId}`, type, x, y, rot);
  if (!canPlace(state, piece)) return failure('That footprint is blocked or outside the board.');
  if (state.coins < TYPES[type].cost) return failure('Not enough coins.');
  state.coins -= TYPES[type].cost;
  state.nextPieceId++;
  state.pieces.push(piece);
  return { ok: true, piece };
}

export function movePiece(state, id, x, y, rot) {
  if (!isBuild(state)) return failure('Wait for the build phase.');
  const piece = state.pieces.find(candidate => candidate.id === id);
  if (!piece) return failure('Guardian not found.');
  const next = { ...piece, x, y, rot: rot ?? piece.rot };
  if (!canPlace(state, next, id)) return failure('That footprint is blocked or outside the board.');
  Object.assign(piece, next);
  return { ok: true, piece };
}

export function upgradeCost(piece) {
  if (!piece || !isType(piece.type) || piece.type === 'relay' || piece.level >= MAX_LEVEL) return 0;
  return Math.ceil(TYPES[piece.type].cost * (0.65 + 0.35 * piece.level));
}

export function upgradePiece(state, id) {
  if (!isBuild(state)) return failure('Wait for the build phase.');
  const piece = state.pieces.find(candidate => candidate.id === id);
  if (!piece) return failure('Guardian not found.');
  if (piece.type === 'relay') return failure('Link Gears cannot be upgraded.');
  if (piece.level >= MAX_LEVEL) return failure('Already at maximum level.');
  const cost = upgradeCost(piece);
  if (state.coins < cost) return failure('Not enough coins.');
  state.coins -= cost;
  piece.level++;
  piece.invested += cost;
  return { ok: true, piece };
}

export const sellValue = piece => Math.floor((piece?.invested || 0) * 0.7);

export function sellPiece(state, id) {
  if (!isBuild(state)) return failure('Wait for the build phase.');
  const index = state.pieces.findIndex(piece => piece.id === id);
  if (index < 0) return failure('Guardian not found.');
  const refund = sellValue(state.pieces[index]);
  state.pieces.splice(index, 1);
  state.coins += refund;
  return { ok: true, refund };
}

export const REPAIR_COST = 25;
export const REPAIR_AMOUNT = 25;
export function repairWall(state) {
  if (!isBuild(state)) return failure('Wait for the build phase.');
  if (state.wallHp >= state.maxWallHp) return failure('The wall is already at full strength.');
  if (state.coins < REPAIR_COST) return failure('Not enough coins.');
  state.coins -= REPAIR_COST;
  state.wallHp = Math.min(state.maxWallHp, state.wallHp + REPAIR_AMOUNT);
  return { ok: true };
}

/** Preview is deterministic and contains no mutable references to state. */
export function waveInfo(wave) {
  const number = Math.max(1, Math.min(MAX_WAVES, Math.floor(wave)));
  return {
    number,
    count: 10 + number * 2 + (number % 4 === 0 ? 1 : 0),
    boss: number % 4 === 0,
    reward: 42 + number * 12,
    name: number === 12 ? 'The Hollow King' : number % 4 === 0 ? 'Iron Colossus' : number % 3 === 0 ? 'The Quickening' : 'The Encroaching Mist',
  };
}

function prepareWave(wave) {
  const info = waveInfo(wave);
  const ordinary = info.count - (info.boss ? 1 : 0);
  const queue = [];
  for (let i = 0; i < ordinary; i++) {
    let type = 'grunt';
    if (wave >= 2 && i % 5 === 2) type = 'runner';
    if (wave >= 3 && i % 7 === 5) type = 'brute';
    queue.push({ at: i * (12 / ordinary), type, lane: (i * 3 + wave) % 5 });
  }
  if (info.boss) queue.push({ at: 11.8, type: 'boss', lane: 2 });
  return queue.sort((a, b) => a.at - b.at);
}

export function startWave(state) {
  if (!isBuild(state)) return failure('A wave is already running or the campaign is over.');
  if (state.wave >= MAX_WAVES) return failure('The campaign is complete.');
  state.wave++;
  state.phase = 'wave';
  state.paused = false;
  state.waveTime = 0;
  state.accumulator = 0;
  state.lastReward = 0;
  state.spawnQueue = prepareWave(state.wave);
  state.waveEnemyCount = state.spawnQueue.length;
  state.waveSpawned = 0;
  state.enemies = [];
  state.shots = [];
  for (const piece of state.pieces) piece.cooldown = 0;
  return { ok: true, info: waveInfo(state.wave) };
}

function spawnEnemy(state, entry) {
  const hpScale = 28 + state.wave * 9 + Math.max(0, state.wave - 3) ** 2 * 4.5;
  const specs = {
    grunt: { hp: hpScale, speed: 0.043 + state.wave * 0.0012, damage: 7, reward: 2 },
    runner: { hp: hpScale * 0.66, speed: 0.075 + state.wave * 0.001, damage: 4, reward: 2 },
    brute: { hp: hpScale * 2.4, speed: 0.034 + state.wave * 0.0007, damage: 12, reward: 4 },
    boss: { hp: 250 + state.wave * 82, speed: 0.023 + state.wave * 0.0005, damage: 40, reward: 25 },
  };
  const spec = specs[entry.type];
  state.enemies.push({
    id: `e${state.nextEnemyId++}`, type: entry.type, x: 1, y: 0.16 + entry.lane * 0.17,
    hp: spec.hp, maxHp: spec.hp, speed: spec.speed, damage: spec.damage, reward: spec.reward,
    slowUntil: 0, slowFactor: 1, born: state.time,
  });
  state.waveSpawned++;
}

function damageEnemy(state, enemy, amount) {
  if (enemy.hp <= 0) return;
  const dealt = Math.min(enemy.hp, amount);
  enemy.hp = Math.max(0, enemy.hp - amount);
  state.stats.damage += dealt;
  if (enemy.hp === 0) {
    state.stats.kills++;
    state.coins += enemy.reward;
    state.stats.coinsEarned += enemy.reward;
  }
}

function fire(state, piece, power) {
  const alive = state.enemies.filter(enemy => enemy.hp > 0).sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
  if (!alive.length) return false;
  const target = alive[0];
  const spec = TYPES[piece.type];
  const damage = spec.damage * (1 + 0.6 * (piece.level - 1)) * power;
  let targets = [target];
  if (piece.type === 'chain') {
    const remaining = alive.slice(1);
    let previous = target;
    while (targets.length < 3 && remaining.length) {
      remaining.sort((a, b) => Math.hypot(a.x - previous.x, a.y - previous.y) - Math.hypot(b.x - previous.x, b.y - previous.y));
      const next = remaining.shift();
      if (Math.hypot(next.x - previous.x, next.y - previous.y) > 0.36) break;
      targets.push(next);
      previous = next;
    }
  } else if (piece.type === 'mortar') {
    targets = alive.filter(enemy => Math.hypot(enemy.x - target.x, enemy.y - target.y) <= 0.235);
  }
  for (let i = 0; i < targets.length; i++) {
    const enemy = targets[i];
    damageEnemy(state, enemy, damage * (piece.type === 'chain' ? Math.pow(0.82, i) : 1));
    if (piece.type === 'frost') {
      enemy.slowFactor = enemy.type === 'boss' ? 0.72 : 0.48;
      enemy.slowUntil = state.time + 2.4 + (piece.level - 1) * 0.35;
    }
  }
  const ttl = piece.type === 'mortar' ? 0.42 : piece.type === 'chain' ? 0.3 : 0.22;
  state.shots.push({ id: `s${state.nextShotId++}`, type: piece.type, pieceId: piece.id, from: { x: piece.x, y: piece.y }, to: { x: target.x, y: target.y }, targets: targets.map(enemy => ({ x: enemy.x, y: enemy.y })), ttl, maxTtl: ttl });
  return true;
}

function tick(state) {
  state.time += FIXED_STEP;
  for (const shot of state.shots) shot.ttl -= FIXED_STEP;
  state.shots = state.shots.filter(shot => shot.ttl > 0);
  if (state.phase !== 'wave') return;
  state.waveTime += FIXED_STEP;
  while (state.spawnQueue.length && state.spawnQueue[0].at <= state.waveTime + 1e-9) spawnEnemy(state, state.spawnQueue.shift());
  const net = network(state);
  for (const piece of state.pieces) {
    if (!TYPES[piece.type].damage) continue;
    piece.cooldown = Math.max(0, piece.cooldown - FIXED_STEP);
    if (net.connectedIds.has(piece.id) && piece.cooldown <= 1e-9 && fire(state, piece, net.powerById.get(piece.id))) {
      piece.cooldown = TYPES[piece.type].cooldown * (1 - 0.1 * (piece.level - 1));
    }
  }
  state.enemies = state.enemies.filter(enemy => enemy.hp > 0);
  for (const enemy of state.enemies) {
    if (enemy.slowUntil <= state.time) enemy.slowFactor = 1;
    enemy.x -= enemy.speed * enemy.slowFactor * FIXED_STEP;
    if (enemy.x <= 0) {
      state.wallHp = Math.max(0, state.wallHp - enemy.damage);
      state.stats.leaks++;
    }
  }
  state.enemies = state.enemies.filter(enemy => enemy.x > 0);
  if (state.wallHp <= 0) {
    state.phase = 'lost';
    state.paused = false;
    state.spawnQueue = [];
    return;
  }
  if (!state.spawnQueue.length && !state.enemies.length) {
    const reward = waveInfo(state.wave).reward;
    state.coins += reward;
    state.stats.coinsEarned += reward;
    state.lastReward = reward;
    state.stats.wavesCleared = state.wave;
    state.phase = state.wave === MAX_WAVES ? 'won' : 'build';
    state.paused = false;
  }
}

/** dt is elapsed seconds. Fixed steps make play independent of render rate. */
export function update(state, dt) {
  if (state.paused || !Number.isFinite(dt) || dt <= 0 || state.phase === 'lost' || state.phase === 'won') return state;
  // A single call may simulate a whole wave, but reject accidental huge deltas.
  state.accumulator += Math.min(dt, 300);
  while (state.accumulator + 1e-10 >= FIXED_STEP) {
    state.accumulator = Math.max(0, state.accumulator - FIXED_STEP);
    tick(state);
    if (state.phase === 'won' || state.phase === 'lost') {
      state.accumulator = 0;
      break;
    }
  }
  return state;
}

/** Convenient JSON-safe save point for localStorage or replay comparisons. */
export function snapshot(state) {
  return JSON.parse(JSON.stringify(state));
}
