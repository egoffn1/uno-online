const $ = id => document.getElementById(id)

let state = { roomId: null, name: null, isHost: false, hand: [], inGame: false }
let pendingWildCard = null
let myPlayerIndex = -1
let isAnimating = false
let selectedMode = 'classic'
let isPendingApproval = false

function navigateTo(path) {
  if (window.location.pathname !== path) {
    history.pushState(null, '', path)
  }
}

function navigateToRoom(roomId) {
  navigateTo(`/room/${roomId}`)
}

function navigateToLobby() {
  navigateTo('/')
}

window.addEventListener('popstate', () => {
  const path = window.location.pathname
  const match = path.match(/^\/room\/(\w+)$/)
  if (!match && (state.roomId || isPendingApproval)) {
    leaveRoom()
  }
})

const initialPath = window.location.pathname
const initialRoomMatch = initialPath.match(/^\/room\/(\w+)$/)
let initialRoomId = initialRoomMatch ? initialRoomMatch[1] : null

let reconnectTimer = null
let reconnectCount = 0

function showReconnectModal(count) {
  const modal = $('reconnect-modal')
  const text = $('reconnect-text')
  const cd = $('reconnect-countdown')
  if (!modal || !cd) return
  cd.textContent = String(count)
  if (text) text.textContent = 'Потеря связи...'
  modal.classList.remove('hidden')
}

function hideReconnectModal() {
  const modal = $('reconnect-modal')
  if (modal) modal.classList.add('hidden')
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null }
}

function startReconnectCountdown() {
  reconnectCount = 5
  showReconnectModal(reconnectCount)
  if (reconnectTimer) clearInterval(reconnectTimer)
  reconnectTimer = setInterval(() => {
    reconnectCount--
    if (reconnectCount <= 0) {
      clearInterval(reconnectTimer)
      reconnectTimer = null
      hideReconnectModal()
      if (state.inGame) {
        showError('Ты был кикнут из игры')
        leaveRoom()
      }
      return
    }
    const cd = $('reconnect-countdown')
    if (cd) cd.textContent = String(reconnectCount)
  }, 1000)
}

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  randomizationFactor: 0.3,
  timeout: 10000,
  transports: ['websocket', 'polling']
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

function createCardEl(card, chosenColor) {
  const displayColor = chosenColor || card.color
  const el = document.createElement('div')
  el.className = `card ${displayColor}`
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

const colorMap = { red: '#e74c3c', yellow: '#f1c40f', green: '#2ecc71', blue: '#3498db' }
const colorNamesRu = { red: 'Красный', yellow: 'Жёлтый', green: 'Зелёный', blue: 'Синий' }

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
        hideReconnectModal()
        if (res.state.phase === 'playing') {
          enterGame(res.state, res.hands)
        } else {
          enterWaiting(res.state)
        }
      } else if (res && res.error) {
        hideReconnectModal()
        showError('Не удалось переподключиться')
        leaveRoom()
      }
    })
  }
})

socket.on('disconnect', () => {
  setConnStatus(false, 'Reconnecting...')
  if (state.inGame || state.roomId) startReconnectCountdown()
})
socket.on('connect_error', () => setConnStatus(false, 'Connection error'))

function showError(msg) {
  const el = $('error-msg')
  if (el) { el.textContent = msg; el.classList.remove('hidden') }
  const ge = $('game-error')
  if (ge) {
    ge.textContent = msg
    ge.classList.remove('hidden')
    clearTimeout(ge._timeout)
    ge._timeout = setTimeout(() => ge.classList.add('hidden'), 4000)
  }
  const tn = $('turn-notification')
  if (tn && msg.length < 40) {
    tn.textContent = '⚠ ' + msg
    tn.classList.remove('hidden')
    tn.style.animation = 'none'
    void tn.offsetHeight
    tn.style.background = 'linear-gradient(135deg, #e67e22, #d35400)'
    tn.style.animation = 'fadeInOut 2.5s ease forwards'
    setTimeout(() => { tn.classList.add('hidden'); tn.style.background = '' }, 2500)
  }
}

function hideError() {
  const el = $('error-msg')
  if (el) el.classList.add('hidden')
}

// === Mode selector ===
function initModeButtons(container) {
  container.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      selectedMode = btn.dataset.mode
      if (state.isHost && state.roomId) {
        socket.emit('update_settings', { mode: selectedMode }, () => {})
      }
    })
  })
}

