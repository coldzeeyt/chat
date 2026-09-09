const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const store = require('./lib/store');
const { generateCode } = require('./lib/codes');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- REST API ----------

app.post('/api/rooms', (req, res) => {
  const { name, password, accent } = req.body || {};
  const roomName = (name || '').trim().slice(0, 60) || 'Untitled Room';

  let code;
  do {
    code = generateCode();
  } while (store.getRoom(code));

  const ownerToken = nanoid(24);
  store.createRoom({ code, name: roomName, password, ownerToken, accent });

  res.json({ code, ownerToken });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = store.getRoom(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    name: room.name,
    accent: room.accent,
    hasPassword: !!room.passwordHash,
    closed: room.closed,
    memberCount: (io.sockets.adapter.rooms.get(room.code) || new Set()).size,
  });
});

app.post('/api/rooms/:code/join', (req, res) => {
  const room = store.getRoom(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.closed) return res.status(403).json({ error: 'This room is closed' });
  const { password } = req.body || {};
  if (room.passwordHash && !store.verifyPassword(password || '', room.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.json({ ok: true });
});

// ---------- Realtime ----------

const AVATAR_COLORS = ['#e15b5b', '#e1935b', '#d9b64c', '#6fbf6f', '#4cb8b0', '#5b8de1', '#7d6fe0', '#c15be0', '#e05b93'];
const lastMessageAt = new Map(); // clientId -> timestamp, for slow mode
const typingState = new Map(); // roomCode -> Set of display names currently typing

function sanitize(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderBody(raw) {
  let text = sanitize(raw);
  text = text.replace(/```([\s\S]+?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return text;
}

function presenceList(code) {
  const room = io.sockets.adapter.rooms.get(code) || new Set();
  const members = [];
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data.member) members.push(s.data.member);
  }
  return members;
}

function broadcastPresence(code) {
  io.to(code).emit('presence_update', presenceList(code));
}

function publicMessage(m) {
  if (m.deleted) {
    return { id: m.id, deleted: true, createdAt: m.createdAt, type: m.type };
  }
  return {
    id: m.id,
    clientId: m.clientId,
    authorName: m.authorName,
    authorColor: m.authorColor,
    body: m.body,
    html: m.type === 'text' || m.type === 'action' ? renderBody(m.body) : sanitize(m.body),
    type: m.type,
    createdAt: m.createdAt,
    editedAt: m.editedAt || null,
    reactions: m.reactions || {},
  };
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ code, clientId, displayName, avatarColor, ownerToken, password }, cb) => {
    code = String(code || '').toUpperCase();
    const room = store.getRoom(code);
    if (!room) return cb && cb({ error: 'Room not found' });
    const isOwnerAttempt = !!ownerToken && ownerToken === room.ownerToken;
    if (room.closed && !isOwnerAttempt) return cb && cb({ error: 'This room is closed' });
    if (room.passwordHash && !isOwnerAttempt && !store.verifyPassword(password || '', room.passwordHash)) {
      return cb && cb({ error: 'Incorrect password' });
    }

    const name = String(displayName || 'Guest').trim().slice(0, 24) || 'Guest';
    const color = AVATAR_COLORS.includes(avatarColor)
      ? avatarColor
      : AVATAR_COLORS[Math.abs(hashCode(clientId)) % AVATAR_COLORS.length];

    socket.data.code = code;
    socket.data.clientId = clientId;
    socket.data.isOwner = isOwnerAttempt;
    socket.data.member = { clientId, displayName: name, avatarColor: color, isOwner: socket.data.isOwner };

    socket.join(code);

    const history = store.getMessages(code, { limit: 50 }).map(publicMessage);
    cb && cb({
      ok: true,
      room: {
        code: room.code,
        name: room.name,
        accent: room.accent,
        slowMode: room.slowMode,
        closed: room.closed,
        pinnedMessageId: room.pinnedMessageId,
        isOwner: socket.data.isOwner,
      },
      messages: history,
      members: presenceList(code),
    });

    const joinMsg = store.addMessage(code, {
      id: nanoid(12),
      clientId: 'system',
      authorName: 'System',
      authorColor: '#888',
      body: `${name} joined the room`,
      type: 'system',
      createdAt: Date.now(),
    });
    socket.to(code).emit('new_message', publicMessage(joinMsg));
    broadcastPresence(code);
  });

  socket.on('send_message', ({ body, type }, cb) => {
    const { code, clientId, member } = socket.data;
    if (!code || !member) return cb && cb({ error: 'Not in a room' });
    const room = store.getRoom(code);
    if (!room || room.closed) return cb && cb({ error: 'Room unavailable' });

    const text = String(body || '').trim();
    if (!text) return cb && cb({ error: 'Empty message' });
    if (text.length > 2000) return cb && cb({ error: 'Message too long' });

    if (room.slowMode > 0) {
      const last = lastMessageAt.get(clientId) || 0;
      const elapsed = (Date.now() - last) / 1000;
      if (elapsed < room.slowMode) {
        return cb && cb({ error: `Slow mode: wait ${Math.ceil(room.slowMode - elapsed)}s` });
      }
    }
    lastMessageAt.set(clientId, Date.now());

    const message = store.addMessage(code, {
      id: nanoid(12),
      clientId,
      authorName: member.displayName,
      authorColor: member.avatarColor,
      body: text,
      type: type === 'action' ? 'action' : 'text',
      createdAt: Date.now(),
      reactions: {},
    });
    io.to(code).emit('new_message', publicMessage(message));
    cb && cb({ ok: true, id: message.id });
  });

  socket.on('edit_message', ({ id, body }, cb) => {
    const { code, clientId } = socket.data;
    const msg = store.findMessage(code, id);
    if (!msg || msg.clientId !== clientId || msg.deleted) return cb && cb({ error: 'Cannot edit this message' });
    const text = String(body || '').trim().slice(0, 2000);
    if (!text) return cb && cb({ error: 'Empty message' });
    store.updateMessage(code, id, { body: text, editedAt: Date.now() });
    io.to(code).emit('message_updated', publicMessage(store.findMessage(code, id)));
    cb && cb({ ok: true });
  });

  socket.on('delete_message', ({ id }, cb) => {
    const { code, clientId, isOwner } = socket.data;
    const msg = store.findMessage(code, id);
    if (!msg) return cb && cb({ error: 'Not found' });
    if (msg.clientId !== clientId && !isOwner) return cb && cb({ error: 'Not allowed' });
    store.updateMessage(code, id, { deleted: true, body: '' });
    io.to(code).emit('message_updated', publicMessage(store.findMessage(code, id)));
    cb && cb({ ok: true });
  });

  socket.on('react', ({ id, emoji }, cb) => {
    const { code, clientId } = socket.data;
    const msg = store.findMessage(code, id);
    if (!msg || msg.deleted) return cb && cb({ error: 'Not found' });
    msg.reactions = msg.reactions || {};
    const set = new Set(msg.reactions[emoji] || []);
    if (set.has(clientId)) set.delete(clientId);
    else set.add(clientId);
    msg.reactions[emoji] = Array.from(set);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    store.updateMessage(code, id, { reactions: msg.reactions });
    io.to(code).emit('message_updated', publicMessage(msg));
    cb && cb({ ok: true });
  });

  socket.on('update_profile', ({ displayName, avatarColor }) => {
    const { code, member } = socket.data;
    if (!code || !member) return;
    const oldName = member.displayName;
    const newName = String(displayName || oldName).trim().slice(0, 24) || oldName;
    const newColor = AVATAR_COLORS.includes(avatarColor) ? avatarColor : member.avatarColor;
    member.displayName = newName;
    member.avatarColor = newColor;
    if (newName !== oldName) {
      const sysMsg = store.addMessage(code, {
        id: nanoid(12),
        clientId: 'system',
        authorName: 'System',
        authorColor: '#888',
        body: `${oldName} is now known as ${newName}`,
        type: 'system',
        createdAt: Date.now(),
      });
      io.to(code).emit('new_message', publicMessage(sysMsg));
    }
    broadcastPresence(code);
  });

  socket.on('typing', ({ isTyping }) => {
    const { code, member } = socket.data;
    if (!code || !member) return;
    if (!typingState.has(code)) typingState.set(code, new Map());
    const set = typingState.get(code);
    if (isTyping) set.set(member.clientId, member.displayName);
    else set.delete(member.clientId);
    socket.to(code).emit('typing_update', Array.from(set.values()));
  });

  socket.on('pin_message', ({ id }, cb) => {
    const { code, isOwner } = socket.data;
    if (!isOwner) return cb && cb({ error: 'Owner only' });
    const room = store.updateRoom(code, { pinnedMessageId: id || null });
    io.to(code).emit('room_updated', publicRoom(room));
    cb && cb({ ok: true });
  });

  socket.on('update_room_settings', (patch, cb) => {
    const { code, isOwner } = socket.data;
    if (!isOwner) return cb && cb({ error: 'Owner only' });
    const room = store.getRoom(code);
    if (!room) return cb && cb({ error: 'Not found' });

    const update = {};
    if (typeof patch.name === 'string') update.name = patch.name.trim().slice(0, 60) || room.name;
    if (typeof patch.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.accent)) update.accent = patch.accent;
    if (typeof patch.slowMode === 'number') update.slowMode = Math.max(0, Math.min(120, Math.floor(patch.slowMode)));
    if (typeof patch.closed === 'boolean') update.closed = patch.closed;

    const updated = store.updateRoom(code, update);
    io.to(code).emit('room_updated', publicRoom(updated));
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const { code, member } = socket.data;
    if (!code || !member) return;
    if (typingState.has(code)) {
      typingState.get(code).delete(member.clientId);
      socket.to(code).emit('typing_update', Array.from(typingState.get(code).values()));
    }
    setImmediate(() => {
      const stillPresent = presenceList(code).some((m) => m.clientId === member.clientId);
      if (!stillPresent) {
        const leaveMsg = store.addMessage(code, {
          id: nanoid(12),
          clientId: 'system',
          authorName: 'System',
          authorColor: '#888',
          body: `${member.displayName} left the room`,
          type: 'system',
          createdAt: Date.now(),
        });
        io.to(code).emit('new_message', publicMessage(leaveMsg));
      }
      broadcastPresence(code);
    });
  });
});

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    accent: room.accent,
    slowMode: room.slowMode,
    closed: room.closed,
    pinnedMessageId: room.pinnedMessageId,
  };
}

function hashCode(str) {
  let hash = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chatroom server listening on port ${PORT}`);
});
