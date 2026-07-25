const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const path = require('path')
const engine = require('./game-engine')

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(express.static(path.join(__dirname, 'public')))

const rooms = new Map()
const socketToRoom = new Map()
const botTimers = new Map()

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
  if (!player || !player.isBot) return

  const delay = 800 + Math.random() * 700

  const timer = setTimeout(() => {
    if (!room || room.phase !== 'playing') return

    const botPlayer = room.players[room.currentPlayerIndex]
    if (!botPlayer || !botPlayer.isBot) return

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
    if (!p.isBot) io.to(p.id).emit('hand_update', { hand: p.hand })
  })
}

function disconnectPlayer(socket) {
  const roomId = socketToRoom.get(socket.id)
  if (!roomId) return
  const room = rooms.get(roomId)
  if (!room) return

  const player = room.players.find(p => p.id === socket.id)
  const playerName = player ? player.name : ''
  const wasHost = player ? player.isHost : false

  const isBotRoom = room.players.some(p => p.isBot)

  engine.removePlayer(room, socket.id)
  socketToRoom.delete(socket.id)
  socket.leave(roomId)

  if (isBotRoom || room.players.length === 0) {
    clearBotTimer(room)
    rooms.delete(roomId)
    return
  }

  broadcastRoomState(room)

  if (room.phase === 'ended') {
    if (room.winner) {
      io.to(roomId).emit('game_over', { winner: room.winner, reason: 'disconnect' })
    } else {
      io.to(roomId).emit('game_over', { winner: null, reason: 'all_left' })
    }
    clearBotTimer(room)
    return
  }

  if (room.phase === 'playing') {
    const newHost = wasHost && room.players.length > 0 ? room.players[0] : null
    io.to(roomId).emit('player_left', {
      name: playerName,
      newHost: newHost ? newHost.name : null,
      playerCount: room.players.length
    })
    if (newHost) {
      broadcastRoomState(room)
    }
  }
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
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const player = room.players.find(p => p.id === socket.id)
    if (!player) return callback({ error: 'Не в этой комнате' })

    player.name = name.trim() || player.name
    socketToRoom.set(socket.id, room.id)
    socket.join(roomId)

    const hands = {}
    room.players.forEach(p => { hands[p.id] = p.hand })
    callback({ state: getRoomState(room), hands })
    io.to(roomId).emit('room_update', getRoomState(room))
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

  socket.on('leave', () => disconnectPlayer(socket))
  socket.on('disconnect', () => disconnectPlayer(socket))
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`UNO server running on port ${PORT}`)
})