initModeButtons(document.querySelector('#lobby-view .mode-select'))
initModeButtons(document.querySelector('#waiting-view .mode-select'))

// === Public rooms ===
function refreshPublicRooms() {
  if (!socket.connected) return
  socket.emit('list_public_rooms', {}, (res) => {
    if (!res || !res.rooms) return
    const container = $('public-rooms')
    const list = $('public-rooms-list')
    if (!container || !list) return
    if (res.rooms.length === 0) {
      container.classList.add('hidden')
      return
    }
    container.classList.remove('hidden')
    list.innerHTML = res.rooms.map(r => `
      <div class="public-room-item" data-room-id="${r.id}">
        <div class="public-room-info">
          <span class="public-room-id">${r.id}</span>
          <span class="public-room-meta">${r.hostName} • ${r.mode === 'combo' ? 'Комбо' : 'Классический'} • ${r.playerCount}/10</span>
        </div>
        <button class="btn btn-primary btn-small public-room-join-btn">Войти</button>
      </div>
    `).join('')

    list.querySelectorAll('.public-room-item').forEach(item => {
      item.addEventListener('click', () => {
        const rid = item.dataset.roomId
        $('room-input').value = rid
        joinRoom(rid)
      })
      const btn = item.querySelector('.public-room-join-btn')
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          const rid = item.dataset.roomId
          $('room-input').value = rid
          joinRoom(rid)
        })
      }
    })
  })
}

$('refresh-rooms-btn').addEventListener('click', refreshPublicRooms)

setInterval(refreshPublicRooms, 10000)

// === Lobby ===
function createRoom(type) {
  const name = $('name-input').value.trim()
  if (!name) { showError('Введи имя!'); return }
  if (!socket.connected) { showError('Нет соединения с сервером'); return }
  hideError(); state.name = name
  socket.emit('create_room', { name, mode: selectedMode, type }, (res) => {
    if (res.error) { showError(res.error); return }
    state.roomId = res.roomId
    state.isHost = !(type === 'solo' && res.solo)

    if (res.solo) {
      enterGame(res.state, res.hands)
    } else {
      enterWaiting(res.state)
    }
  })
}

$('create-solo-btn').addEventListener('click', () => createRoom('solo'))
$('create-public-btn').addEventListener('click', () => createRoom('public'))
$('create-private-btn').addEventListener('click', () => createRoom('private'))

