const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const path = require('path')
const compression = require('compression')
const engine = require('./game-engine')

const app = express()
const server = http.createServer(app)

app.use(compression())
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})
app.use(express.static(path.join(__dirname, 'public')))

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000,
  upgradeTimeout: 3000,
  allowUpgrades: true,
  httpCompression: true,
  connectTimeout: 10000,
  perMessageDeflate: {
    threshold: 512
  }
})

const rooms = new Map()
const socketToRoom = new Map()
const botTimers = new Map()
const DISCONNECT_GRACE = 5000

function getRoomState(room) {
  return {
    id: room.id,
    type: room.type,
    phase: room.phase,
    mode: room.mode,
    settings: room.settings,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isBot: p.isBot,
      disconnected: p.disconnected || false,
      cardsCount: p.hand ? p.hand.length : 0,
      calledUno: p.calledUno
    })),
    pendingPlayers: room.pendingPlayers.map(p => ({ id: p.id, name: p.name })),
    currentPlayerIndex: room.currentPlayerIndex,
    direction: room.direction,
    winner: room.winner,
    discardTop: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null,
    currentColor: room.currentColor,
    currentValue: room.currentValue,
    pendingDraw: room.pendingDraw,
    remainingDeck: room.deck.length
  }
}

function getPublicRoomList() {
  const list = []
  for (const room of rooms.values()) {
    if (room.type === 'public' && room.phase === 'waiting' && room.players.length < 10) {
      list.push({
        id: room.id,
        mode: room.mode,
        playerCount: room.players.length,
        hostName: room.players.find(p => p.isHost)?.name || '—'
      })
    }
  }
  return list
}

function clearBotTimer(room) {
  if (!room) return
  const key = room.id
  const timers = botTimers.get(key)
  if (timers) {
    timers.forEach(t => clearTimeout(t))
    botTimers.delete(key)
  }
}

function scheduleBotMove(room) {
  clearBotTimer(room)
  if (!room || room.phase !== 'playing') return

  const player = room.players[room.currentPlayerIndex]
  if (!player || !player.isBot || player.disconnected) return

  const delay = 600 + Math.random() * 600
  const timer = setTimeout(() => {
    if (!room || room.phase !== 'playing') return
    const botPlayer = room.players[room.currentPlayerIndex]
    if (!botPlayer || !botPlayer.isBot || botPlayer.disconnected) return

    const botResult = engine.getBotMove(room, room.currentPlayerIndex)
    if (!botResult) return

    if (botResult.action === 'play_card') {
      const result = engine.playCard(room, room.currentPlayerIndex, botResult.cardIndex, botResult.chosenColor)
      if (!result.error) {
        broadcastRoomState(room)
        if (result.winner) {
          io.to(room.id).emit('game_over', { winner: result.winner })
          clearBotTimer(room)
        } else {
          scheduleBotMove(room)
        }
      } else {
        scheduleBotMove(room)
      }
    } else if (botResult.action === 'draw') {
      const result = engine.drawAction(room, room.currentPlayerIndex)
      if (!result.error) {
        broadcastRoomState(room)
        scheduleBotMove(room)
      } else {
        scheduleBotMove(room)
      }
    }
  }, delay)

  const key = room.id
  if (!botTimers.has(key)) botTimers.set(key, [])
  botTimers.get(key).push(timer)
}

function broadcastRoomState(room) {
  io.to(room.id).emit('room_update', getRoomState(room))
  room.players.forEach(p => {
    if (!p.isBot && !p.disconnected) {
      io.to(p.id).emit('hand_update', { hand: p.hand })
    }
  })
}

function assignNewHost(room) {
  const newHost = room.players.find(p => !p.isBot && !p.disconnected)
  if (newHost) {
    newHost.isHost = true
    return newHost
  }
  const anyPlayer = room.players.find(p => !p.isBot)
  if (anyPlayer) {
    anyPlayer.isHost = true
    return anyPlayer
  }
  return null
}

