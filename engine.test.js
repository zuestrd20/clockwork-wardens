import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPES, COLS, ROWS, MAX_WAVES, MAX_LEVEL, FIXED_STEP, REPAIR_COST,
  createGame, cells, canPlace, network, buyPlace, movePiece, upgradePiece,
  upgradeCost, sellPiece, sellValue, repairWall, waveInfo, startWave, update, snapshot,
} from './engine.js';

const clone = value => JSON.parse(JSON.stringify(value));
function rejectsWithoutMutation(state, action) {
  const before = clone(state);
  assert.equal(action().ok, false);
  assert.deepEqual(state, before);
}
function runWave(state) {
  let elapsed = 0;
  while (state.phase === 'wave' && elapsed < 150) {
    update(state, 0.1);
    elapsed += 0.1;
  }
  assert.notEqual(state.phase, 'wave', 'Wave must terminate in bounded time');
}
function findConnectedSpot(state, type) {
  const candidates = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) for (let rot = 0; rot < 4; rot++) {
    const piece = { id: 'candidate', type, x, y, rot };
    if (!canPlace(state, piece)) continue;
    const net = network({ ...state, pieces: [...state.pieces, piece] });
    if (net.connectedIds.has(piece.id)) candidates.push({ x, y, rot, distance: net.distanceById.get(piece.id) });
  }
  return candidates.sort((a, b) => a.distance - b.distance)[0];
}
function enemy(id, x, y, hp = 1000) {
  return { id, type: 'grunt', x, y, hp, maxHp: hp, speed: 0.05, damage: 7, reward: 2, slowUntil: 0, slowFactor: 1, born: 0 };
}
function combatFixture(type = 'laser') {
  const state = createGame();
  state.pieces = [{ id: 'p1', type, x: 2, y: 1, rot: 3, level: 1, cooldown: 0, invested: TYPES[type].cost }];
  startWave(state);
  state.spawnQueue = [{ at: 999, type: 'grunt', lane: 0 }];
  return state;
}

test('fresh game is serializable, solvent, legal, and connected', () => {
  const state = createGame();
  assert.deepEqual(clone(state), state);
  assert.equal(state.phase, 'build');
  assert.equal(state.wave, 0);
  assert.equal(state.coins, 100);
  assert.equal(state.wallHp, 100);
  assert.equal(state.grid.cols, 6);
  assert.equal(state.grid.rows, 5);
  assert.equal(network(state).connectedIds.size, 2);
  for (const piece of state.pieces) assert.ok(canPlace(state, piece, piece.id));
  assert.notEqual(createGame().pieces, state.pieces);
});

test('rotation defines the full two-cell footprint; relays occupy one cell', () => {
  const piece = { type: 'laser', x: 2, y: 2, rot: 0 };
  const tails = [{ x: 3, y: 2 }, { x: 2, y: 3 }, { x: 1, y: 2 }, { x: 2, y: 1 }];
  for (let rot = 0; rot < 4; rot++) assert.deepEqual(cells({ ...piece, rot }), [{ x: 2, y: 2 }, tails[rot]]);
  assert.deepEqual(cells({ ...piece, type: 'relay' }), [{ x: 2, y: 2 }]);
  for (const rot of [-1, 4, 0.5, NaN]) assert.deepEqual(cells({ ...piece, rot }), []);
  for (const type of ['unknown', '__proto__', 'constructor']) assert.deepEqual(cells({ ...piece, type }), []);
});

test('placement rejects board edges, occupied gear tails, core and fractional coordinates', () => {
  const state = createGame();
  for (const proposal of [
    { x: 5, y: 0, rot: 0 }, { x: 0, y: 0, rot: 2 }, { x: 0, y: 4, rot: 1 },
    { x: 0, y: 0, rot: 3 }, { x: 2, y: 2, rot: 2 }, { x: 1, y: 2, rot: 0 },
    { x: 1, y: 0, rot: 0 }, { x: 0.5, y: 0, rot: 0 },
  ]) assert.equal(canPlace(state, { type: 'laser', ...proposal }), false);
  assert.equal(canPlace(state, { type: 'laser', x: 0, y: 0, rot: 1 }), true);
  assert.equal(canPlace(state, state.pieces[0]), false);
  assert.equal(canPlace(state, state.pieces[0], state.pieces[0].id), true);
});