$('join-btn').addEventListener('click', () => joinRoom($('room-input').value.trim()))
$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('create-private-btn').click() })
$('room-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click() })

function joinRoom(roomId) {
  if (!roomId) { showError('Введи код комнаты!'); return }
  const name = $('name-input').value.trim()
  if (!name) { showError('Введи имя!'); return }
  if (!socket.connected) { showError('Нет соединения с сервером'); return }
  hideError(); state.name = name
  $('join-btn').disabled = true
  socket.emit('join_room', { roomId, name }, (res) => {
    $('join-btn').disabled = false
    if (res.error) { showError(res.error); return }
    if (res.pending) {
      isPendingApproval = true
      $('pending-modal-text').textContent = 'Ожидаем подтверждения хоста...'
      $('pending-modal').classList.remove('hidden')
      state.roomId = roomId
      return
    }
    state.roomId = roomId; state.isHost = false; state.inGame = false
    enterWaiting(res.state)
  })
}

$('pending-cancel-btn').addEventListener('click', () => {
  $('pending-modal').classList.add('hidden')
  isPendingApproval = false
  socket.emit('leave')
  state.roomId = null
})

const urlParams = new URLSearchParams(window.location.search)
const inviteRoom = urlParams.get('room') || initialRoomId
if (inviteRoom) {
  $('room-input').value = inviteRoom
  const info = $('invite-info')
  if (info) {
    info.textContent = `Тебя пригласили в комнату ${inviteRoom}! Введи имя и нажми "Войти"`
    info.classList.remove('hidden')
  }
  $('name-input').focus()
}

// === Settings ===
function openSettingsModal(settings) {
  const modal = $('settings-modal')
  if (!modal) return
  if (settings) {
    $('set-comboStacking').checked = !!settings.comboStacking
    $('set-includeWild4').checked = settings.includeWild4 !== false
    $('set-includeWild').checked = settings.includeWild !== false
    $('set-includeDraw2').checked = settings.includeDraw2 !== false
    $('set-includeSkip').checked = settings.includeSkip !== false
    $('set-includeReverse').checked = settings.includeReverse !== false
    $('set-handSize').value = settings.handSize || 7
  }
  modal.classList.remove('hidden')
}

$('settings-apply-btn').addEventListener('click', () => {
  const settings = {
    comboStacking: $('set-comboStacking').checked,
    includeWild4: $('set-includeWild4').checked,
    includeWild: $('set-includeWild').checked,
    includeDraw2: $('set-includeDraw2').checked,
    includeSkip: $('set-includeSkip').checked,
    includeReverse: $('set-includeReverse').checked,
    handSize: parseInt($('set-handSize').value) || 7
  }
  $('settings-modal').classList.add('hidden')
  socket.emit('update_settings', { settings }, (res) => {
    if (res && res.error) showError(res.error)
  })
})

$('settings-cancel-btn').addEventListener('click', () => {
  $('settings-modal').classList.add('hidden')
})

// === Waiting room ===
function enterWaiting(roomState) {
  navigateToRoom(roomState.id)
  showView('waiting-view')
  $('room-code').textContent = roomState.id
  $('game-room-code').textContent = roomState.id
  $('start-btn').classList.add('hidden')
  updatePlayersList(roomState.players)

  const badge = $('room-type-badge')
  if (roomState.type === 'public') {
    badge.textContent = 'Открытая'
    badge.className = 'room-type-badge public'
    badge.classList.remove('hidden')
  } else if (roomState.type === 'private') {
    badge.textContent = 'Приватная'
    badge.className = 'room-type-badge private'
    badge.classList.remove('hidden')
  } else {
    badge.classList.add('hidden')
  }

  selectedMode = roomState.mode || 'classic'
  const modeBtns = document.querySelectorAll('#waiting-view .mode-btn')
  modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === selectedMode))

  const canEdit = state.isHost && roomState.phase === 'waiting'
  document.querySelectorAll('#waiting-view .mode-btn').forEach(b => {
    b.style.pointerEvents = canEdit ? '' : 'none'
    b.style.opacity = canEdit ? '' : '0.5'
  })
  $('settings-btn').style.display = canEdit ? '' : 'none'

  renderPendingPlayers(roomState.pendingPlayers || [])
}

function renderPendingPlayers(pending) {
  const container = $('pending-players')
  const list = $('pending-list')
  if (!container || !list) return

  if (!state.isHost || pending.length === 0) {
    container.classList.add('hidden')
    return
  }

  container.classList.remove('hidden')
  list.innerHTML = pending.map(p => `
    <div class="pending-item" style="animation-delay:${pending.indexOf(p)*0.1}s">
      <div class="player-avatar" style="background:${getAvatarColor(p.name)}">${getInitials(p.name)}</div>
      <span class="player-name">${p.name}</span>
      <div class="pending-actions">
        <button class="btn btn-primary btn-small approve-btn" data-id="${p.id}">✅</button>
        <button class="btn btn-danger btn-small reject-btn" data-id="${p.id}">❌</button>
      </div>
    </div>
  `).join('')

  list.querySelectorAll('.approve-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('approve_join', { playerId: btn.dataset.id }, (res) => {
        if (res && res.error) showError(res.error)
      })
    })
  })
  list.querySelectorAll('.reject-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('reject_join', { playerId: btn.dataset.id }, (res) => {
        if (res && res.error) showError(res.error)
      })
    })
  })
}

function updatePlayersList(players) {
  const list = $('waiting-players')
  if (!list) return
  list.innerHTML = players.map(p => `
    <div class="player-item ${p.isHost ? 'host' : ''}" style="animation-delay:${players.indexOf(p) * 0.08}s">
      <div class="player-avatar" style="background:${getAvatarColor(p.name)}">${getInitials(p.name)}</div>
      <span class="player-name">${p.name} ${p.isHost ? '<span class="host-badge">ХОСТ</span>' : ''} ${p.isBot ? '<span class="bot-badge">БОТ</span>' : ''}</span>
    </div>
  `).join('')
  const pc = $('players-count')
  if (pc) pc.textContent = `${players.length} игроков`
  const me = players.find(p => p.id === socket.id)
  const startBtn = $('start-btn')
  if (startBtn) {
    if (me && me.isHost && players.length >= 2) startBtn.classList.remove('hidden')
    else startBtn.classList.add('hidden')
  }
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
    navigator.clipboard.writeText($('room-code').textContent).then(() => {
      $('copy-btn').textContent = '✅'
      setTimeout(() => { $('copy-btn').textContent = '📋' }, 2000)
    })
  })
})

