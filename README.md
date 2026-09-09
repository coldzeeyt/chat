# Chatroom

A modern, self-hosted chatroom app. No accounts — create a room, get a code and an invite link, share it, and chat in real time.

## Features

- **Rooms with codes & invite links** — create a room, get a short code (e.g. `K7M2QX`) and a shareable `/r/CODE` link
- **Optional room passwords** and an owner-only "close room to new members" toggle
- Real-time messaging (Socket.IO) with presence, typing indicators, and join/leave notices
- Lightweight markdown: `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, and auto-linked URLs
- Emoji reactions, message editing & deleting, and owner-pinned messages
- Slash commands: `/me <action>`, `/nick <name>`, `/shrug`
- Per-user settings: display name, avatar color, light/dark/system theme, compact mode, notification sound
- Per-room settings (owner only): name, accent color, slow mode, closed/open
- Message history persisted to disk (survives restarts/redeploys when a volume is mounted)

## Stack

Plain Node.js — Express + Socket.IO on the backend, no-build vanilla HTML/CSS/JS on the frontend. Data is stored in a small JSON file (`DATA_DIR/db.json`), so there are no native dependencies or database to provision.

## Running locally

```bash
npm install
npm start
```

Then open http://localhost:3000.

Environment variables:

- `PORT` — port to listen on (default `3000`)
- `DATA_DIR` — where to persist `db.json` (default `./data`)
