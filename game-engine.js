const COLORS = ['red', 'yellow', 'green', 'blue']
const VALUES = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2']

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

const defaultSettings = {
  comboStacking: false,
  includeWild4: true,
  includeWild: true,
  includeDraw2: true,
  includeSkip: true,
  includeReverse: true,
  handSize: 7,
  pointsToWin: 0
}

const gameModes = {
  classic: { label: 'Классический', ...defaultSettings },
  combo: { label: 'Комбо', ...defaultSettings, comboStacking: true }
}

function createRoom(mode = 'classic', type = 'private') {
  return {
    id: generateRoomId(),
    type,
    players: [],
    pendingPlayers: [],
    deck: [],
    discardPile: [],
    currentPlayerIndex: 0,
    direction: 1,
    phase: 'waiting',
    winner: null,
    pendingDraw: 0,
    currentColor: null,
    currentValue: null,
    mode,
    settings: { ...gameModes[mode] || gameModes.classic }
  }
}

function addPlayer(room, socketId, name, isBot = false) {
  const player = {
    id: socketId,
    name: isBot ? 'Бот' : name,
    hand: [],
    isHost: room.players.length === 0 && !isBot,
    calledUno: false,
    isBot
  }
  room.players.push(player)
  return player
}

function removePlayer(room, socketId) {
  const idx = room.players.findIndex(p => p.id === socketId)
  if (idx === -1) return null
  const wasHost = room.players[idx].isHost
  const removed = room.players.splice(idx, 1)[0]

  if (room.phase === 'playing') {
    if (idx < room.currentPlayerIndex) {
      room.currentPlayerIndex--
    } else if (idx === room.currentPlayerIndex) {
      advanceTurn(room)
    }
    if (room.currentPlayerIndex >= room.players.length && room.players.length > 0) {
      room.currentPlayerIndex = 0
    }
    if (room.players.length < 2) {
      room.phase = 'ended'
      room.winner = room.players.length === 1 ? room.players[0].name : null
    }
  }

  if (wasHost && room.players.length > 0) {
    room.players[0].isHost = true
  }

  return removed
}

function filterDeck(room, deck) {
  const s = room.settings
  let filtered = [...deck]
  if (!s.includeWild4) filtered = filtered.filter(c => c.value !== 'wild4')
  if (!s.includeWild) filtered = filtered.filter(c => c.value !== 'wild')
  if (!s.includeDraw2) filtered = filtered.filter(c => c.value !== 'draw2')
  if (!s.includeSkip) filtered = filtered.filter(c => c.value !== 'skip')
  if (!s.includeReverse) filtered = filtered.filter(c => c.value !== 'reverse')
  return filtered
}