$('settings-btn').addEventListener('click', () => {
  if (state.isHost && window._lastSettings) {
    openSettingsModal(window._lastSettings)
  }
})

function leaveRoom() {
  socket.emit('leave')
  state = { roomId: null, name: state.name, isHost: false, hand: [], inGame: false }
  isPendingApproval = false
  $('create-btn') && ($('create-btn').disabled = false)
  $('join-btn').disabled = false
  navigateToLobby()
  showView('lobby-view')
  refreshPublicRooms()
}

$('leave-btn').addEventListener('click', leaveRoom)
$('game-leave-btn').addEventListener('click', leaveRoom)
$('back-to-lobby-btn').addEventListener('click', () => {
  $('game-over-modal').classList.add('hidden')
  leaveRoom()
})

// === Game ===
function enterGame(gameState, hands) {
  navigateToRoom(gameState.id)
  state.inGame = true
  state.hand = hands && hands[socket.id] ? hands[socket.id] : []
  myPlayerIndex = -1
  gameState.players.forEach((p, i) => { if (p.id === socket.id) myPlayerIndex = i })
  showView('game-view')
  scheduleDealAnimation(gameState)
}

function scheduleDealAnimation(gs) {
  const container = $('player-hand')
  if (!container) return
  container.innerHTML = ''

  state.hand.forEach((card, i) => {
    const el = createCardEl(card)
    el.classList.add('entering')
    el.style.setProperty('--fly-y', '-80px')
    el.style.setProperty('--fly-x', `${(Math.random() - 0.5) * 100}px`)
    el.style.animationDelay = `${i * 0.06}s`
    const idx = i
    el.addEventListener('click', () => onCardClick(idx))
    container.appendChild(el)
  })

  setTimeout(() => renderGame(gs), state.hand.length * 60 + 600)
}

