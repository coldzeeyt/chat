(() => {
  const AVATAR_COLORS = ['#e15b5b', '#e1935b', '#d9b64c', '#6fbf6f', '#4cb8b0', '#5b8de1', '#7d6fe0', '#c15be0', '#e05b93'];
  const ROOM_ACCENTS = ['#5b6ee1', '#e1935b', '#4cb8b0', '#e15b5b', '#7d6fe0', '#4cb87a', '#c15be0'];
  const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

  // ---------- Local persistence ----------
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function getClientId() {
    let id = localStorage.getItem('chat:clientId');
    if (!id) {
      id = uid();
      localStorage.setItem('chat:clientId', id);
    }
    return id;
  }

  function getProfile() {
    try {
      return Object.assign(
        { displayName: '', avatarColor: AVATAR_COLORS[0], theme: 'system', compact: false, sound: true },
        JSON.parse(localStorage.getItem('chat:profile') || '{}')
      );
    } catch {
      return { displayName: '', avatarColor: AVATAR_COLORS[0], theme: 'system', compact: false, sound: true };
    }
  }

  function saveProfile(patch) {
    const p = Object.assign(getProfile(), patch);
    localStorage.setItem('chat:profile', JSON.stringify(p));
    return p;
  }

  function ownerTokenKey(code) { return `chat:owner:${code}`; }

  const clientId = getClientId();
  let profile = getProfile();

  function applyTheme() {
    const t = profile.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme();

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const views = { home: $('#view-home'), entry: $('#view-entry'), chat: $('#view-chat') };
  function showView(name) {
    Object.values(views).forEach((v) => v.classList.add('hidden'));
    views[name].classList.remove('hidden');
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function renderSwatches(container, selected, onPick, palette) {
    container.innerHTML = '';
    (palette || AVATAR_COLORS).forEach((color) => {
      const el = document.createElement('div');
      el.className = 'swatch' + (color === selected ? ' selected' : '');
      el.style.background = color;
      el.addEventListener('click', () => {
        container.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
        el.classList.add('selected');
        onPick(color);
      });
      container.appendChild(el);
    });
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // beep via WebAudio, no asset needed
  let audioCtx;
  function playBeep() {
    if (!profile.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.frequency.value = 720;
      g.gain.value = 0.06;
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
      o.stop(audioCtx.currentTime + 0.2);
    } catch { /* ignore */ }
  }

  // ---------- Routing ----------
  function currentRouteCode() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,10})$/);
    return m ? m[1].toUpperCase() : null;
  }

  function goToRoom(code) {
    history.pushState({}, '', `/r/${code}`);
  }
  function goHome() {
    history.pushState({}, '', '/');
    showView('home');
  }

  // ---------- Home screen ----------
  let createAccent = ROOM_ACCENTS[0];
  renderSwatches($('#create-swatches'), createAccent, (c) => (createAccent = c), ROOM_ACCENTS);

  $('#btn-create').addEventListener('click', async () => {
    const name = $('#create-name').value.trim();
    const password = $('#create-password').value;
    const btn = $('#btn-create');
    btn.disabled = true;
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password: password || undefined, accent: createAccent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create room');
      localStorage.setItem(ownerTokenKey(data.code), data.ownerToken);
      goToRoom(data.code);
      openEntry(data.code, true);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#btn-join').addEventListener('click', () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (!code) return toast('Enter a room code');
    goToRoom(code);
    openEntry(code, false);
  });
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

  // ---------- Entry screen ----------
  let entryCode = null;
  let entryIsOwner = false;

  async function openEntry(code, isOwnerFlow) {
    entryCode = code;
    entryIsOwner = isOwnerFlow;
    showView('entry');
    $('#entry-room-name').textContent = code;
    $('#entry-room-meta').textContent = 'Loading…';
    $('#entry-error').textContent = '';
    $('#entry-display-name').value = profile.displayName;
    renderSwatches($('#entry-swatches'), profile.avatarColor, (c) => (profile.avatarColor = c));

    const hasOwnerToken = !!localStorage.getItem(ownerTokenKey(code));
    $('#entry-password-field').classList.toggle('hidden', hasOwnerToken);

    try {
      const res = await fetch(`/api/rooms/${code}`);
      const data = await res.json();
      if (!res.ok) {
        $('#entry-room-meta').textContent = 'This room does not exist.';
        return;
      }
      $('#entry-room-name').textContent = data.name;
      $('#entry-room-meta').textContent = `${data.memberCount} online${data.closed ? ' · closed to new members' : ''}`;
      $('#entry-password-field').classList.toggle('hidden', !data.hasPassword || hasOwnerToken);
    } catch {
      $('#entry-room-meta').textContent = '';
    }
  }

  $('#entry-back').addEventListener('click', goHome);

  $('#btn-enter').addEventListener('click', () => {
    const name = $('#entry-display-name').value.trim();
    if (!name) return ($('#entry-error').textContent = 'Please enter a display name');
    profile = saveProfile({ displayName: name });
    joinRoom(entryCode, $('#entry-password').value);
  });
  $('#entry-display-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-enter').click(); });
  $('#entry-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-enter').click(); });

  // ---------- Socket / chat state ----------
  const socket = io();
  let room = null; // {code, name, accent, slowMode, closed, pinnedMessageId, isOwner}
  let messages = [];
  let members = [];

  function joinRoom(code, password) {
    const ownerToken = localStorage.getItem(ownerTokenKey(code)) || undefined;
    socket.emit(
      'join_room',
      { code, clientId, displayName: profile.displayName, avatarColor: profile.avatarColor, ownerToken, password },
      (res) => {
        if (!res || res.error) {
          $('#entry-error').textContent = (res && res.error) || 'Could not join room';
          return;
        }
        room = res.room;
        messages = res.messages;
        members = res.members;
        enterChat();
      }
    );
  }

  function enterChat() {
    showView('chat');
    document.documentElement.style.setProperty('--accent', room.accent);
    $('#chat-room-name').textContent = room.name;
    $('#chat-code-pill').textContent = room.code;
    renderMessages();
    renderMembers();
    renderPinned();
  }

  $('#chat-code-pill').addEventListener('click', () => {
    navigator.clipboard.writeText(room.code).then(() => toast('Room code copied'));
  });
  $('#btn-invite').addEventListener('click', () => {
    const link = `${location.origin}/r/${room.code}`;
    navigator.clipboard.writeText(link).then(() => toast('Invite link copied'));
  });
  $('#btn-members-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // ---------- Message rendering ----------
  const messagesEl = $('#messages');

  function renderMessages() {
    messagesEl.innerHTML = '';
    let prev = null;
    for (const m of messages) {
      appendMessageEl(m, prev);
      if (m.type !== 'system') prev = m;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function sameGroup(a, b) {
    if (!a || !b) return false;
    return a.clientId === b.clientId && b.createdAt - a.createdAt < 5 * 60 * 1000 && !a.deleted && !b.deleted;
  }

  function reactionsHtml(m) {
    const entries = Object.entries(m.reactions || {});
    if (!entries.length) return '';
    return `<div class="reactions">${entries
      .map(([emoji, ids]) => {
        const mine = ids.includes(clientId) ? ' mine' : '';
        return `<span class="reaction-chip${mine}" data-emoji="${emoji}">${emoji} ${ids.length}</span>`;
      })
      .join('')}</div>`;
  }

  function appendMessageEl(m, prev, container) {
    container = container || messagesEl;
    if (m.type === 'system') {
      const div = document.createElement('div');
      div.className = 'system-msg';
      div.textContent = m.deleted ? '' : m.body.replace(/<[^>]+>/g, '');
      div.dataset.id = m.id;
      container.appendChild(div);
      return;
    }

    const isCompactGroup = sameGroup(prev, m);

    const group = document.createElement('div');
    group.className = 'msg-group' + (isCompactGroup ? ' compact' : '');
    group.dataset.id = m.id;

    const avatarHtml = isCompactGroup
      ? `<div class="msg-avatar spacer"></div>`
      : `<div class="msg-avatar" style="background:${m.authorColor}">${initials(m.authorName)}</div>`;

    const canEdit = m.clientId === clientId && !m.deleted && m.type !== 'system';
    const canDelete = (m.clientId === clientId || (room && room.isOwner)) && !m.deleted;
    const canPin = room && room.isOwner && !m.deleted;

    const actionPrefix = m.type === 'action' ? `${escapeHtml(m.authorName)} ` : '';
    const bodyHtml = m.deleted
      ? `<span class="msg-bubble deleted">message deleted</span>`
      : `<span class="msg-bubble ${m.type === 'action' ? 'action' : ''}">${actionPrefix}${m.html}</span>${
          m.editedAt ? '<span class="msg-edited-tag">(edited)</span>' : ''
        }`;

    group.innerHTML = `
      ${avatarHtml}
      <div class="msg-content">
        ${isCompactGroup ? '' : `<div class="msg-meta"><span class="msg-author" style="color:${m.authorColor}">${escapeHtml(m.authorName)}</span><span class="msg-time">${formatTime(m.createdAt)}</span></div>`}
        <div class="msg-line" data-id="${m.id}">
          ${bodyHtml}
          <div class="msg-actions">
            <button data-act="react" title="React">🙂</button>
            ${canEdit ? '<button data-act="edit" title="Edit">✎</button>' : ''}
            ${canDelete ? '<button data-act="delete" title="Delete">🗑</button>' : ''}
            ${canPin ? `<button data-act="pin" title="${room.pinnedMessageId === m.id ? 'Unpin' : 'Pin'}">📌</button>` : ''}
          </div>
          <div class="emoji-picker">${QUICK_EMOJI.map((e) => `<button data-emoji="${e}">${e}</button>`).join('')}</div>
        </div>
        ${reactionsHtml(m)}
      </div>
    `;
    container.appendChild(group);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function findMessage(id) { return messages.find((m) => m.id === id); }

  function upsertMessageEl(m) {
    const idx = messages.findIndex((x) => x.id === m.id);
    if (idx === -1) return;
    messages[idx] = m;
    const prev = idx > 0 ? messages[idx - 1] : null;
    const existing = messagesEl.querySelector(`[data-id="${m.id}"]`);
    if (!existing) return;
    const wrapper = document.createElement('div');
    appendMessageEl(m, prev, wrapper);
    existing.replaceWith(wrapper.firstElementChild);
  }

  // ---------- Composer ----------
  const composerInput = $('#composer-input');
  let typingTimeout = null;

  composerInput.addEventListener('input', () => {
    socket.emit('typing', { isTyping: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit('typing', { isTyping: false }), 1500);
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    let text = composerInput.value.trim();
    if (!text) return;
    let type = 'text';

    if (text.startsWith('/me ')) {
      type = 'action';
      text = text.slice(4);
    } else if (text === '/shrug') {
      text = '¯\\_(ツ)_/¯';
    } else if (text.startsWith('/nick ')) {
      const newName = text.slice(6).trim().slice(0, 24);
      if (newName) {
        profile = saveProfile({ displayName: newName });
        socket.emit('update_profile', { displayName: profile.displayName, avatarColor: profile.avatarColor });
      }
      composerInput.value = '';
      return;
    }

    socket.emit('send_message', { body: text, type }, (res) => {
      if (res && res.error) toast(res.error);
    });
    composerInput.value = '';
    socket.emit('typing', { isTyping: false });
  });

  messagesEl.addEventListener('click', (e) => {
    const line = e.target.closest('.msg-line');
    if (!line) return;
    const id = line.dataset.id;
    const act = e.target.closest('button')?.dataset.act;
    const emojiBtn = e.target.closest('.emoji-picker button');
    const reactionChip = e.target.closest('.reaction-chip');

    if (emojiBtn) {
      socket.emit('react', { id, emoji: emojiBtn.dataset.emoji });
      line.querySelector('.emoji-picker').classList.remove('open');
      return;
    }
    if (reactionChip) {
      socket.emit('react', { id, emoji: reactionChip.dataset.emoji });
      return;
    }
    if (act === 'react') {
      line.querySelector('.emoji-picker').classList.toggle('open');
      return;
    }
    if (act === 'edit') {
      const msg = findMessage(id);
      const next = prompt('Edit message', msg.body || msg.html.replace(/<[^>]+>/g, ''));
      if (next != null && next.trim()) socket.emit('edit_message', { id, body: next.trim() });
      return;
    }
    if (act === 'delete') {
      if (confirm('Delete this message?')) socket.emit('delete_message', { id });
      return;
    }
    if (act === 'pin') {
      const msg = findMessage(id);
      const isPinned = room.pinnedMessageId === id;
      socket.emit('pin_message', { id: isPinned ? null : id });
      return;
    }
  });

  // ---------- Members / presence ----------
  function renderMembers() {
    const list = $('#member-list');
    list.innerHTML = '';
    members.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'member-item';
      li.innerHTML = `
        <span class="member-dot"></span>
        <span class="member-avatar" style="background:${m.avatarColor}">${initials(m.displayName)}</span>
        <span>${escapeHtml(m.displayName)}${m.clientId === clientId ? ' (you)' : ''}</span>
        ${m.isOwner ? '<span class="member-crown" title="Room owner">👑</span>' : ''}
      `;
      list.appendChild(li);
    });
    $('#chat-online-count').textContent = `${members.length} online`;
  }

  // ---------- Pinned bar ----------
  function renderPinned() {
    const bar = $('#pinned-bar');
    if (!room.pinnedMessageId) return bar.classList.add('hidden');
    const msg = findMessage(room.pinnedMessageId);
    if (!msg || msg.deleted) return bar.classList.add('hidden');
    bar.classList.remove('hidden');
    $('#pinned-text').textContent = `${msg.authorName}: ${msg.body}`;
  }
  $('#btn-unpin').addEventListener('click', () => socket.emit('pin_message', { id: null }));

  // ---------- Typing indicator ----------
  $('#typing-row');
  socket.on('typing_update', (names) => {
    const row = $('#typing-row');
    if (!names.length) return (row.textContent = '');
    row.textContent = names.length === 1 ? `${names[0]} is typing…` : `${names.join(', ')} are typing…`;
  });

  // ---------- Socket event handlers ----------
  socket.on('new_message', (m) => {
    messages.push(m);
    const prev = messages.length > 1 ? messages[messages.length - 2] : null;
    const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    appendMessageEl(m, prev);
    if (wasAtBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    if (m.clientId !== clientId && m.clientId !== 'system') playBeep();
  });

  socket.on('message_updated', (m) => {
    upsertMessageEl(m);
    if (room && room.pinnedMessageId === m.id) renderPinned();
  });

  socket.on('presence_update', (list) => {
    members = list;
    renderMembers();
  });

  socket.on('room_updated', (r) => {
    room = Object.assign(room || {}, r);
    document.documentElement.style.setProperty('--accent', room.accent);
    $('#chat-room-name').textContent = room.name;
    renderPinned();
  });

  socket.on('disconnect', () => toast('Disconnected — reconnecting…'));
  socket.on('connect', () => { if (room) toast('Reconnected'); });

  // ---------- Settings modal ----------
  const settingsBackdrop = $('#settings-backdrop');
  function openSettings() {
    $('#settings-name').value = profile.displayName;
    $('#settings-theme').value = profile.theme;
    $('#settings-compact').checked = profile.compact;
    $('#settings-sound').checked = profile.sound;
    renderSwatches($('#settings-swatches'), profile.avatarColor, (c) => {
      profile = saveProfile({ avatarColor: c });
      socket.emit('update_profile', { displayName: profile.displayName, avatarColor: profile.avatarColor });
    });

    const isOwner = room && room.isOwner;
    $('#not-owner-notice').classList.toggle('hidden', !!isOwner);
    ['#room-settings-name', '#room-settings-slowmode', '#room-settings-closed', '#btn-save-room'].forEach((sel) => {
      $(sel).disabled = !isOwner;
    });
    if (room) {
      $('#room-settings-name').value = room.name;
      $('#room-settings-slowmode').value = room.slowMode || 0;
      $('#room-settings-closed').checked = !!room.closed;
      renderSwatches($('#room-settings-swatches'), room.accent, (c) => {
        if (isOwner) $('#room-settings-swatches').dataset.picked = c;
      }, ROOM_ACCENTS);
      $('#room-settings-swatches').dataset.picked = room.accent;
    }
    settingsBackdrop.classList.remove('hidden');
  }
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => settingsBackdrop.classList.add('hidden'));
  settingsBackdrop.addEventListener('click', (e) => { if (e.target === settingsBackdrop) settingsBackdrop.classList.add('hidden'); });

  $('.modal-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.modal-tab');
    if (!btn) return;
    document.querySelectorAll('.modal-tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-you').classList.toggle('hidden', btn.dataset.tab !== 'you');
    $('#tab-room').classList.toggle('hidden', btn.dataset.tab !== 'room');
  });

  $('#settings-name').addEventListener('change', () => {
    const name = $('#settings-name').value.trim().slice(0, 24);
    if (!name) return;
    profile = saveProfile({ displayName: name });
    if (room) socket.emit('update_profile', { displayName: profile.displayName, avatarColor: profile.avatarColor });
  });
  $('#settings-theme').addEventListener('change', () => {
    profile = saveProfile({ theme: $('#settings-theme').value });
    applyTheme();
  });
  $('#settings-compact').addEventListener('change', () => {
    profile = saveProfile({ compact: $('#settings-compact').checked });
    renderMessages();
  });
  $('#settings-sound').addEventListener('change', () => {
    profile = saveProfile({ sound: $('#settings-sound').checked });
  });

  $('#btn-save-room').addEventListener('click', () => {
    socket.emit(
      'update_room_settings',
      {
        name: $('#room-settings-name').value,
        slowMode: Number($('#room-settings-slowmode').value) || 0,
        closed: $('#room-settings-closed').checked,
        accent: $('#room-settings-swatches').dataset.picked,
      },
      (res) => {
        if (res && res.error) toast(res.error);
        else toast('Room settings saved');
      }
    );
  });

  // ---------- Boot ----------
  window.addEventListener('popstate', () => {
    const code = currentRouteCode();
    if (code) openEntry(code, !!localStorage.getItem(ownerTokenKey(code)));
    else goHome();
  });

  (function boot() {
    const code = currentRouteCode();
    if (code) openEntry(code, !!localStorage.getItem(ownerTokenKey(code)));
    else showView('home');
  })();
})();
