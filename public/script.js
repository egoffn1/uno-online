const socket = io()
let state = { roomId: null, name: null, isHost: false, hand: [] }
let pendingWildCard = null

const $ = id => document.getElementById(id)
const views = { lobby: $('lobby-view'), waiting: $('waiting-view'), game: $('game-view') }

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active'))
  views[name].classList.add('active')
}

function getCardSymbol(value) {
  const symbols = { skip: '⊘', reverse: '⟳', draw2: '+2', wild: 'W', wild4: '+4' }
  return symbols[value] || value
}

function createCardEl(card, small) {
  const el = document.createElement('div')
  el.className = `card ${card.color}`
  el.dataset.id = card.id
  const corner = document.createElement('span')
  corner.className = 'card-corner'
  corner.textContent = getCardSymbol(card.value)
  const val = document.createElement('span')
  val.className = 'card-value'
  val.textContent = getCardSymbol(card.value)
  el.appendChild(corner)
  el.appendChild(val)
  if (small) el.style.transform = 'scale(0.7)'
  return el
}

function getAvatarColor(name) {
  const colors = ['#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6','#1abc9c','#e67e22','#34495e']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

function getInitials(name) {
  return name.slice(0, 2).toUpperCase()
}

// Parse URL for room code
const urlParams = new URLSearchParams(window.location.search)
const inviteRoom = urlParams.get('room')

// Lobby
$('create-btn').addEventListener('click', () => {
  const name = $('name-input').value.trim()
  if (!name) { showError('Введи имя!'); return }
  hideError()
  state.name = name
  socket.emit('create_room', { name }, (res) => {
    if (res.error) { showError(res.error); return }
    state.roomId = res.roomId
    state.isHost = true
    enterWaiting(res.state)
  })
})

$('join-btn').addEventListener('click', () => {
  joinRoom($('room-input').value.trim())
})

$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('create-btn').click() })
$('room-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click() })

function joinRoom(roomId) {
  if (!roomId) { showError('Введи код комнаты!'); return }
  const name = $('name-input').value.trim()
  if (!name) { showError('Введи имя!'); return }
  hideError()
  state.name = name
  socket.emit('join_room', { roomId, name }, (res) => {
    if (res.error) { showError(res.error); return }
    state.roomId = roomId
    enterWaiting(res.state)
  })
}

if (inviteRoom) {
  $('room-input').value = inviteRoom
  setTimeout(() => $('join-btn').click(), 300)
}

function showError(msg) {
  const el = $('error-msg')
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideError() {
  $('error-msg').classList.add('hidden')
}

// Copy invite link
$('copy-btn').addEventListener('click', () => {
  const link = `${window.location.origin}?room=${state.roomId}`
  navigator.clipboard.writeText(link).then(() => {
    $('copy-btn').textContent = '✅'
    setTimeout(() => { $('copy-btn').textContent = '📋' }, 2000)
  }).catch(() => {
    const code = $('room-code').textContent
    navigator.clipboard.writeText(code).then(() => {
      $('copy-btn').textContent = '✅'
      setTimeout(() => { $('copy-btn').textContent = '📋' }, 2000)
    })
  })
})

$('leave-btn').addEventListener('click', leaveRoom)
$('game-leave-btn').addEventListener('click', leaveRoom)
$('back-to-lobby-btn').addEventListener('click', () => {
  $('game-over-modal').classList.add('hidden')
  leaveRoom()
})

function leaveRoom() {
  socket.emit('leave')
  state = { roomId: null, name: null, isHost: false, hand: [] }
  showView('lobby')
}

$('start-btn').addEventListener('click', () => {
  socket.emit('start_game', {}, (res) => {
    if (res.error) showError(res.error)
  })
})

// Waiting room
function enterWaiting(roomState) {
  showView('waiting')
  $('room-code').textContent = roomState.id
  $('game-room-code').textContent = roomState.id
  $('start-btn').classList.add('hidden')
  updatePlayersList(roomState.players)
}

function updatePlayersList(players) {
  const list = $('waiting-players')
  list.innerHTML = players.map(p => `
    <div class="player-item ${p.isHost ? 'host' : ''}">
      <div class="player-avatar" style="background:${getAvatarColor(p.name)}">${getInitials(p.name)}</div>
      <span class="player-name">${p.name} ${p.isHost ? '<span class="host-badge">ХОСТ</span>' : ''}</span>
    </div>
  `).join('')
  $('players-count').textContent = `${players.length} игроков`

  const me = players.find(p => p.id === socket.id)
  if (me && me.isHost && players.length >= 2) {
    $('start-btn').classList.remove('hidden')
  } else {
    $('start-btn').classList.add('hidden')
  }
}

// Game
let myPlayerIndex = -1

function enterGame(gameState, hands) {
  showView('game')
  state.hand = hands[socket.id] || []
  myPlayerIndex = -1
  gameState.players.forEach((p, i) => { if (p.id === socket.id) myPlayerIndex = i })
  renderGame(gameState)
}

function renderGame(gs) {
  // Direction
  $('game-direction').textContent = gs.direction === 1 ? '→' : '←'
  $('game-direction').style.transform = gs.direction === 1 ? 'scaleX(1)' : 'scaleX(-1)'

  // Opponents
  const oppContainer = $('opponents')
  oppContainer.innerHTML = gs.players
    .filter(p => p.id !== socket.id)
    .map((p, i) => `
      <div class="opponent-card ${gs.currentPlayerIndex === gs.players.findIndex(x => x.id === p.id) ? 'active-turn' : ''}">
        <div class="opponent-name">${p.name}</div>
        <div class="opponent-cards">🃏<span>×${p.cardsCount}</span></div>
      </div>
    `).join('')

  // Discard pile
  const discard = $('discard-pile')
  if (gs.discardTop) {
    discard.innerHTML = ''
    const cardEl = createCardEl(gs.discardTop)
    discard.appendChild(cardEl)
    if (gs.discardTop.color === 'wild') {
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:absolute;bottom:-4px;font-size:11px;font-weight:700;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:4px;color:#fff'
      overlay.textContent = gs.currentColor
      cardEl.appendChild(overlay)
      cardEl.style.position = 'relative'
    }
  }

  // Player hand
  renderHand()

  // Turn notification
  if (gs.currentPlayerIndex === myPlayerIndex) {
    showTurnNotif('Твой ход!')
  }
}

function renderHand() {
  const container = $('player-hand')
  container.innerHTML = ''
  state.hand.forEach((card, i) => {
    const el = createCardEl(card)
    el.addEventListener('click', () => onCardClick(i))
    container.appendChild(el)
  })
}

function onCardClick(index) {
  const card = state.hand[index]
  if (!card) return

  const gs = getGameState()
  if (!gs || gs.currentPlayerIndex !== myPlayerIndex) return

  if (card.color === 'wild') {
    pendingWildCard = index
    $('color-picker-modal').classList.remove('hidden')
    return
  }

  socket.emit('play_card', { cardIndex: index }, (res) => {
    if (res.error) showError(res.error)
  })
}

// Color picker
document.querySelectorAll('.color-choice').forEach(el => {
  el.addEventListener('click', () => {
    const color = el.dataset.color
    $('color-picker-modal').classList.add('hidden')
    if (pendingWildCard !== null) {
      socket.emit('play_card', { cardIndex: pendingWildCard, chosenColor: color }, (res) => {
        if (res.error) showError(res.error)
      })
      pendingWildCard = null
    }
  })
})

// Draw pile click
$('draw-pile').addEventListener('click', () => {
  const gs = getGameState()
  if (!gs || gs.currentPlayerIndex !== myPlayerIndex) return

  socket.emit('draw_card', {}, (res) => {
    if (res.error) showError(res.error)
  })
})

// UNO button
$('uno-btn').addEventListener('click', () => {
  socket.emit('call_uno', {}, (res) => {
    if (res.error) showError(res.error)
  })
})

function showTurnNotif(text) {
  const el = $('turn-notification')
  el.textContent = text
  el.classList.remove('hidden')
  el.style.animation = 'none'
  void el.offsetHeight
  el.style.animation = 'fadeInOut 1.5s ease forwards'
  setTimeout(() => el.classList.add('hidden'), 1500)
}

function getGameState() {
  return window._lastGameState
}

// Socket events
socket.on('room_update', (gs) => {
  if (views.waiting.classList.contains('active')) {
    updatePlayersList(gs.players)
  }
  window._lastGameState = gs
  if (views.game.classList.contains('active')) {
    renderGame(gs)
  }
})

socket.on('game_start', (data) => {
  window._lastGameState = data.state
  enterGame(data.state, data.hands)
})

socket.on('hand_update', (data) => {
  state.hand = data.hand
  if (views.game.classList.contains('active')) {
    renderHand()
  }
})

socket.on('game_over', (data) => {
  $('winner-text').textContent = `Победил: ${data.winner}! 🎉`
  $('game-over-modal').classList.remove('hidden')
})

socket.on('player_left', () => {
  showError('Игрок отключился')
})