function kickPlayer(room, playerId) {
  const player = room.players.find(p => p.id === playerId)
  if (!player) return

  const playerName = player.name
  const wasHost = player.isHost
  const wasPlaying = room.phase === 'playing'

  socketToRoom.delete(playerId)
  const removed = engine.removePlayer(room, playerId)
  if (!removed) return

  if (room.players.length === 0) {
    clearBotTimer(room)
    rooms.delete(room.id)
    return
  }

  broadcastRoomState(room)

  if (wasPlaying) {
    const newHost = wasHost ? assignNewHost(room) : null
    io.to(room.id).emit('player_left', {
      name: playerName,
      newHost: newHost ? newHost.name : null,
      playerCount: room.players.length,
      wasKicked: true
    })
    if (room.phase === 'ended') {
      if (room.winner) io.to(room.id).emit('game_over', { winner: room.winner, reason: 'disconnect' })
    } else if (newHost) {
      broadcastRoomState(room)
    }
  } else {
    if (wasHost) {
      const newHost = assignNewHost(room)
      if (newHost) {
        broadcastRoomState(room)
        io.to(room.id).emit('host_changed', { newHost: newHost.name })
      }
    }
  }
}

function markDisconnected(socket) {
  const roomId = socketToRoom.get(socket.id)
  if (!roomId) return
  const room = rooms.get(roomId)
  if (!room) return

  const player = room.players.find(p => p.id === socket.id)
  if (!player) return

  if (player._disconnectTimer) {
    clearTimeout(player._disconnectTimer)
  }

  player.disconnected = true
  socketToRoom.delete(socket.id)

  io.to(roomId).emit('room_update', getRoomState(room))
  io.to(roomId).emit('player_disconnected', {
    name: player.name,
    graceMs: DISCONNECT_GRACE
  })

  player._disconnectTimer = setTimeout(() => {
    kickPlayer(room, player.id)
    player._disconnectTimer = null
  }, DISCONNECT_GRACE)
}

function tryRejoin(socket, roomId, name) {
  return new Promise((resolve) => {
    const room = rooms.get(roomId)
    if (!room) return resolve(null)

    let player = room.players.find(p => p.id === socket.id)
    if (!player) {
      player = room.players.find(p => p.name === name && p.disconnected)
    }
    if (!player) return resolve(null)

    const oldId = player.id
    player.id = socket.id
    socketToRoom.delete(oldId)
    socketToRoom.set(socket.id, room.id)

    if (player._disconnectTimer) {
      clearTimeout(player._disconnectTimer)
      player._disconnectTimer = null
    }
    player.disconnected = false
    player.name = name
    socket.join(roomId)

    const hands = {}
    room.players.forEach(p => { hands[p.id] = p.hand })

    io.to(roomId).emit('player_reconnected', { name: player.name })
    broadcastRoomState(room)

    scheduleBotMove(room)
    resolve(getRoomState(room))
  })
}