function renderGame(gs) {
  window._lastGameState = gs

  const dir = $('game-direction')
  if (dir) {
    dir.textContent = gs.direction === 1 ? '→' : '←'
    dir.style.transform = gs.direction === 1 ? 'scaleX(1)' : 'scaleX(-1)'
  }

  const turnPlayer = $('turn-player')
  const turnIndicator = $('turn-indicator')
  if (turnPlayer && gs.players[gs.currentPlayerIndex]) {
    const name = gs.players[gs.currentPlayerIndex].name
    turnPlayer.textContent = gs.pendingDraw > 0 ? `${name} (+${gs.pendingDraw})` : name
  }
  if (turnIndicator) {
    const isMe = gs.currentPlayerIndex === myPlayerIndex
    turnIndicator.style.borderColor = isMe ? 'var(--accent)' : 'transparent'
    turnIndicator.style.boxShadow = isMe ? '0 0 20px rgba(241,196,15,0.3)' : 'none'
    turnPlayer.style.color = isMe ? 'var(--accent)' : ''
    turnPlayer.style.animation = isMe ? 'pulse 1s ease-in-out infinite' : 'none'
  }

  const colorChip = $('current-color-chip')
  if (colorChip) {
    if (gs.currentColor && gs.currentColor !== 'wild') {
      const c = colorMap[gs.currentColor] || '#555'
      colorChip.innerHTML = `<span class="chip-dot" style="background:${c}"></span><span class="color-chip-text">${colorNamesRu[gs.currentColor] || gs.currentColor}</span>`
    } else {
      colorChip.textContent = '—'
    }
  }

  const deckCount = $('deck-count')
  if (deckCount) deckCount.textContent = gs.remainingDeck !== undefined ? String(gs.remainingDeck) : '?'

  const opp = $('opponents')
  if (opp) {
    opp.innerHTML = gs.players.filter(p => p.id !== socket.id).map(p => {
      const isActive = gs.currentPlayerIndex === gs.players.findIndex(x => x.id === p.id)
      return `
        <div class="opponent-card ${isActive ? 'active-turn' : ''}">
          <div class="opponent-avatar" style="background:${getAvatarColor(p.name)}">${getInitials(p.name)}</div>
          <div class="opponent-name">${p.name} ${p.isBot ? '<span class="bot-badge">БОТ</span>' : ''}</div>
          <div class="opponent-cards">🃏<span>×${p.cardsCount}</span></div>
          ${isActive ? '<div class="opponent-turn-arrow">◀ ХОДИТ</div>' : ''}
        </div>`
    }).join('')
  }

  renderDiscardPile(gs)

  const pn = $('player-name')
  if (pn) {
    const me = gs.players.find(p => p.id === socket.id)
    pn.textContent = me ? me.name : ''
    pn.style.color = gs.currentPlayerIndex === myPlayerIndex ? 'var(--accent)' : ''
    pn.style.fontWeight = gs.currentPlayerIndex === myPlayerIndex ? '900' : ''
    pn.style.animation = gs.currentPlayerIndex === myPlayerIndex ? 'pulse 1.5s ease-in-out infinite' : 'none'
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

function renderDiscardPile(gs) {
  const discard = $('discard-pile')
  if (!discard) return
  if (!gs.discardTop) { discard.innerHTML = ''; return }
  discard.innerHTML = ''
  const chosenColor = gs.discardTop.color === 'wild' && gs.currentColor ? gs.currentColor : null
  discard.appendChild(createCardEl(gs.discardTop, chosenColor))
}

function triggerAutoDraw(count) {
  isAnimating = true
  const drawPile = $('draw-pile')
  if (drawPile) drawPile.classList.add('pulse')

  showTurnNotif(`Берёшь ${count} карт${count > 1 ? 'ы' : 'у'}!`)

  const handContainer = $('player-hand')
  const drawRect = drawPile ? drawPile.getBoundingClientRect() : { left: 0, top: 0 }
  const handRect = handContainer ? handContainer.getBoundingClientRect() : { left: 0, top: 0 }

  const fromX = drawRect.left + drawRect.width / 2
  const fromY = drawRect.top + drawRect.height / 2
  const toX = handRect.left + handRect.width / 2
  const toY = handRect.top

  const overlay = document.createElement('div')
  overlay.className = 'draw-animation-overlay'
  document.body.appendChild(overlay)

  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const fly = document.createElement('div')
      fly.className = 'draw-animation-card'
      fly.style.setProperty('--target-x', `${toX - fromX + (Math.random() - 0.5) * 60}px`)
      fly.style.setProperty('--target-y', `${toY - fromY - 20}px`)
      fly.style.left = `${fromX - 35}px`
      fly.style.top = `${fromY - 52}px`
      fly.style.transform = `rotate(${-20 + Math.random() * 40}deg)`
      fly.textContent = 'UNO'
      overlay.appendChild(fly)
    }, i * 150)
  }

  setTimeout(() => {
    socket.emit('draw_card', () => {
      overlay.remove()
      if (drawPile) drawPile.classList.remove('pulse')
      isAnimating = false
      if (window._lastGameState) renderGame(window._lastGameState)
    })
  }, (count - 1) * 150 + 600)
}