test('purchases, invalid types, insufficient money and collision are atomic', () => {
  const state = createGame();
  for (const type of ['nonsense', '__proto__', 'constructor']) rejectsWithoutMutation(state, () => buyPlace(state, type, 0, 0, 1));
  rejectsWithoutMutation(state, () => buyPlace(state, 'laser', 2, 2));
  const purchase = buyPlace(state, 'chain', 0, 0, 1);
  assert.equal(purchase.ok, true);
  assert.equal(purchase.piece.id, 'p3');
  assert.equal(state.coins, 20);
  assert.equal(state.nextPieceId, 4);
  rejectsWithoutMutation(state, () => buyPlace(state, 'laser', 0, 3, 1));
  rejectsWithoutMutation(state, () => buyPlace(state, 'relay', 0, 0));
  assert.equal(network(state).connectedIds.has(purchase.piece.id), false);
});

test('moves preserve investment and upgrades; invalid moves are atomic', () => {
  const state = createGame();
  upgradePiece(state, 'p1');
  const before = clone(state.pieces[0]);
  assert.equal(movePiece(state, 'p1', 1, 2, 2).ok, true);
  assert.equal(state.pieces[0].level, before.level);
  assert.equal(state.pieces[0].invested, before.invested);
  assert.equal(state.pieces[0].rot, 2);
  rejectsWithoutMutation(state, () => movePiece(state, 'p1', 2, 2, 0));
  rejectsWithoutMutation(state, () => movePiece(state, 'missing', 0, 0, 0));
});

test('orthogonal meshing transmits power through a relay and removal breaks it', () => {
  const state = createGame();
  state.pieces = [];
  const far = buyPlace(state, 'laser', 0, 0, 1).piece;
  assert.equal(network(state).connectedIds.has(far.id), false);
  const relay = buyPlace(state, 'relay', 1, 2).piece;
  assert.equal(network(state).connectedIds.has(far.id), false, 'Diagonal contact must not connect');
  buyPlace(state, 'relay', 0, 2);
  const net = network(state);
  assert.equal(net.connectedIds.has(far.id), true);
  assert.equal(net.distanceById.get(far.id), 3);
  assert.ok(net.powerById.get(relay.id) > net.powerById.get(far.id));
  sellPiece(state, relay.id);
  assert.equal(network(state).connectedIds.has(far.id), false);
  assert.equal(network(state).powerById.get(far.id), 0);
});

test('upgrade caps at level three, charges shown price, and refund includes upgrades', () => {
  const state = createGame();
  const piece = state.pieces[0];
  assert.equal(upgradeCost(piece), 55);
  assert.equal(upgradePiece(state, piece.id).ok, true);
  assert.equal(piece.level, 2);
  assert.equal(piece.invested, 110);
  rejectsWithoutMutation(state, () => upgradePiece(state, piece.id));
  state.coins = 200;
  const cost = upgradeCost(piece);
  assert.equal(upgradePiece(state, piece.id).ok, true);
  assert.equal(state.coins, 200 - cost);
  assert.equal(piece.level, MAX_LEVEL);
  assert.equal(upgradeCost(piece), 0);
  rejectsWithoutMutation(state, () => upgradePiece(state, piece.id));
  const refund = Math.floor(piece.invested * 0.7);
  assert.equal(sellValue(piece), refund);
  assert.equal(sellPiece(state, piece.id).refund, refund);
  assert.equal(state.coins, 200 - cost + refund);
  rejectsWithoutMutation(state, () => sellPiece(state, 'missing'));
});

test('relays cannot upgrade and missing piece IDs do not mutate state', () => {
  const state = createGame();
  const relay = buyPlace(state, 'relay', 1, 2).piece;
  assert.equal(upgradeCost(relay), 0);
  rejectsWithoutMutation(state, () => upgradePiece(state, relay.id));
  rejectsWithoutMutation(state, () => upgradePiece(state, 'missing'));
});

