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
  const views = {
    home: $('#view-home'),
    entry: $('#view-entry'),
    chat: $('#view-chat'),
    omegleWait: $('#view-omegle-wait'),
  };
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
    walkieTeardown();
    omegleFullTeardown();
    history.pushState({}, '', '/');
    showView('home');
  }

  // ---------- Home screen ----------
  let createAccent = ROOM_ACCENTS[0];
  renderSwatches($('#create-swatches'), createAccent, (c) => (createAccent = c), ROOM_ACCENTS);

  document.querySelectorAll('.create-tabs .modal-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.create-tabs .modal-tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      $('#create-panel-room').classList.toggle('hidden', btn.dataset.createTab !== 'room');
      $('#create-panel-settings').classList.toggle('hidden', btn.dataset.createTab !== 'settings');
    });
  });

  $('#create-live-mode').addEventListener('change', () => {
    if ($('#create-live-mode').checked) $('#create-walkie-mode').checked = false;
  });
  $('#create-walkie-mode').addEventListener('change', () => {
    const isWalkie = $('#create-walkie-mode').checked;
    if (isWalkie) $('#create-live-mode').checked = false;
    $('#create-max-members').disabled = isWalkie;
    $('#create-max-members').value = isWalkie ? 2 : '';
  });

  $('#btn-create').addEventListener('click', async () => {
    const name = $('#create-name').value.trim();
    const password = $('#create-password').value;
    const maxMembers = parseInt($('#create-max-members').value, 10);
    const liveMode = $('#create-live-mode').checked;
    const walkieMode = $('#create-walkie-mode').checked;
    const btn = $('#btn-create');
    btn.disabled = true;
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          password: password || undefined,
          accent: createAccent,
          liveMode,
          walkieMode,
          maxMembers: Number.isFinite(maxMembers) ? maxMembers : undefined,
        }),
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
      const bits = [data.maxMembers ? `${data.memberCount}/${data.maxMembers} online` : `${data.memberCount} online`];
      if (data.liveMode) bits.push('live mode');
      if (data.closed) bits.push('closed to new members');
      $('#entry-room-meta').textContent = bits.join(' · ');
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
  let room = null; // {code, name, accent, slowMode, closed, liveMode, maxMembers, pinnedMessageId, isOwner}
  let messages = [];
  let members = [];
  let liveDrafts = {}; // clientId -> in-progress text, for members other than self

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
        liveDrafts = res.liveDrafts || {};
        enterChat();
      }
    );
  }

  function enterChat() {
    showView('chat');
    selfLiveDraft = '';
    walkieTeardown();
    if (!room.omegle) omegleFullTeardown();
    document.documentElement.style.setProperty('--accent', room.accent);
    $('#chat-room-name').textContent = room.omegle ? 'Stranger Chat' : room.name;
    $('#chat-code-pill').classList.toggle('hidden', !!room.omegle);
    if (!room.omegle) $('#chat-code-pill').textContent = room.code;
    $('#btn-members-toggle').classList.toggle('hidden', !!room.omegle);
    $('#btn-invite').classList.toggle('hidden', !!room.omegle);
    $('#btn-settings').classList.toggle('hidden', !!room.omegle);
    $('#btn-omegle-camera').classList.toggle('hidden', !room.omegle);
    $('#btn-omegle-new').classList.toggle('hidden', !room.omegle);
    $('#btn-omegle-leave').classList.toggle('hidden', !room.omegle);
    $('#sidebar').classList.toggle('hidden', !!room.omegle);
    $('#sidebar').classList.remove('open');
    if (room.omegle) {
      omegleUpdateCameraButton(omegleCameraOn);
      $('#omegle-self-tile').classList.toggle('hidden', !omegleCameraOn);
      omegleShowVideoRowIfNeeded();
    }
    renderMessages();
    renderMembers();
    renderPinned();
    applyLiveModeVisibility();
  }

  function applyLiveModeVisibility() {
    const isLive = !!(room && room.liveMode);
    const isWalkie = !!(room && room.walkieMode);
    $('#chat-live-pill').classList.toggle('hidden', !isLive);
    $('#chat-walkie-pill').classList.toggle('hidden', !isWalkie);
    $('#messages').classList.toggle('hidden', isLive);
    $('#composer').classList.toggle('hidden', isLive);
    $('#typing-row').classList.toggle('hidden', isLive);
    $('#live-grid').classList.toggle('hidden', !isLive);
    $('#walkie-panel').classList.toggle('hidden', !isWalkie);
    if (isLive) $('#pinned-bar').classList.add('hidden');
    $('#composer-input').placeholder = room && room.omegle ? 'Say hi…' : 'Message… (try /me or /shrug)';
    if (isLive) renderLiveGrid();
    if (isWalkie) walkieMaybeNegotiate();
    else walkieTeardown();
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

  // ---------- Omegle (random stranger) mode ----------
  $('#btn-omegle-start').addEventListener('click', () => {
    showView('omegleWait');
    $('#omegle-wait-title').textContent = 'Looking for someone…';
    $('#omegle-wait-text').textContent = 'Hang tight, connecting you with a stranger.';
    socket.emit('omegle_find', { clientId, displayName: profile.displayName || 'Guest', avatarColor: profile.avatarColor });
  });

  $('#omegle-wait-back').addEventListener('click', () => {
    socket.emit('omegle_stop');
    goHome();
  });

  $('#btn-omegle-new').addEventListener('click', () => {
    omegleClosePC();
    socket.emit('omegle_skip');
    showView('omegleWait');
    $('#omegle-wait-title').textContent = 'Looking for someone…';
    $('#omegle-wait-text').textContent = 'Finding you a new stranger.';
  });

  $('#btn-omegle-leave').addEventListener('click', () => {
    omegleFullTeardown();
    socket.emit('omegle_stop');
    room = null;
    goHome();
  });

  socket.on('omegle_matched', (payload) => {
    omegleClosePC();
    room = payload.room;
    messages = [];
    members = payload.members;
    liveDrafts = {};
    const other = members.find((m) => m.clientId !== clientId);
    omeglePolite = other ? clientId > other.clientId : false;
    enterChat();
    appendSystemNotice("You're now chatting with a stranger. Say hi!");
    toast("You're connected with a stranger");
    if (omegleCameraOn && omegleLocalStream) {
      const pc = omegleGetOrCreatePC();
      omegleLocalStream.getVideoTracks().forEach((t) => pc.addTrack(t, omegleLocalStream));
      socket.emit('webrtc_signal', { type: 'camera_state', on: true });
    }
  });

  socket.on('omegle_partner_left', () => {
    omegleClosePC();
    appendSystemNotice('Stranger has disconnected. Click "New" to find someone else.');
    toast('Stranger has disconnected');
  });

  // ---------- Omegle camera toggle (video, WebRTC perfect negotiation) ----------
  let omeglePC = null;
  let omegleLocalStream = null;
  let omegleCameraOn = false;
  let omegleMakingOffer = false;
  let omeglePolite = false;
  let omegleIgnoreOffer = false;

  function omegleUpdateCameraButton(on) {
    const btn = $('#btn-omegle-camera');
    btn.classList.toggle('active', on);
    btn.title = on ? 'Turn camera off' : 'Turn camera on';
  }

  function omegleShowVideoRowIfNeeded() {
    const remoteVisible = !$('#omegle-remote-tile').classList.contains('hidden');
    $('#omegle-video-row').classList.toggle('hidden', !(omegleCameraOn || remoteVisible));
  }

  function omegleSetPeerCameraOn(on) {
    $('#omegle-remote-tile').classList.toggle('hidden', !on);
    if (!on) $('#omegle-remote-video').srcObject = null;
    omegleShowVideoRowIfNeeded();
  }

  function omegleGetOrCreatePC() {
    if (omeglePC) return omeglePC;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('webrtc_signal', { type: 'candidate', candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      const el = $('#omegle-remote-video');
      el.srcObject = e.streams[0];
      el.play().catch(() => {});
      omegleSetPeerCameraOn(true);
    };
    pc.onnegotiationneeded = async () => {
      try {
        omegleMakingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_signal', { type: 'offer', sdp: pc.localDescription });
      } catch (err) {
        console.error('omegle negotiation error', err);
      } finally {
        omegleMakingOffer = false;
      }
    };
    omeglePC = pc;
    return pc;
  }

  function omegleClosePC() {
    if (omeglePC) {
      omeglePC.close();
      omeglePC = null;
    }
    omegleMakingOffer = false;
    omegleIgnoreOffer = false;
    $('#omegle-remote-video').srcObject = null;
    omegleSetPeerCameraOn(false);
  }

  function omegleStopCamera() {
    if (omeglePC) {
      omeglePC.getSenders()
        .filter((s) => s.track && s.track.kind === 'video')
        .forEach((s) => omeglePC.removeTrack(s));
    }
    if (omegleLocalStream) {
      omegleLocalStream.getTracks().forEach((t) => t.stop());
      omegleLocalStream = null;
    }
    omegleCameraOn = false;
    $('#omegle-self-video').srcObject = null;
    $('#omegle-self-tile').classList.add('hidden');
    omegleUpdateCameraButton(false);
    omegleShowVideoRowIfNeeded();
  }

  function omegleFullTeardown() {
    omegleClosePC();
    omegleStopCamera();
  }

  async function omegleStartCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      omegleLocalStream = stream;
      omegleCameraOn = true;
      const selfVideo = $('#omegle-self-video');
      selfVideo.srcObject = stream;
      selfVideo.play().catch(() => {});
      $('#omegle-self-tile').classList.remove('hidden');
      omegleShowVideoRowIfNeeded();
      omegleUpdateCameraButton(true);
      if (room && room.omegle && members.length === 2) {
        const pc = omegleGetOrCreatePC();
        stream.getVideoTracks().forEach((t) => pc.addTrack(t, stream));
      }
      socket.emit('webrtc_signal', { type: 'camera_state', on: true });
    } catch (err) {
      console.error('omegle camera error', err);
      toast(omegleCameraErrorMessage(err));
    }
  }

  function omegleCameraErrorMessage(err) {
    if (!window.isSecureContext) return 'Video needs a secure (https) connection — this page is not secure';
    if (err && err.name === 'NotAllowedError') return "Camera permission was denied — allow it in your browser's site settings";
    if (err && err.name === 'NotFoundError') return 'No camera was found on this device';
    return 'Could not access your camera';
  }

  $('#btn-omegle-camera').addEventListener('click', () => {
    if (!room || !room.omegle) return;
    if (omegleCameraOn) {
      omegleStopCamera();
      socket.emit('webrtc_signal', { type: 'camera_state', on: false });
    } else {
      omegleStartCamera();
    }
  });

  socket.on('webrtc_signal', async ({ data }) => {
    if (!room || !room.omegle) return;
    if (data.type === 'camera_state') {
      omegleSetPeerCameraOn(!!data.on);
      return;
    }
    const pc = omegleGetOrCreatePC();
    try {
      if (data.type === 'offer') {
        const offerCollision = omegleMakingOffer || pc.signalingState !== 'stable';
        omegleIgnoreOffer = !omeglePolite && offerCollision;
        if (omegleIgnoreOffer) return;
        if (offerCollision) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(new RTCSessionDescription(data.sdp)),
          ]);
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc_signal', { type: 'answer', sdp: pc.localDescription });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'candidate' && data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          if (!omegleIgnoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('omegle signaling error', err);
    }
  });

  function appendSystemNotice(text) {
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

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

  function identityFor(m) {
    if (room && room.omegle && m.clientId !== 'system') {
      return m.clientId === clientId
        ? { name: 'You', color: room.accent, initials: 'Y' }
        : { name: 'Stranger', color: '#8a8d99', initials: 'S' };
    }
    return { name: m.authorName, color: m.authorColor, initials: initials(m.authorName) };
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
    const identity = identityFor(m);
    const isOmegle = !!(room && room.omegle);

    const group = document.createElement('div');
    group.className = 'msg-group' + (isCompactGroup ? ' compact' : '');
    group.dataset.id = m.id;

    const avatarHtml = isCompactGroup
      ? `<div class="msg-avatar spacer"></div>`
      : `<div class="msg-avatar" style="background:${identity.color}">${identity.initials}</div>`;

    const canEdit = !isOmegle && m.clientId === clientId && !m.deleted && m.type !== 'system';
    const canDelete = !isOmegle && (m.clientId === clientId || (room && room.isOwner)) && !m.deleted;
    const canPin = !isOmegle && room && room.isOwner && !m.deleted;

    const actionPrefix = m.type === 'action' ? `${escapeHtml(identity.name)} ` : '';
    const bodyHtml = m.deleted
      ? `<span class="msg-bubble deleted">message deleted</span>`
      : `<span class="msg-bubble ${m.type === 'action' ? 'action' : ''}">${actionPrefix}${m.html}</span>${
          m.editedAt ? '<span class="msg-edited-tag">(edited)</span>' : ''
        }`;

    const actionsHtml = isOmegle
      ? ''
      : `
          <div class="msg-actions">
            <button data-act="react" title="React">🙂</button>
            ${canEdit ? '<button data-act="edit" title="Edit">✎</button>' : ''}
            ${canDelete ? '<button data-act="delete" title="Delete">🗑</button>' : ''}
            ${canPin ? `<button data-act="pin" title="${room.pinnedMessageId === m.id ? 'Unpin' : 'Pin'}">📌</button>` : ''}
          </div>
          <div class="emoji-picker">${QUICK_EMOJI.map((e) => `<button data-emoji="${e}">${e}</button>`).join('')}</div>
        `;

    group.innerHTML = `
      ${avatarHtml}
      <div class="msg-content">
        ${isCompactGroup ? '' : `<div class="msg-meta"><span class="msg-author" style="color:${identity.color}">${escapeHtml(identity.name)}</span><span class="msg-time">${formatTime(m.createdAt)}</span></div>`}
        <div class="msg-line" data-id="${m.id}">
          ${bodyHtml}
          ${actionsHtml}
        </div>
        ${isOmegle ? '' : reactionsHtml(m)}
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
    $('#chat-online-count').textContent = room && room.maxMembers
      ? `${members.length}/${room.maxMembers} online`
      : `${members.length} online`;
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

  // ---------- Live mode (Talkomatic-style: no posting, just live typing) ----------
  let selfLiveDraft = '';

  function renderLiveGrid() {
    const grid = $('#live-grid');
    if (!room || !room.liveMode) {
      grid.innerHTML = '';
      return;
    }
    const currentIds = new Set(members.map((m) => m.clientId));
    grid.querySelectorAll('.live-box').forEach((el) => {
      if (!currentIds.has(el.dataset.clientId)) el.remove();
    });

    members.forEach((m) => {
      const isSelf = m.clientId === clientId;
      let box = grid.querySelector(`.live-box[data-client-id="${CSS.escape(m.clientId)}"]`);
      if (!box) {
        box = document.createElement('div');
        box.className = 'live-box' + (isSelf ? ' live-box-self' : '');
        box.dataset.clientId = m.clientId;
        box.innerHTML = `
          <div class="live-box-head">
            <span class="member-avatar" style="background:${m.avatarColor}">${initials(m.displayName)}</span>
            <span class="live-box-name"></span>
          </div>
          ${isSelf
            ? `<textarea class="live-box-input" maxlength="2000" placeholder="Start typing…"></textarea>`
            : `<div class="live-box-text"></div>`}
        `;
        grid.appendChild(box);
        if (isSelf) {
          const textarea = box.querySelector('.live-box-input');
          textarea.value = selfLiveDraft;
          textarea.addEventListener('input', () => {
            selfLiveDraft = textarea.value;
            socket.emit('live_typing', { text: selfLiveDraft });
          });
        }
      }
      box.querySelector('.live-box-name').textContent = m.displayName + (isSelf ? ' (you)' : '');
      if (!isSelf) {
        const textEl = box.querySelector('.live-box-text');
        const text = liveDrafts[m.clientId] || '';
        textEl.innerHTML = `${escapeHtml(text)}<span class="live-cursor"></span>`;
      }
    });
  }

  socket.on('live_typing_update', ({ clientId: cid, text }) => {
    if (text) liveDrafts[cid] = text;
    else delete liveDrafts[cid];
    renderLiveGrid();
  });

  socket.on('live_typing_cleared', () => {
    liveDrafts = {};
    renderLiveGrid();
  });

  // ---------- Shared WebRTC config (walkie-talkie voice + omegle video) ----------
  // STUN alone only works when neither side is behind a restrictive/symmetric NAT.
  // Open Relay's public TURN servers are included as a fallback so calls still
  // connect for the (very common) case where a direct P2P path can't be found.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  // ---------- Walkie-talkie mode (push-to-talk voice, 2 people max) ----------
  let walkiePC = null;
  let walkieLocalStream = null;
  let walkieOfferSent = false;
  let walkieTalking = false;

  function walkieSetStatus(text, cls) {
    const el = $('#walkie-status');
    el.textContent = text;
    el.className = 'walkie-status' + (cls ? ' ' + cls : '');
  }

  function walkieSetButtonState(state) {
    const btn = $('#walkie-ptt-btn');
    btn.classList.remove('talking', 'disabled', 'peer-talking');
    if (state !== 'idle') btn.classList.add(state);
    btn.disabled = state === 'disabled' || state === 'peer-talking';
  }

  function walkieOtherName() {
    const other = members.find((m) => m.clientId !== clientId);
    return other ? other.displayName : 'the other person';
  }

  function walkieMicErrorMessage(err) {
    if (!window.isSecureContext) return 'Voice needs a secure (https) connection — this page is not secure';
    if (err && err.name === 'NotAllowedError') return 'Microphone permission was denied — allow it in your browser\'s site settings and rejoin';
    if (err && err.name === 'NotFoundError') return 'No microphone was found on this device';
    return 'Could not access your microphone for walkie-talkie';
  }

  async function walkieEnsureLocalStream() {
    if (walkieLocalStream) return walkieLocalStream;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getAudioTracks().forEach((t) => (t.enabled = false));
    walkieLocalStream = stream;
    return stream;
  }

  function walkieGetOrCreatePC() {
    if (walkiePC) return walkiePC;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    if (walkieLocalStream) {
      walkieLocalStream.getTracks().forEach((t) => pc.addTrack(t, walkieLocalStream));
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('webrtc_signal', { type: 'candidate', candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      const audioEl = $('#walkie-remote-audio');
      audioEl.srcObject = e.streams[0];
      audioEl.play().catch(() => {});
    };
    const handleConnectionState = () => {
      const state = pc.connectionState || pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        walkieSetStatus(`Connected with ${walkieOtherName()} — hold the button to talk`);
        walkieSetButtonState(walkieTalking ? 'talking' : 'idle');
      } else if (state === 'failed' || state === 'disconnected') {
        walkieSetStatus('Connection lost — this can happen on strict networks. Try again.');
        walkieSetButtonState('disabled');
      } else if (state === 'connecting' || state === 'checking') {
        walkieSetStatus(`Connecting to ${walkieOtherName()}…`);
        walkieSetButtonState('disabled');
      }
    };
    pc.onconnectionstatechange = handleConnectionState;
    pc.oniceconnectionstatechange = handleConnectionState;
    walkiePC = pc;
    return pc;
  }

  function walkieTeardown() {
    if (walkiePC) {
      walkiePC.close();
      walkiePC = null;
    }
    if (walkieLocalStream) {
      walkieLocalStream.getTracks().forEach((t) => t.stop());
      walkieLocalStream = null;
    }
    walkieOfferSent = false;
    walkieTalking = false;
    const audioEl = $('#walkie-remote-audio');
    audioEl.srcObject = null;
  }

  async function walkieMaybeNegotiate() {
    if (!room || !room.walkieMode) return;
    if (members.length !== 2) {
      walkieTeardown();
      walkieSetStatus('Waiting for someone to join…');
      walkieSetButtonState('disabled');
      return;
    }
    const other = members.find((m) => m.clientId !== clientId);
    if (!other) return;

    try {
      await walkieEnsureLocalStream();
    } catch (err) {
      console.error('walkie-talkie mic error', err);
      walkieSetStatus(walkieMicErrorMessage(err));
      walkieSetButtonState('disabled');
      return;
    }

    const pc = walkieGetOrCreatePC();
    const state = pc.connectionState || pc.iceConnectionState;
    if (state !== 'connected' && state !== 'completed') {
      walkieSetStatus(`Connecting to ${other.displayName}…`);
      walkieSetButtonState('disabled');
    }

    const iAmOfferer = clientId < other.clientId;
    if (iAmOfferer && !walkieOfferSent && pc.signalingState === 'stable') {
      walkieOfferSent = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc_signal', { type: 'offer', sdp: offer });
    }
  }

  socket.on('webrtc_signal', async ({ data }) => {
    if (!room || !room.walkieMode) return;
    try {
      await walkieEnsureLocalStream();
    } catch { /* mic unavailable; still try to receive remote audio */ }
    const pc = walkieGetOrCreatePC();
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc_signal', { type: 'answer', sdp: answer });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'candidate' && data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error('walkie-talkie signaling error', err);
    }
  });

  function walkieStartTalking() {
    if (!walkieLocalStream || !room || !room.walkieMode || walkieTalking) return;
    socket.emit('ptt_start', {}, (res) => {
      if (res && res.error) return toast(res.error);
      walkieTalking = true;
      walkieLocalStream.getAudioTracks().forEach((t) => (t.enabled = true));
      walkieSetButtonState('talking');
      walkieSetStatus('You are transmitting…', 'on-air');
    });
  }

  function walkieStopTalking() {
    if (!walkieTalking) return;
    walkieTalking = false;
    if (walkieLocalStream) walkieLocalStream.getAudioTracks().forEach((t) => (t.enabled = false));
    socket.emit('ptt_stop');
    walkieSetButtonState('idle');
    walkieSetStatus(`Connected with ${walkieOtherName()} — hold the button to talk`);
  }

  const walkiePttBtn = $('#walkie-ptt-btn');
  walkiePttBtn.addEventListener('mousedown', walkieStartTalking);
  walkiePttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); walkieStartTalking(); });
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach((evt) => {
    walkiePttBtn.addEventListener(evt, walkieStopTalking);
  });

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    if (!room || !room.walkieMode) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    walkieStartTalking();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    if (!room || !room.walkieMode) return;
    walkieStopTalking();
  });

  socket.on('ptt_update', ({ clientId: cid, talking }) => {
    if (cid === clientId) return;
    if (talking) {
      walkieSetButtonState('peer-talking');
      walkieSetStatus(`${walkieOtherName()} is talking…`, 'peer-talking');
    } else {
      walkieSetButtonState(walkieTalking ? 'talking' : 'idle');
      walkieSetStatus(
        walkieTalking ? 'You are transmitting…' : `Connected with ${walkieOtherName()} — hold the button to talk`,
        walkieTalking ? 'on-air' : ''
      );
    }
  });

  // ---------- Typing indicator ----------
  socket.on('typing_update', (names) => {
    const row = $('#typing-row');
    if (!names.length) return (row.textContent = '');
    if (room && room.omegle) return (row.textContent = 'Stranger is typing…');
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
    const activeIds = new Set(members.map((m) => m.clientId));
    Object.keys(liveDrafts).forEach((id) => { if (!activeIds.has(id)) delete liveDrafts[id]; });
    renderMembers();
    if (room && room.liveMode) renderLiveGrid();
    if (room && room.walkieMode) walkieMaybeNegotiate();
  });

  socket.on('room_updated', (r) => {
    room = Object.assign(room || {}, r);
    document.documentElement.style.setProperty('--accent', room.accent);
    $('#chat-room-name').textContent = room.omegle ? 'Stranger Chat' : room.name;
    renderMembers();
    renderPinned();
    applyLiveModeVisibility();
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
    [
      '#room-settings-name',
      '#room-settings-slowmode',
      '#room-settings-max-members',
      '#room-settings-closed',
      '#room-settings-live-mode',
      '#room-settings-walkie-mode',
      '#btn-save-room',
    ].forEach((sel) => {
      $(sel).disabled = !isOwner;
    });
    if (room) {
      $('#room-settings-name').value = room.name;
      $('#room-settings-slowmode').value = room.slowMode || 0;
      $('#room-settings-max-members').value = room.maxMembers || 0;
      $('#room-settings-max-members').disabled = !isOwner || !!room.walkieMode;
      $('#room-settings-closed').checked = !!room.closed;
      $('#room-settings-live-mode').checked = !!room.liveMode;
      $('#room-settings-walkie-mode').checked = !!room.walkieMode;
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

  $('#room-settings-live-mode').addEventListener('change', () => {
    if ($('#room-settings-live-mode').checked) $('#room-settings-walkie-mode').checked = false;
  });
  $('#room-settings-walkie-mode').addEventListener('change', () => {
    const isWalkie = $('#room-settings-walkie-mode').checked;
    if (isWalkie) $('#room-settings-live-mode').checked = false;
    $('#room-settings-max-members').disabled = isWalkie;
    if (isWalkie) $('#room-settings-max-members').value = 2;
  });

  $('#btn-save-room').addEventListener('click', () => {
    socket.emit(
      'update_room_settings',
      {
        name: $('#room-settings-name').value,
        slowMode: Number($('#room-settings-slowmode').value) || 0,
        maxMembers: Number($('#room-settings-max-members').value) || 0,
        closed: $('#room-settings-closed').checked,
        liveMode: $('#room-settings-live-mode').checked,
        walkieMode: $('#room-settings-walkie-mode').checked,
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
