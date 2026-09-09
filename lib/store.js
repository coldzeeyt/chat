// Lightweight JSON-file-backed data store. No native deps, so it builds
// anywhere. Writes are debounced and persisted to DATA_DIR/db.json so a
// Railway volume mounted at that path survives redeploys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_MESSAGES_PER_ROOM = 500;

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { rooms: parsed.rooms || {}, messages: parsed.messages || {} };
  } catch {
    return { rooms: {}, messages: {} };
  }
}

const state = load();
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(state), 'utf8');
    } catch (err) {
      console.error('Failed to persist store:', err.message);
    }
  }, 250);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return true;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function createRoom({ code, name, password, ownerToken, accent }) {
  const room = {
    code,
    name,
    accent: accent || '#5b6ee1',
    passwordHash: password ? hashPassword(password) : null,
    ownerToken,
    createdAt: Date.now(),
    slowMode: 0,
    closed: false,
    pinnedMessageId: null,
  };
  state.rooms[code] = room;
  state.messages[code] = [];
  scheduleSave();
  return room;
}

function getRoom(code) {
  return state.rooms[code] || null;
}

function updateRoom(code, patch) {
  const room = state.rooms[code];
  if (!room) return null;
  Object.assign(room, patch);
  scheduleSave();
  return room;
}

function getMessages(code, { before, limit = 50 } = {}) {
  const all = state.messages[code] || [];
  let slice = all;
  if (before) {
    const idx = all.findIndex((m) => m.id === before);
    slice = idx >= 0 ? all.slice(0, idx) : all;
  }
  return slice.slice(Math.max(0, slice.length - limit));
}

function addMessage(code, message) {
  if (!state.messages[code]) state.messages[code] = [];
  state.messages[code].push(message);
  if (state.messages[code].length > MAX_MESSAGES_PER_ROOM) {
    state.messages[code] = state.messages[code].slice(-MAX_MESSAGES_PER_ROOM);
  }
  scheduleSave();
  return message;
}

function findMessage(code, id) {
  return (state.messages[code] || []).find((m) => m.id === id) || null;
}

function updateMessage(code, id, patch) {
  const msg = findMessage(code, id);
  if (!msg) return null;
  Object.assign(msg, patch);
  scheduleSave();
  return msg;
}

module.exports = {
  createRoom,
  getRoom,
  updateRoom,
  getMessages,
  addMessage,
  findMessage,
  updateMessage,
  verifyPassword,
};
