const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const path = require('path')
const engine = require('./game-engine')

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})
app.use(express.static(path.join(__dirname, 'public')))

const rooms = new Map()
const socketToRoom = new Map()
const botTimers = new Map()
const disconnectTimers = new Map()
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
      cardsCount: p.hand.length,
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

function scheduleBotMove(room) {
  if (!room || room.phase !== 'playing') return
  const player = room.players[room.currentPlayerIndex]
  if (!player || !player.isBot || player.disconnected) return

  const delay = 800 + Math.random() * 700
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

function clearBotTimer(room) {
  if (!room) return
  const key = room.id
  const timers = botTimers.get(key)
  if (timers) {
    timers.forEach(t => clearTimeout(t))
    botTimers.delete(key)
  }
}

function broadcastRoomState(room) {
  io.to(room.id).emit('room_update', getRoomState(room))
  room.players.forEach(p => {
    if (!p.isBot && !p.disconnected) io.to(p.id).emit('hand_update', { hand: p.hand })
  })
}

function kickPlayer(room, socketId) {
  const player = room.players.find(p => p.id === socketId)
  if (!player) return

  const playerName = player.name
  const wasHost = player.isHost
  const wasPlaying = room.phase === 'playing'

  socketToRoom.delete(socketId)
  const removed = engine.removePlayer(room, socketId)
  if (!removed) return

  const isBotRoom = room.players.some(p => p.isBot)
  if (isBotRoom || room.players.length === 0) {
    clearBotTimer(room)
    rooms.delete(room.id)
    return
  }

  broadcastRoomState(room)

  if (wasPlaying) {
    const newHost = wasHost && room.players.length > 0 ? room.players[0] : null
    io.to(room.id).emit('player_left', {
      name: playerName,
      newHost: newHost ? newHost.name : null,
      playerCount: room.players.length,
      wasKicked: true
    })
    if (newHost) broadcastRoomState(room)
    if (room.phase === 'ended') {
      if (room.winner) io.to(room.id).emit('game_over', { winner: room.winner, reason: 'disconnect' })
    }
  }
}

function cancelDisconnectTimer(player) {
  if (player._disconnectTimer) {
    clearTimeout(player._disconnectTimer)
    player._disconnectTimer = null
  }
}

function markDisconnected(socket) {
  const roomId = socketToRoom.get(socket.id)
  if (!roomId) return
  const room = rooms.get(roomId)
  if (!room) return

  const player = room.players.find(p => p.id === socket.id)
  if (!player) return

  const isBotRoom = room.players.some(p => p.isBot)
  if (isBotRoom) {
    room.players = room.players.filter(p => !p.isBot)
    if (room.players.length === 0) { rooms.delete(roomId); return }
  }

  cancelDisconnectTimer(player)
  player.disconnected = true
  socketToRoom.delete(socket.id)

  io.to(roomId).emit('room_update', getRoomState(room))
  io.to(roomId).emit('player_disconnected', {
    name: player.name,
    graceMs: DISCONNECT_GRACE
  })

  player._disconnectTimer = setTimeout(() => {
    kickPlayer(room, player.id)
    cancelDisconnectTimer(player)
  }, DISCONNECT_GRACE)
}

function handleRejoin(socket, roomId, name, callback) {
  const room = rooms.get(roomId)
  if (!room) return callback({ error: 'Комната не найдена' })

  let player = room.players.find(p => p.id === socket.id)
  if (!player) {
    player = room.players.find(p => p.name === name.trim() && p.disconnected)
  }
  if (!player) return callback({ error: 'Не в этой комнате' })

  const oldId = player.id
  player.id = socket.id
  cancelDisconnectTimer(player)
  player.disconnected = false

  if (oldId !== socket.id) {
    socketToRoom.delete(oldId)
  }
  socketToRoom.set(socket.id, room.id)
  player.name = name.trim() || player.name
  socket.join(roomId)

  const hands = {}
  room.players.forEach(p => { hands[p.id] = p.hand })
  callback({ state: getRoomState(room), hands })
  io.to(roomId).emit('player_reconnected', { name: player.name })
  io.to(roomId).emit('room_update', getRoomState(room))
  room.players.forEach(p => {
    if (!p.isBot && !p.disconnected) io.to(p.id).emit('hand_update', { hand: p.hand })
  })

  scheduleBotMove(room)
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
      const existing = room.pendingPlayers.find(p => p.id === socket.id)
      if (existing) return callback({ error: 'Запрос уже отправлен' })

      room.pendingPlayers.push({ id: socket.id, name: name.trim() })
      socketToRoom.set(socket.id, room.id)

      const host = room.players.find(p => p.isHost)
      if (host) {
        io.to(host.id).emit('join_request', { playerId: socket.id, name: name.trim() })
      }

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

    const pendingIdx = room.pendingPlayers.findIndex(p => p.id === playerId)
    if (pendingIdx === -1) return callback({ error: 'Запрос не найден' })
    const pending = room.pendingPlayers.splice(pendingIdx, 1)[0]

    const joinSocket = io.sockets.sockets.get(playerId)
    if (joinSocket) {
      engine.addPlayer(room, playerId, pending.name)
      joinSocket.join(roomId)
      socketToRoom.set(playerId, roomId)
      io.to(playerId).emit('join_approved', { state: getRoomState(room) })
      io.to(roomId).emit('room_update', getRoomState(room))
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

    const pendingIdx = room.pendingPlayers.findIndex(p => p.id === playerId)
    if (pendingIdx === -1) return callback({ error: 'Запрос не найден' })
    const pending = room.pendingPlayers.splice(pendingIdx, 1)[0]

    const joinSocket = io.sockets.sockets.get(playerId)
    if (joinSocket) {
      socketToRoom.delete(playerId)
      io.to(playerId).emit('join_rejected', { reason: 'Хост отклонил запрос' })
    }

    callback({ success: true })
  })

  socket.on('rejoin', ({ roomId, name }, callback) => {
    handleRejoin(socket, roomId, name, callback)
  })

  socket.on('update_settings', ({ mode, settings }, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const player = room.players.find(p => p.id === socket.id)
    if (!player || !player.isHost) return callback({ error: 'Только хост может менять настройки' })

    const newSettings = engine.updateSettings(room, mode, settings)
    io.to(roomId).emit('settings_updated', { mode: room.mode, settings: newSettings })
    io.to(roomId).emit('room_update', getRoomState(room))
    callback({ success: true, mode: room.mode, settings: newSettings })
  })

  socket.on('start_game', (_, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const player = room.players.find(p => p.id === socket.id)
    if (!player || !player.isHost) return callback({ error: 'Только хост может начать' })
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
    const playerIndex = room.players.findIndex(p => p.id === socket.id)
    if (playerIndex === -1) return callback({ error: 'Не в игре' })

    const result = engine.playCard(room, playerIndex, cardIndex, chosenColor)
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
    const playerIndex = room.players.findIndex(p => p.id === socket.id)
    if (playerIndex === -1) return callback({ error: 'Не в игре' })

    const result = engine.drawAction(room, playerIndex)
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
    const playerIndex = room.players.findIndex(p => p.id === socket.id)
    if (playerIndex === -1) return callback({ error: 'Не в игре' })

    const result = engine.callUno(room, playerIndex)
    if (result.error) return callback({ error: result.error })
    io.to(roomId).emit('uno_called', { player: room.players[playerIndex].name })
    callback({ success: true })
  })

  socket.on('leave', () => markDisconnected(socket))
  socket.on('disconnect', () => markDisconnected(socket))
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`UNO server running on port ${PORT}`)
})
