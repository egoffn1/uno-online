const $ = id => document.getElementById(id)

let state = { roomId: null, name: null, isHost: false, hand: [], inGame: false }
let pendingWildCard = null
let myPlayerIndex = -1
let isAnimating = false

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
})

function showView(name) {
  ;['lobby-view', 'waiting-view', 'game-view'].forEach(id => {
    const el = $(id)
    if (el) el.classList.remove('active')
  })
  const target = $(name)
  if (target) target.classList.add('active')
}

function getCardSymbol(value) {
  const s = { skip: '⊘', reverse: '⟳', draw2: '+2', wild: 'W', wild4: '+4' }
  return s[value] || value
}

function createCardEl(card) {
  const el = document.createElement('div')
  el.className = `card ${card.color}`
  el.dataset.id = card.id
  const sym = getCardSymbol(card.value)
  const isNum = /^\d$/.test(card.value)

  el.innerHTML = `
    <div class="card-inner">
      <div class="card-badge card-badge-top-left">
        <span class="card-badge-symbol">${sym}</span>
        <span class="card-badge-text">${isNum ? '' : card.value}</span>
      </div>
      <div class="card-center-shape">${sym}</div>
      <div class="card-center-text">${isNum ? '' : card.value}</div>
      <div class="card-badge card-badge-bottom-right">
        <span class="card-badge-symbol">${sym}</span>
        <span class="card-badge-text">${isNum ? '' : card.value}</span>
      </div>
    </div>
  `
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

// Connection status
const statusEl = document.createElement('div')
statusEl.id = 'conn-status'
statusEl.style.cssText = 'position:fixed;top:8px;right:8px;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;z-index:200;transition:all 0.3s'
document.body.appendChild(statusEl)

function setConnStatus(ok, msg) {
  statusEl.textContent = msg || (ok ? 'Connected' : 'Disconnected')
  statusEl.style.background = ok ? 'rgba(46,204,113,0.9)' : 'rgba(231,76,60,0.9)'
  statusEl.style.color = '#fff'
}

setConnStatus(false, 'Connecting...')

socket.on('connect', () => {
  setConnStatus(true, 'Connected')
  hideError()
  if (state.roomId && state.name) {
    socket.emit('rejoin', { roomId: state.roomId, name: state.name }, (res) => {
      if (res && res.state) {
        if (res.state.phase === 'playing') {
          enterGame(res.state, res.hands)
        } else {
          enterWaiting(res.state)
        }
      }
    })
  }
})

socket.on('disconnect', () => {
  setConnStatus(false, 'Reconnecting...')
})

socket.on('connect_error', () => {
  setConnStatus(false, 'Connection error')
})

// Lobby
function showError(msg) {
  const el = $('error-msg')
  if (el) { el.textContent = msg; el.classList.remove('hidden') }
  const ge = $('game-error')
  if (ge) {
    ge.textContent = msg
    ge.classList.remove('hidden')
    setTimeout(() => ge.classList.add('hidden'), 3000)
  }
}

function hideError() {
  const el = $('error-msg')
  if (el) el.classList.add('hidden')
}

$('create-btn').addEventListener('click', () => {
  const name = $('name-input').value.trim()
  if (!name) { showError('Введи имя!'); return }
  if (!socket.connected) { showError('Нет соединения с сервером'); return }
  hideError()
  state.name = name
  $('create-btn').disabled = true
  socket.emit('create_room', { name }, (res) => {
    $('create-btn').disabled = false
    if (res.error) { showError(res.error); return }
    state.roomId = res.roomId
    state.isHost = true
    state.inGame = false
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
  if (!socket.connected) { showError('Нет соединения с сервером'); return }
  hideError()
  state.name = name
  $('join-btn').disabled = true
  socket.emit('join_room', { roomId, name }, (res) => {
    $('join-btn').disabled = false
    if (res.error) { showError(res.error); return }
    state.roomId = roomId
    state.isHost = false
    state.inGame = false
    enterWaiting(res.state)
  })
}

const urlParams = new URLSearchParams(window.location.search)
const inviteRoom = urlParams.get('room')
if (inviteRoom) {
  $('room-input').value = inviteRoom
  const info = $('invite-info')
  if (info) {
    info.textContent = `Тебя пригласили в комнату ${inviteRoom}! Введи имя и нажми "Войти"`
    info.classList.remove('hidden')
  }
  $('name-input').focus()
}

// Waiting room
function enterWaiting(roomState) {
  showView('waiting-view')
  $('room-code').textContent = roomState.id
  $('game-room-code').textContent = roomState.id
  $('start-btn').classList.add('hidden')
  updatePlayersList(roomState.players)
}

function updatePlayersList(players) {
  const list = $('waiting-players')
  if (!list) return
  list.innerHTML = players.map(p => `
    <div class="player-item ${p.isHost ? 'host' : ''}">
      <div class="player-avatar" style="background:${getAvatarColor(p.name)}">${getInitials(p.name)}</div>
      <span class="player-name">${p.name} ${p.isHost ? '<span class="host-badge">ХОСТ</span>' : ''}</span>
    </div>
  `).join('')
  const pc = $('players-count')
  if (pc) pc.textContent = `${players.length} игроков`
  const me = players.find(p => p.id === socket.id)
  const startBtn = $('start-btn')
  if (startBtn) {
    if (me && me.isHost && players.length >= 2) {
      startBtn.classList.remove('hidden')
    } else {
      startBtn.classList.add('hidden')
    }
  }
  const pn = $('player-name')
  if (pn && me) pn.textContent = me.name
}

$('start-btn').addEventListener('click', () => {
  $('start-btn').disabled = true
  socket.emit('start_game', {}, (res) => {
    $('start-btn').disabled = false
    if (res && res.error) showError(res.error)
  })
})

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

function leaveRoom() {
  socket.emit('leave')
  state = { roomId: null, name: state.name, isHost: false, hand: [], inGame: false }
  $('create-btn').disabled = false
  $('join-btn').disabled = false
  showView('lobby-view')
}

$('leave-btn').addEventListener('click', leaveRoom)
$('game-leave-btn').addEventListener('click', leaveRoom)
$('back-to-lobby-btn').addEventListener('click', () => {
  $('game-over-modal').classList.add('hidden')
  leaveRoom()
})

// Game
function enterGame(gameState, hands) {
  state.inGame = true
  state.hand = hands[socket.id] || []
  myPlayerIndex = -1
  gameState.players.forEach((p, i) => { if (p.id === socket.id) myPlayerIndex = i })
  showView('game-view')
  renderGame(gameState)
}

function renderGame(gs) {
  window._lastGameState = gs

  // Direction
  const dir = $('game-direction')
  if (dir) {
    dir.textContent = gs.direction === 1 ? '→' : '←'
    dir.style.transform = gs.direction === 1 ? 'scaleX(1)' : 'scaleX(-1)'
  }

  // Turn indicator
  const turnPlayer = $('turn-player')
  const turnIndicator = $('turn-indicator')
  if (turnPlayer && gs.players[gs.currentPlayerIndex]) {
    const currentName = gs.players[gs.currentPlayerIndex].name
    turnPlayer.textContent = currentName
    if (gs.pendingDraw && gs.pendingDraw > 0) {
      turnPlayer.textContent = `${currentName} (+${gs.pendingDraw})`
    }
  }
  if (turnIndicator) {
    const isMe = gs.currentPlayerIndex === myPlayerIndex
    turnIndicator.style.borderColor = isMe ? 'var(--accent)' : 'transparent'
  }

  // Current color
  const colorChip = $('current-color-chip')
  if (colorChip) {
    if (gs.currentColor) {
      const colorMap = { red: '#e74c3c', yellow: '#f1c40f', green: '#2ecc71', blue: '#3498db' }
      colorChip.innerHTML = `<span class="color-chip" style="background:${colorMap[gs.currentColor] || '#333'};display:inline-block;width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);vertical-align:middle;margin-right:4px"></span><span class="color-chip-text">${gs.currentColor}</span>`
    } else {
      colorChip.textContent = '—'
    }
  }

  // Deck count
  const deckCount = $('deck-count')
  if (deckCount) {
    deckCount.textContent = gs.remainingDeck !== undefined ? String(gs.remainingDeck) : '?'
  }

  // Opponents
  const opp = $('opponents')
  if (opp) {
    opp.innerHTML = gs.players
      .filter(p => p.id !== socket.id)
      .map((p, i) => {
        const isActive = gs.currentPlayerIndex === gs.players.findIndex(x => x.id === p.id)
        return `
        <div class="opponent-card ${isActive ? 'active-turn' : ''}">
          <div class="opponent-avatar" style="background:${getAvatarColor(p.name)}">${getInitials(p.name)}</div>
          <div class="opponent-name">${p.name}</div>
          <div class="opponent-cards">🃏<span>×${p.cardsCount}</span></div>
          ${isActive ? '<div class="opponent-turn-arrow">◀ ХОДИТ</div>' : ''}
        </div>`
      }).join('')
  }

  // Discard pile
  const discard = $('discard-pile')
  if (discard) {
    if (gs.discardTop) {
      discard.innerHTML = ''
      const cardEl = createCardEl(gs.discardTop)
      discard.appendChild(cardEl)
      if (gs.currentColor && gs.discardTop.color === 'wild') {
        const tag = document.createElement('div')
        tag.style.cssText = 'position:absolute;bottom:-4px;font-size:11px;font-weight:700;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:4px;color:#fff'
        tag.textContent = gs.currentColor
        cardEl.appendChild(tag)
        cardEl.style.position = 'relative'
      }
    }
  }

  // Player name
  const pn = $('player-name')
  if (pn) {
    const me = gs.players.find(p => p.id === socket.id)
    pn.textContent = me ? me.name : ''
    if (gs.currentPlayerIndex === myPlayerIndex) {
      pn.style.color = 'var(--accent)'
      pn.style.fontWeight = '900'
    } else {
      pn.style.color = ''
      pn.style.fontWeight = ''
    }
  }

  renderHand()

  if (gs.currentPlayerIndex === myPlayerIndex && state.inGame && !isAnimating) {
    if (gs.pendingDraw && gs.pendingDraw > 0) {
      triggerAutoDraw(gs.pendingDraw)
    } else {
      showTurnNotif('Твой ход!')
    }
  }
}

function triggerAutoDraw(count) {
  isAnimating = true
  const drawPile = $('draw-pile')
  if (drawPile) drawPile.classList.add('pulse')

  showTurnNotif(`Берёшь ${count} карт${count > 1 ? 'ы' : 'у'}!`)

  const handContainer = $('player-hand')
  const drawPileRect = drawPile ? drawPile.getBoundingClientRect() : { left: 0, top: 0 }
  const handRect = handContainer ? handContainer.getBoundingClientRect() : { left: 0, top: 0 }

  const fromX = drawPileRect.left + drawPileRect.width / 2
  const fromY = drawPileRect.top + drawPileRect.height / 2
  const toX = handRect.left + handRect.width / 2
  const toY = handRect.top

  const overlay = document.createElement('div')
  overlay.className = 'draw-animation-overlay'
  document.body.appendChild(overlay)

  const cards = []
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const fly = document.createElement('div')
      fly.className = 'draw-animation-card'
      const dx = toX - fromX
      const dy = toY - fromY
      const rot = -20 + Math.random() * 40
      fly.style.setProperty('--target-x', `${dx + (Math.random() - 0.5) * 60}px`)
      fly.style.setProperty('--target-y', `${dy - 20}px`)
      fly.style.animationDuration = '0.5s'
      fly.style.animationDelay = '0s'
      fly.style.left = `${fromX - 35}px`
      fly.style.top = `${fromY - 52}px`
      fly.style.transform = `rotate(${rot}deg)`
      fly.textContent = 'UNO'
      overlay.appendChild(fly)
      cards.push(fly)
    }, i * 150)
  }

  const lastDelay = (count - 1) * 150
  setTimeout(() => {
    socket.emit('draw_card', {}, (res) => {
      overlay.remove()
      if (drawPile) drawPile.classList.remove('pulse')
      isAnimating = false
    })
  }, lastDelay + 600)
}

function renderHand() {
  const container = $('player-hand')
  if (!container) return
  container.innerHTML = ''
  state.hand.forEach((card, i) => {
    const el = createCardEl(card)
    const idx = i
    el.addEventListener('click', () => onCardClick(idx))
    container.appendChild(el)
  })
}

function showPlayCardAnimation(index) {
  const container = $('player-hand')
  const cards = container ? container.querySelectorAll('.card') : []
  const cardEl = cards[index]
  if (!cardEl) return

  const discard = $('discard-pile')
  if (!discard) return

  const cardRect = cardEl.getBoundingClientRect()
  const discardRect = discard.getBoundingClientRect()

  const clone = cardEl.cloneNode(true)
  clone.style.position = 'fixed'
  clone.style.left = `${cardRect.left}px`
  clone.style.top = `${cardRect.top}px`
  clone.style.width = `${cardRect.width}px`
  clone.style.height = `${cardRect.height}px`
  clone.style.zIndex = '90'
  clone.style.pointerEvents = 'none'
  clone.style.transition = 'all 0.4s cubic-bezier(0.68, -0.55, 0.27, 1.55)'
  document.body.appendChild(clone)

  cardEl.style.visibility = 'hidden'

  requestAnimationFrame(() => {
    clone.style.left = `${discardRect.left + discardRect.width / 2 - cardRect.width / 2}px`
    clone.style.top = `${discardRect.top + discardRect.height / 2 - cardRect.height / 2}px`
    clone.style.transform = 'scale(0.8) rotate(5deg)'
    clone.style.opacity = '0.8'
  })

  setTimeout(() => clone.remove(), 500)
}

function onCardClick(index) {
  const card = state.hand[index]
  if (!card) return
  const gs = window._lastGameState
  if (!gs || gs.currentPlayerIndex !== myPlayerIndex || !state.inGame || isAnimating) return

  if (card.color === 'wild') {
    pendingWildCard = index
    const modal = $('color-picker-modal')
    if (modal) modal.classList.remove('hidden')
    return
  }

  showPlayCardAnimation(index)
  socket.emit('play_card', { cardIndex: index }, (res) => {
    if (res && res.error) showError(res.error)
  })
}

document.querySelectorAll('.color-choice').forEach(el => {
  el.addEventListener('click', () => {
    const color = el.dataset.color
    const modal = $('color-picker-modal')
    if (modal) modal.classList.add('hidden')
    if (pendingWildCard !== null) {
      showPlayCardAnimation(pendingWildCard)
      socket.emit('play_card', { cardIndex: pendingWildCard, chosenColor: color }, (res) => {
        if (res && res.error) showError(res.error)
      })
      pendingWildCard = null
    }
  })
})

$('draw-pile').addEventListener('click', () => {
  const gs = window._lastGameState
  if (!gs || gs.currentPlayerIndex !== myPlayerIndex || !state.inGame || isAnimating) return
  if (gs.pendingDraw && gs.pendingDraw > 0) {
    triggerAutoDraw(gs.pendingDraw)
  } else {
    triggerAutoDraw(1)
  }
})

$('uno-btn').addEventListener('click', () => {
  socket.emit('call_uno', {}, (res) => {
    if (res && res.error) showError(res.error)
  })
})

function showTurnNotif(text) {
  const el = $('turn-notification')
  if (!el) return
  el.textContent = text
  el.classList.remove('hidden')
  el.style.animation = 'none'
  void el.offsetHeight
  el.style.animation = 'fadeInOut 1.8s ease forwards'
  setTimeout(() => el.classList.add('hidden'), 1800)
}

function spawnConfetti() {
  const container = document.createElement('div')
  container.className = 'confetti-container'
  document.body.appendChild(container)

  const colors = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#e67e22', '#1abc9c']
  for (let i = 0; i < 80; i++) {
    const piece = document.createElement('div')
    piece.className = 'confetti'
    piece.style.left = `${Math.random() * 100}%`
    piece.style.background = colors[Math.floor(Math.random() * colors.length)]
    piece.style.width = `${5 + Math.random() * 10}px`
    piece.style.height = `${5 + Math.random() * 10}px`
    piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px'
    piece.style.setProperty('--fall-duration', `${2 + Math.random() * 3}s`)
    piece.style.setProperty('--fall-delay', `${Math.random() * 2}s`)
    piece.style.setProperty('--fall-rotation', `${Math.random() * 720}deg`)
    container.appendChild(piece)
  }

  setTimeout(() => container.remove(), 6000)
}

// Socket events
socket.on('room_update', (gs) => {
  if (!gs) return
  const waiting = $('waiting-view')
  const game = $('game-view')
  window._lastGameState = gs
  if (waiting && waiting.classList.contains('active')) {
    updatePlayersList(gs.players)
  }
  if (game && game.classList.contains('active') && !isAnimating) {
    renderGame(gs)
  }
})

socket.on('game_start', (data) => {
  if (!data || !data.state) return
  window._lastGameState = data.state
  enterGame(data.state, data.hands || {})
})

socket.on('hand_update', (data) => {
  if (!data) return
  state.hand = data.hand || []
  const game = $('game-view')
  if (game && game.classList.contains('active')) {
    renderHand()
  }
})

socket.on('game_over', (data) => {
  if (!data) return
  $('winner-text').textContent = `Победил: ${data.winner}! 🎉`
  $('game-over-modal').classList.remove('hidden')
  state.inGame = false
  spawnConfetti()
})

socket.on('player_left', (data) => {
  if (state.inGame) {
    showError(`Игрок ${data.name || ''} отключился`)
  }
})