function renderHand() {
  const container = $('player-hand')
  if (!container) return
  container.innerHTML = ''
  state.hand.forEach((card, i) => {
    const el = createCardEl(card)
    el.style.animationDelay = `${i * 0.03}s`
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
  clone.style.transition = 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)'
  document.body.appendChild(clone)
  cardEl.style.visibility = 'hidden'

  requestAnimationFrame(() => {
    clone.style.left = `${discardRect.left + discardRect.width / 2 - cardRect.width / 2}px`
    clone.style.top = `${discardRect.top + discardRect.height / 2 - cardRect.height / 2}px`
    clone.style.transform = 'scale(0.7) rotate(8deg)'
    clone.style.opacity = '0.5'
  })

  setTimeout(() => clone.remove(), 400)
}

function onCardClick(index) {
  const card = state.hand[index]
  if (!card) return
  const gs = window._lastGameState
  if (!gs || gs.currentPlayerIndex !== myPlayerIndex || !state.inGame || isAnimating) return

  if (card.color === 'wild') {
    pendingWildCard = index
    const modal = $('color-picker-modal')
    const choices = modal ? modal.querySelectorAll('.color-choice') : []
    choices.forEach(el => { el.style.boxShadow = 'none'; el.style.transform = 'scale(1)' })
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
    if (modal) {
      modal.classList.add('hidden')
      modal.style.animation = 'fadeIn 0.15s ease reverse'
      setTimeout(() => { modal.style.animation = '' }, 200)
    }
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
  triggerAutoDraw(gs.pendingDraw || 1)
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
  el.style.background = ''
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
  const colors = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#fff']
  for (let i = 0; i < 120; i++) {
    const piece = document.createElement('div')
    piece.className = 'confetti'
    piece.style.left = `${Math.random() * 100}%`
    piece.style.background = colors[Math.floor(Math.random() * colors.length)]
    piece.style.width = `${4 + Math.random() * 12}px`
    piece.style.height = `${4 + Math.random() * 12}px`
    piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px'
    piece.style.setProperty('--fall-duration', `${2 + Math.random() * 4}s`)
    piece.style.setProperty('--fall-delay', `${Math.random() * 2}s`)
    piece.style.setProperty('--fall-rotation', `${Math.random() * 1080}deg`)
    container.appendChild(piece)
  }
  setTimeout(() => container.remove(), 7000)
}

function showGameOver(data) {
  const winner = data && data.winner ? data.winner : (data && data.reason === 'all_left' ? 'Ничья' : null)
  if (!winner) {
    showError('Игра прервана')
    leaveRoom()
    return
  }
  $('winner-text').textContent = `Победил: ${winner}! 🎉`
  $('game-over-modal').classList.remove('hidden')
  state.inGame = false
  spawnConfetti()
}

// === Socket events ===
socket.on('room_update', (gs) => {
  if (!gs) return
  window._lastGameState = gs
  if ($('waiting-view') && $('waiting-view').classList.contains('active')) {
    updatePlayersList(gs.players)
    renderPendingPlayers(gs.pendingPlayers || [])
  }
  if ($('game-view') && $('game-view').classList.contains('active') && !isAnimating) {
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
  if ($('game-view') && $('game-view').classList.contains('active')) {
    renderHand()
  }
})

socket.on('game_over', (data) => {
  if (!data) return
  showGameOver(data)
})

socket.on('player_left', (data) => {
  if (!data) return
  if (state.inGame) {
    if (data.wasKicked) {
      showError(`Игрок ${data.name || '—'} был кикнут`)
    } else {
      const msg = data.name ? `Игрок ${data.name} отключился` : 'Игрок отключился'
      showError(msg)
    }
    if (data.newHost) {
      setTimeout(() => showError(`Новый хост: ${data.newHost}`), 1000)
    }
    if (data.playerCount === 1) {
      setTimeout(() => showGameOver({ winner: state.name, reason: 'won' }), 1500)
    }
  }
})

socket.on('player_disconnected', (data) => {
  if (!data || !data.name) return
  if (state.inGame) {
    showError(`⚠ ${data.name} потерял связь (${Math.round(data.graceMs / 1000)} сек)`)
  }
})

socket.on('player_reconnected', (data) => {
  if (!data || !data.name) return
  if (state.inGame) {
    showError(`✅ ${data.name} вернулся`)
  }
})

socket.on('settings_updated', (data) => {
  if (!data) return
  window._lastSettings = data.settings
  if ($('waiting-view') && $('waiting-view').classList.contains('active')) {
    const modeBtns = document.querySelectorAll('#waiting-view .mode-btn')
    modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === data.mode))
    selectedMode = data.mode
  }
})

socket.on('join_request', (data) => {
  if (!data) return
  if ($('waiting-view') && $('waiting-view').classList.contains('active')) {
    const gs = window._lastGameState
    if (gs) renderPendingPlayers(gs.pendingPlayers || [])
  }
})

socket.on('join_approved', (data) => {
  $('pending-modal').classList.add('hidden')
  isPendingApproval = false
  state.isHost = false
  if (data && data.state) {
    enterWaiting(data.state)
  }
})

socket.on('join_rejected', (data) => {
  $('pending-modal').classList.add('hidden')
  isPendingApproval = false
  state.roomId = null
  showError(data && data.reason ? data.reason : 'Хост отклонил запрос')
})