test('repairs cost coins, cap at maximum HP, and reject waste or insolvency', () => {
  const state = createGame();
  rejectsWithoutMutation(state, () => repairWall(state));
  state.wallHp = 90;
  assert.equal(repairWall(state).ok, true);
  assert.equal(state.wallHp, 100);
  assert.equal(state.coins, 100 - REPAIR_COST);
  state.wallHp = 40;
  state.coins = REPAIR_COST - 1;
  rejectsWithoutMutation(state, () => repairWall(state));
});

test('all transactions reject outside the build phase without mutation', () => {
  for (const phase of ['wave', 'lost', 'won']) {
    const state = createGame();
    state.phase = phase;
    state.wallHp = 50;
    for (const action of [
      () => buyPlace(state, 'relay', 0, 0), () => movePiece(state, 'p1', 1, 2, 2),
      () => upgradePiece(state, 'p1'), () => sellPiece(state, 'p1'),
      () => repairWall(state), () => startWave(state),
    ]) rejectsWithoutMutation(state, action);
  }
});

test('wave previews and finite queues agree, with bosses only on 4/8/12', () => {
  for (let wave = 1; wave <= MAX_WAVES; wave++) {
    const state = createGame();
    state.wave = wave - 1;
    state.paused = true;
    assert.equal(startWave(state).ok, true);
    const info = waveInfo(wave);
    assert.equal(state.waveEnemyCount, info.count);
    assert.equal(state.spawnQueue.length, info.count);
    assert.equal(state.spawnQueue.filter(entry => entry.type === 'boss').length, wave % 4 === 0 ? 1 : 0);
    assert.equal(state.phase, 'wave');
    assert.equal(state.paused, false);
    assert.ok(Math.max(...state.spawnQueue.map(entry => entry.at)) <= 12);
    rejectsWithoutMutation(state, () => startWave(state));
  }
});

test('connected laser attacks nearest threat; disconnected guardian is inert', () => {
  const state = combatFixture();
  state.enemies = [enemy('near', 0.3, 0.5), enemy('far', 0.7, 0.5)];
  update(state, FIXED_STEP);
  assert.ok(state.enemies[0].hp < 1000);
  assert.equal(state.enemies[1].hp, 1000);
  assert.equal(state.shots.length, 1);
  assert.equal(state.shots[0].from.x, 2);
  assert.equal(state.shots[0].to.x, 0.3);
  assert.ok(state.shots[0].ttl > 0);
  const disconnected = combatFixture();
  Object.assign(disconnected.pieces[0], { x: 0, y: 0, rot: 1 });
  disconnected.enemies = [enemy('target', 0.5, 0.5)];
  update(disconnected, 1);
  assert.equal(disconnected.enemies[0].hp, 1000);
  assert.equal(disconnected.shots.length, 0);
});

test('chain jumps at most three times; mortar splashes; frost slows then expires', () => {
  const chain = combatFixture('chain');
  chain.enemies = [enemy('a', 0.3, 0.5), enemy('b', 0.35, 0.5), enemy('c', 0.4, 0.5), enemy('d', 0.45, 0.5)];
  update(chain, FIXED_STEP);
  assert.equal(chain.enemies.filter(target => target.hp < 1000).length, 3);
  assert.equal(chain.shots[0].targets.length, 3);
  const mortar = combatFixture('mortar');
  mortar.enemies = [enemy('a', 0.3, 0.5), enemy('b', 0.35, 0.6), enemy('c', 0.8, 0.5)];
  update(mortar, FIXED_STEP);
  assert.equal(mortar.enemies.filter(target => target.hp < 1000).length, 2);
  const frost = combatFixture('frost');
  frost.enemies = [enemy('a', 0.7, 0.5)];
  update(frost, FIXED_STEP);
  assert.ok(frost.enemies[0].slowFactor < 1);
  frost.pieces = [];
  update(frost, 3);
  assert.equal(frost.enemies[0].slowFactor, 1);
});

test('kills reward exactly once even when several guardians fire at the same enemy', () => {
  const state = combatFixture();
  state.pieces.push({ ...state.pieces[0], id: 'p2', x: 3, y: 2, rot: 0 });
  state.enemies = [enemy('fragile', 0.5, 0.5, 1)];
  const coins = state.coins;
  update(state, FIXED_STEP);
  assert.equal(state.stats.kills, 1);
  assert.equal(state.coins, coins + 2);
  assert.equal(state.stats.damage, 1);
});

