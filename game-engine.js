const COLORS = ['red', 'yellow', 'green', 'blue']
const VALUES = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2']
const WILD_VALUES = ['wild', 'wild4']

let roomIdCounter = 100000

function generateRoomId() {
  return String(++roomIdCounter).slice(1)
}

function createDeck() {
  const deck = []
  for (const color of COLORS) {
    for (const value of VALUES) {
      const count = value === '0' ? 1 : 2
      for (let i = 0; i < count; i++) {
        deck.push({ id: `${color}_${value}_${i}`, color, value, type: value === 'skip' || value === 'reverse' || value === 'draw2' ? 'action' : 'number' })
      }
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: `wild_${i}`, color: 'wild', value: 'wild', type: 'wild' })
    deck.push({ id: `wild4_${i}`, color: 'wild', value: 'wild4', type: 'wild' })
  }
  return deck
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function createRoom(hostName) {
  const room = {
    id: generateRoomId(),
    players: [],
    deck: [],
    discardPile: [],
    currentPlayerIndex: 0,
    direction: 1,
    phase: 'waiting',
    winner: null,
    turn: null,
    pendingDraw: 0,
    currentColor: null,
    currentValue: null
  }
  return room
}

function addPlayer(room, socketId, name) {
  const player = {
    id: socketId,
    name,
    hand: [],
    isHost: room.players.length === 0,
    ready: false,
    calledUno: false
  }
  room.players.push(player)
  return player
}

function removePlayer(room, socketId) {
  const idx = room.players.findIndex(p => p.id === socketId)
  if (idx === -1) return null
  const removed = room.players.splice(idx, 1)[0]
  if (room.players.length > 0 && removed.isHost) {
    room.players[0].isHost = true
  }
  return removed
}

function startGame(room) {
  const deck = shuffle(createDeck())
  room.deck = deck
  room.discardPile = []
  room.currentPlayerIndex = 0
  room.direction = 1
  room.phase = 'playing'
  room.winner = null
  room.pendingDraw = 0

  for (const player of room.players) {
    player.hand = []
    player.ready = false
    player.calledUno = false
    for (let i = 0; i < 7; i++) {
      player.hand.push(deck.pop())
    }
  }

  let firstCard = deck.pop()
  while (firstCard.color === 'wild') {
    deck.unshift(firstCard)
    shuffle(deck)
    firstCard = deck.pop()
  }
  room.discardPile.push(firstCard)
  room.currentColor = firstCard.color
  room.currentValue = firstCard.value

  if (firstCard.value === 'skip') {
    advanceTurn(room)
  } else if (firstCard.value === 'reverse') {
    room.direction *= -1
  } else if (firstCard.value === 'draw2') {
    room.pendingDraw = 2
  }

  return room
}

function drawCards(room, count) {
  const drawn = []
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) {
      recycleDeck(room)
    }
    if (room.deck.length === 0) break
    drawn.push(room.deck.pop())
  }
  return drawn
}

function recycleDeck(room) {
  if (room.discardPile.length <= 1) return
  const top = room.discardPile.pop()
  room.deck = shuffle(room.discardPile)
  room.discardPile = [top]
}

function canPlayCard(card, currentColor, currentValue) {
  if (card.color === 'wild') return true
  if (card.color === currentColor) return true
  if (card.value === currentValue) return true
  return false
}

function playCard(room, playerIndex, cardIndex, chosenColor) {
  const player = room.players[playerIndex]
  if (!player) return { error: 'Player not found' }
  if (room.phase !== 'playing') return { error: 'Game not in progress' }
  if (room.currentPlayerIndex !== playerIndex) return { error: 'Not your turn' }

  const card = player.hand[cardIndex]
  if (!card) return { error: 'Card not found' }

  if (!canPlayCard(card, room.currentColor, room.currentValue)) {
    return { error: 'Cannot play this card' }
  }

  player.hand.splice(cardIndex, 1)
  room.discardPile.push(card)

  if (card.color === 'wild') {
    if (!chosenColor || !COLORS.includes(chosenColor)) {
      return { error: 'Must choose a color for wild card' }
    }
    room.currentColor = chosenColor
    room.currentValue = card.value
  } else {
    room.currentColor = card.color
    room.currentValue = card.value
  }

  if (card.value === 'skip') {
    advanceTurn(room)
  } else if (card.value === 'reverse') {
    if (room.players.length === 2) {
      advanceTurn(room)
    } else {
      room.direction *= -1
    }
  } else if (card.value === 'draw2') {
    room.pendingDraw += 2
  } else if (card.value === 'wild4') {
    room.pendingDraw += 4
  }

  if (player.hand.length === 0) {
    room.phase = 'ended'
    room.winner = room.players[playerIndex].name
    return { success: true, winner: room.winner }
  }

  advanceTurn(room)
  return { success: true }
}

function drawAction(room, playerIndex) {
  const player = room.players[playerIndex]
  if (!player) return { error: 'Player not found' }
  if (room.phase !== 'playing') return { error: 'Game not in progress' }
  if (room.currentPlayerIndex !== playerIndex) return { error: 'Not your turn' }

  let count = room.pendingDraw > 0 ? room.pendingDraw : 1
  room.pendingDraw = 0

  const drawn = drawCards(room, count)
  player.hand.push(...drawn)

  advanceTurn(room)
  return { success: true, drawn: drawn }
}

function advanceTurn(room) {
  const total = room.players.length
  room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + total) % total
}

function callUno(room, playerIndex) {
  const player = room.players[playerIndex]
  if (!player) return { error: 'Player not found' }
  if (player.hand.length === 1) {
    player.calledUno = true
    return { success: true }
  }
  return { error: 'Cannot call UNO now' }
}

function catchUno(room, callerIndex, targetIndex) {
  const target = room.players[targetIndex]
  if (!target) return { error: 'Target not found' }
  if (target.hand.length === 1 && !target.calledUno) {
    const penalty = drawCards(room, 2)
    target.hand.push(...penalty)
    return { success: true, penalty: 2 }
  }
  return { error: 'No UNO to catch' }
}

module.exports = {
  createRoom,
  addPlayer,
  removePlayer,
  startGame,
  playCard,
  drawAction,
  callUno,
  catchUno,
  COLORS
}