io.on('connection', (socket) => {
  socket.on('list_public_rooms', (_, callback) => {
    callback({ rooms: getPublicRoomList() })
  })

  socket.on('create_room', ({ name, mode, type }, callback) => {
    if (!name || name.trim().length === 0) return callback({ error: 'Введи имя' })
    const roomType = type || 'private'
    const solo = type === 'solo'

    const room = engine.createRoom(mode || 'classic', solo ? 'private' : roomType)
    engine.addPlayer(room, socket.id, name.trim())

    if (solo) {
      engine.addPlayer(room, 'bot_' + room.id, 'Бот', true)
    }

    rooms.set(room.id, room)
    socketToRoom.set(socket.id, room.id)
    socket.join(room.id)

    if (solo && room.players.length >= 2) {
      const r = engine.startGame(room)
      if (!r.error) {
        scheduleBotMove(room)
        const hands = {}
        room.players.forEach(p => { hands[p.id] = p.hand })
        callback({ roomId: room.id, state: getRoomState(room), hands, solo: true })
        io.to(room.id).emit('game_start', { state: getRoomState(room), hands })
        return
      }
    }

    callback({ roomId: room.id, state: getRoomState(room) })
  })

  socket.on('join_room', ({ roomId, name }, callback) => {
    if (!name || name.trim().length === 0) return callback({ error: 'Введи имя' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    if (room.phase !== 'waiting') return callback({ error: 'Игра уже началась' })
    if (room.players.length >= 10) return callback({ error: 'Комната полна' })

    if (room.type === 'private') {
      if (room.pendingPlayers.find(p => p.id === socket.id)) {
        return callback({ error: 'Запрос уже отправлен' })
      }
      room.pendingPlayers.push({ id: socket.id, name: name.trim() })
      socketToRoom.set(socket.id, room.id)
      const host = room.players.find(p => p.isHost)
      if (host) io.to(host.id).emit('join_request', { playerId: socket.id, name: name.trim() })
      callback({ pending: true })
      return
    }

    engine.addPlayer(room, socket.id, name.trim())
    socketToRoom.set(socket.id, room.id)
    socket.join(room.id)
    callback({ state: getRoomState(room) })
    socket.to(room.id).emit('room_update', getRoomState(room))
  })

  socket.on('approve_join', ({ playerId }, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const player = room.players.find(p => p.id === socket.id)
    if (!player || !player.isHost) return callback({ error: 'Только хост' })

    const idx = room.pendingPlayers.findIndex(p => p.id === playerId)
    if (idx === -1) return callback({ error: 'Запрос не найден' })
    const pending = room.pendingPlayers.splice(idx, 1)[0]

    const joinSocket = io.sockets.sockets.get(playerId)
    if (joinSocket) {
      engine.addPlayer(room, playerId, pending.name)
      joinSocket.join(roomId)
      socketToRoom.set(playerId, roomId)
      io.to(playerId).emit('join_approved', { state: getRoomState(room) })
      broadcastRoomState(room)
    }
    callback({ success: true })
  })

  socket.on('reject_join', ({ playerId }, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const player = room.players.find(p => p.id === socket.id)
    if (!player || !player.isHost) return callback({ error: 'Только хост' })

    const idx = room.pendingPlayers.findIndex(p => p.id === playerId)
    if (idx === -1) return callback({ error: 'Запрос не найден' })
    const pending = room.pendingPlayers.splice(idx, 1)[0]

    socketToRoom.delete(playerId)
    const joinSocket = io.sockets.sockets.get(playerId)
    if (joinSocket) io.to(playerId).emit('join_rejected', { reason: 'Хост отклонил запрос' })
    callback({ success: true })
  })

  socket.on('rejoin', ({ roomId, name }, callback) => {
    tryRejoin(socket, roomId, name).then(state => {
      if (state) {
        const hands = {}
        const room = rooms.get(roomId)
        if (room) room.players.forEach(p => { hands[p.id] = p.hand })
        callback({ state, hands })
      } else {
        callback({ error: 'Не в этой комнате' })
      }
    })
  })

  socket.on('update_settings', ({ mode, settings }, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const player = room.players.find(p => p.id === socket.id)
    if (!player || !player.isHost) return callback({ error: 'Только хост' })

    engine.updateSettings(room, mode, settings)
    io.to(roomId).emit('settings_updated', { mode: room.mode, settings: room.settings })
    broadcastRoomState(room)
    callback({ success: true, mode: room.mode, settings: room.settings })
  })

  socket.on('start_game', (_, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const player = room.players.find(p => p.id === socket.id)
    if (!player || !player.isHost) return callback({ error: 'Только хост' })
    if (room.players.length < 2) return callback({ error: 'Нужно минимум 2 игрока' })

    const result = engine.startGame(room)
    if (result.error) return callback({ error: result.error })

    const hands = {}
    room.players.forEach(p => { hands[p.id] = p.hand })
    io.to(roomId).emit('game_start', { state: getRoomState(room), hands })
    callback({ success: true })
    scheduleBotMove(room)
  })

  socket.on('play_card', ({ cardIndex, chosenColor }, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const pi = room.players.findIndex(p => p.id === socket.id)
    if (pi === -1) return callback({ error: 'Не в игре' })

    const result = engine.playCard(room, pi, cardIndex, chosenColor)
    if (result.error) return callback({ error: result.error })

    broadcastRoomState(room)
    if (result.winner) {
      io.to(roomId).emit('game_over', { winner: result.winner })
      clearBotTimer(room)
    } else {
      scheduleBotMove(room)
    }
    callback({ success: true })
  })

  socket.on('draw_card', (_, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const pi = room.players.findIndex(p => p.id === socket.id)
    if (pi === -1) return callback({ error: 'Не в игре' })

    const result = engine.drawAction(room, pi)
    if (result.error) return callback({ error: result.error })

    broadcastRoomState(room)
    scheduleBotMove(room)
    callback({ success: true })
  })

  socket.on('call_uno', (_, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const pi = room.players.findIndex(p => p.id === socket.id)
    if (pi === -1) return callback({ error: 'Не в игре' })

    const result = engine.callUno(room, pi)
    if (result.error) return callback({ error: result.error })
    io.to(roomId).emit('uno_called', { player: room.players[pi].name })
    callback({ success: true })
  })

  socket.on('leave', () => markDisconnected(socket))
  socket.on('disconnect', () => markDisconnected(socket))
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`UNO server running on port ${PORT}`)
})
