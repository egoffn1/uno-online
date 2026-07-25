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

function getRoomState(room) {
  return {
    id: room.id,
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      ready: p.ready,
      cardsCount: p.hand.length,
      calledUno: p.calledUno
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    direction: room.direction,
    winner: room.winner,
    discardTop: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null,
    currentColor: room.currentColor,
    currentValue: room.currentValue,
    pendingDraw: room.pendingDraw
  }
}

function disconnectPlayer(socket) {
  const roomId = socketToRoom.get(socket.id)
  if (!roomId) return
  const room = rooms.get(roomId)
  if (!room) return

  const player = room.players.find(p => p.id === socket.id)
  const playerName = player ? player.name : ''

  engine.removePlayer(room, socket.id)
  socketToRoom.delete(socket.id)
  socket.leave(roomId)

  if (room.players.length === 0) {
    rooms.delete(roomId)
  } else {
    io.to(roomId).emit('room_update', getRoomState(room))
    if (room.phase === 'playing') {
      io.to(roomId).emit('player_left', { id: socket.id, name: playerName })
    }
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }, callback) => {
    if (!name || name.trim().length === 0) {
      return callback({ error: 'Введи имя' })
    }
    const room = engine.createRoom(name.trim())
    engine.addPlayer(room, socket.id, name.trim())
    rooms.set(room.id, room)
    socketToRoom.set(socket.id, room.id)
    socket.join(room.id)
    callback({ roomId: room.id, state: getRoomState(room) })
  })

  socket.on('join_room', ({ roomId, name }, callback) => {
    if (!name || name.trim().length === 0) {
      return callback({ error: 'Введи имя' })
    }
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    if (room.phase !== 'waiting') return callback({ error: 'Игра уже началась' })
    if (room.players.length >= 10) return callback({ error: 'Комната полна' })

    engine.addPlayer(room, socket.id, name.trim())
    socketToRoom.set(socket.id, room.id)
    socket.join(room.id)
    callback({ state: getRoomState(room) })
    socket.to(room.id).emit('room_update', getRoomState(room))
  })

  socket.on('rejoin', ({ roomId, name }, callback) => {
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const oldPlayer = room.players.find(p => p.id === socket.id)
    if (!oldPlayer) return callback({ error: 'Не в этой комнате' })

    oldPlayer.name = name.trim() || oldPlayer.name
    socketToRoom.set(socket.id, room.id)
    socket.join(roomId)

    const hands = {}
    room.players.forEach(p => { hands[p.id] = p.hand })
    callback({ state: getRoomState(room), hands })
    io.to(roomId).emit('room_update', getRoomState(room))
  })

  socket.on('start_game', (_, callback) => {
    const roomId = socketToRoom.get(socket.id)
    if (!roomId) return callback({ error: 'Не в комнате' })
    const room = rooms.get(roomId)
    if (!room) return callback({ error: 'Комната не найдена' })
    const player = room.players.find(p => p.id === socket.id)
    if (!player || !player.isHost) return callback({ error: 'Только хост может начать' })
    if (room.players.length < 2) return callback({ error: 'Нужно минимум 2 игрока' })

    engine.startGame(room)
    const hands = {}
    room.players.forEach(p => { hands[p.id] = p.hand })
    io.to(roomId).emit('game_start', {
      state: getRoomState(room),
      hands
    })
    callback({ success: true })
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

    io.to(roomId).emit('room_update', getRoomState(room))
    room.players.forEach(p => {
      io.to(p.id).emit('hand_update', { hand: p.hand })
    })
    if (result.winner) {
      io.to(roomId).emit('game_over', { winner: result.winner })
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

    io.to(roomId).emit('room_update', getRoomState(room))
    room.players.forEach(p => {
      io.to(p.id).emit('hand_update', { hand: p.hand })
    })
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