function startGame(room) {
  let deck = shuffle(createDeck())
  deck = filterDeck(room, deck)
  if (deck.length < room.settings.handSize * room.players.length + 1) {
    return { error: 'Слишком мало карт для такого количества игроков' }
  }

  room.deck = deck
  room.discardPile = []
  room.currentPlayerIndex = 0
  room.direction = 1
  room.phase = 'playing'
  room.winner = null
  room.pendingDraw = 0

  for (const player of room.players) {
    player.hand = []
    player.calledUno = false
    for (let i = 0; i < room.settings.handSize; i++) {
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

  return { success: true }
}

function drawCards(room, count) {
  const drawn = []
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) recycleDeck(room)
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
  if (!player) return { error: 'Игрок не найден' }
  if (room.phase !== 'playing') return { error: 'Игра не начата' }
  if (room.currentPlayerIndex !== playerIndex) return { error: 'Не твой ход' }

  const card = player.hand[cardIndex]
  if (!card) return { error: 'Карта не найдена' }

  if (room.pendingDraw > 0) {
    if (!room.settings.comboStacking) {
      return { error: 'Сначала возьми карты' }
    }
    if (card.value !== 'draw2' && card.value !== 'wild4') {
      return { error: 'Сыграй +2 или +4 чтобы усилить' }
    }
    if (card.value === 'draw2' && room.currentValue !== 'draw2') {
      return { error: 'Можно усилить только +2' }
    }
    if (card.value === 'wild4' && room.currentValue !== 'wild4') {
      return { error: 'Можно усилить только +4' }
    }
  }

  if (!canPlayCard(card, room.currentColor, room.currentValue)) {
    return { error: 'Нельзя сыграть эту карту' }
  }

  player.hand.splice(cardIndex, 1)
  room.discardPile.push(card)

  if (card.color === 'wild') {
    if (!chosenColor || !COLORS.includes(chosenColor)) {
      return { error: 'Выбери цвет' }
    }
    room.currentColor = chosenColor
    room.currentValue = card.value
  } else {
    room.currentColor = card.color
    room.currentValue = card.value
  }

  if (room.pendingDraw > 0 && room.settings.comboStacking) {
    if (card.value === 'draw2') room.pendingDraw += 2
    else if (card.value === 'wild4') room.pendingDraw += 4
    advanceTurn(room)
    return { success: true }
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
  if (!player) return { error: 'Игрок не найден' }
  if (room.phase !== 'playing') return { error: 'Игра не начата' }
  if (room.currentPlayerIndex !== playerIndex) return { error: 'Не твой ход' }

  let count = room.pendingDraw > 0 ? room.pendingDraw : 1
  room.pendingDraw = 0

  const drawn = drawCards(room, count)
  player.hand.push(...drawn)

  advanceTurn(room)
  return { success: true, drawn: drawn }
}

function advanceTurn(room) {
  if (room.players.length === 0) return
  const total = room.players.length
  room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + total) % total
}

function callUno(room, playerIndex) {
  const player = room.players[playerIndex]
  if (!player) return { error: 'Игрок не найден' }
  if (player.hand.length === 1) {
    player.calledUno = true
    return { success: true }
  }
  return { error: 'Нельзя крикнуть UNO сейчас' }
}

function updateSettings(room, mode, settings) {
  if (mode && gameModes[mode]) {
    room.mode = mode
    room.settings = { ...gameModes[mode] }
    if (settings) {
      for (const key of Object.keys(defaultSettings)) {
        if (settings[key] !== undefined) {
          room.settings[key] = settings[key]
        }
      }
    }
  } else if (settings) {
    room.mode = 'custom'
    for (const key of Object.keys(defaultSettings)) {
      if (settings[key] !== undefined) {
        room.settings[key] = settings[key]
      }
    }
  }
  return room.settings
}

function pickColorForBot(player) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 }
  for (const c of player.hand) {
    if (c.color !== 'wild') counts[c.color]++
  }
  let best = COLORS[Math.floor(Math.random() * COLORS.length)]
  let max = 0
  for (const [color, count] of Object.entries(counts)) {
    if (count > max) { max = count; best = color }
  }
  return best
}

function getBotMove(room, playerIndex) {
  const player = room.players[playerIndex]
  if (!player || !player.isBot) return null

  const hand = player.hand

  if (room.pendingDraw > 0 && room.settings.comboStacking) {
    const matching = hand.filter(c =>
      (c.value === 'draw2' && room.currentValue === 'draw2') ||
      (c.value === 'wild4' && room.currentValue === 'wild4')
    )
    if (matching.length > 0) {
      const chosen = matching[Math.floor(Math.random() * matching.length)]
      const chosenColor = chosen.color === 'wild' ? pickColorForBot(player) : null
      const idx = hand.indexOf(chosen)
      return { action: 'play_card', cardIndex: idx, chosenColor }
    }
  }

  if (room.pendingDraw > 0) {
    return { action: 'draw' }
  }

  const playable = hand.filter(c => canPlayCard(c, room.currentColor, room.currentValue))

  if (playable.length > 0) {
    const nonWild = playable.filter(c => c.color !== 'wild')
    if (nonWild.length > 0) {
      const chosen = nonWild[Math.floor(Math.random() * nonWild.length)]
      const idx = hand.indexOf(chosen)
      return { action: 'play_card', cardIndex: idx, chosenColor: null }
    } else {
      const chosen = playable[Math.floor(Math.random() * playable.length)]
      const idx = hand.indexOf(chosen)
      const chosenColor = pickColorForBot(player)
      return { action: 'play_card', cardIndex: idx, chosenColor }
    }
  }

  return { action: 'draw' }
}

module.exports = {
  createRoom,
  addPlayer,
  removePlayer,
  startGame,
  playCard,
  drawAction,
  callUno,
  updateSettings,
  getBotMove,
  COLORS,
  defaultSettings,
  gameModes
}