test('pause, zero, negative and invalid dt leave every state field untouched', () => {
  const state = createGame();
  startWave(state);
  for (const dt of [0, -1, NaN, Infinity, undefined]) {
    const before = clone(state);
    update(state, dt);
    assert.deepEqual(state, before);
  }
  state.paused = true;
  const before = clone(state);
  update(state, 99);
  assert.deepEqual(state, before);
});

test('fixed-step simulation produces matching outcomes across render rates', () => {
  const a = createGame();
  const b = createGame();
  startWave(a);
  startWave(b);
  update(a, 6);
  for (let frame = 0; frame < 360; frame++) update(b, 1 / 60);
  assert.ok(Math.abs(a.accumulator - b.accumulator) < 1e-9);
  a.accumulator = b.accumulator;
  assert.deepEqual(a, b);
});

test('snapshot is detached and a restored save resumes deterministically', () => {
  const state = createGame();
  startWave(state);
  update(state, 5);
  const saved = snapshot(state);
  update(state, 5);
  update(saved, 5);
  assert.deepEqual(state, saved);
  const copy = snapshot(state);
  copy.pieces[0].level = 99;
  assert.notEqual(copy.pieces[0].level, state.pieces[0].level);
});

test('an undefended wall loses, never goes negative, and cannot restart', () => {
  const state = createGame();
  state.pieces = [];
  state.wallHp = 7;
  startWave(state);
  runWave(state);
  assert.equal(state.phase, 'lost');
  assert.equal(state.wallHp, 0);
  assert.equal(state.lastReward, 0);
  assert.equal(state.spawnQueue.length, 0);
  rejectsWithoutMutation(state, () => startWave(state));
  const final = clone(state);
  update(state, 100);
  assert.deepEqual(state, final);
});

test('the untouched starting pair eventually loses without building or upgrades', () => {
  const state = createGame();
  const startingPieces = clone(state.pieces).map(({ cooldown, ...piece }) => piece);
  while (state.phase === 'build' && state.wave < MAX_WAVES) {
    assert.equal(startWave(state).ok, true);
    runWave(state);
  }
  assert.equal(state.phase, 'lost', 'Progression must require investment beyond the two free guardians');
  assert.equal(state.wallHp, 0);
  assert.ok(state.wave > 1 && state.wave < MAX_WAVES, 'Starter pair should teach the basics before the difficulty catches up');
  assert.deepEqual(state.pieces.map(({ cooldown, ...piece }) => piece), startingPieces);
});

test('a legal, affordable build-and-upgrade strategy completes all twelve waves', () => {
  const state = createGame();
  const additions = ['frost', 'chain', 'laser', 'mortar', 'chain', 'laser', 'mortar', 'laser'];
  for (let wave = 1; wave <= MAX_WAVES; wave++) {
    while (state.pieces.length < 10) {
      const type = additions[state.pieces.length - 2];
      if (state.coins < TYPES[type].cost) break;
      const spot = findConnectedSpot(state, type);
      assert.ok(spot);
      assert.equal(buyPlace(state, type, spot.x, spot.y, spot.rot).ok, true);
    }
    for (const piece of [...state.pieces].sort((a, b) => a.level - b.level)) {
      if (piece.type !== 'frost' && piece.level < MAX_LEVEL && state.coins >= upgradeCost(piece)) assert.equal(upgradePiece(state, piece.id).ok, true);
    }
    assert.ok(state.coins >= 0);
    assert.equal(network(state).connectedIds.size, state.pieces.length);
    assert.equal(startWave(state).ok, true);
    runWave(state);
    assert.notEqual(state.phase, 'lost', `Strategy lost wave ${wave}`);
    assert.equal(state.stats.wavesCleared, wave);
    assert.equal(state.lastReward, waveInfo(wave).reward);
  }
  assert.equal(state.phase, 'won');
  assert.equal(state.wave, MAX_WAVES);
  assert.ok(state.wallHp > 0);
  assert.equal(state.stats.kills + state.stats.leaks, 279);
  rejectsWithoutMutation(state, () => startWave(state));
});
