import '../styles/memory.css'

export interface UIHandlers {
  onStart: (names: string[]) => void
  onClaimPlayer: (id: number) => void
  onNextTurn: () => void
  onRestart: () => void
  onCancelClaim: () => void
  onZoom: (action: 'in' | 'out' | 'reset') => void
}

type MemoryState = {
  players: { id: number; name: string; score: number }[]
  cards: { regionId: number; revealed: boolean }[]
  /** The zero-based index of the player whose turn it is. */
  turn: number
  phase: 'flip' | 'claim' | 'finished'
  flipsThisTurn: number
  /** One entry for each collected pair. */
  claimed: number[]
  lastMessage: string
}

type ModalName = 'setup' | 'rules' | 'result'

// A second UI mounted on the same root must not leave the first one's listeners behind.
const mountedRoots = new WeakMap<HTMLElement, AbortController>()

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character] ?? character)

const leafIcon = `<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M8 31C8 16 17 8 33 7c0 15-6 25-21 25" fill="#9acb59" stroke="#557d37" stroke-width="2.2" stroke-linejoin="round"/><path d="M8 33c6-8 12-13 20-18" stroke="#557d37" stroke-width="2.2" stroke-linecap="round"/></svg>`
const sparkIcon = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5l2.1 6.4 6.4 2.1-6.4 2.1L12 19.5l-2.1-6.4L3.5 11l6.4-2.1L12 2.5z" fill="currentColor"/><path d="M19 15v5M16.5 17.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
const mapIcon = `<svg viewBox="0 0 42 42" fill="none" aria-hidden="true"><path d="M4.5 10.5l10-4 13 4 10-4v25l-10 4-13-4-10 4v-25z" fill="#fff9db" stroke="#8d673e" stroke-width="2" stroke-linejoin="round"/><path d="M14.5 6.5v25m13-21v25" stroke="#bda87b" stroke-width="1.5"/><path d="M18 25c1-5 7-2 6-7" stroke="#e7954e" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 3"/><circle cx="23.5" cy="16" r="3" fill="#d97448"/></svg>`
const peopleIcon = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19v-1.5a5.5 5.5 0 0111 0V19H3.5zm12-12.7a3 3 0 010 5.7m1 1.8a4.8 4.8 0 013.9 4.7V19h-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const handIcon = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.5 12V4.7a1.6 1.6 0 013.2 0v5.7-2a1.5 1.5 0 013 0v2-1.2a1.5 1.5 0 013 0v1.5a1.5 1.5 0 013 0v3.7c0 4-2.2 6.2-6 6.2h-1.5c-2 0-3.5-.7-4.7-2.2l-3.4-4.3a1.5 1.5 0 012.2-2l1.2 1.1z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const arrowIcon = `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/**
 * The UI owns its DOM but never owns the 3D scene. Append the renderer's canvas to
 * boardElement; render() only updates status panels, so the canvas stays mounted.
 */
export class MemoryUI {
  readonly boardElement: HTMLElement
  private readonly root: HTMLElement
  private readonly handlers: UIHandlers
  private readonly listeners = new AbortController()
  private activeModal: ModalName | null = null
  private modalUnderRules: ModalName | null = null
  private focusBeforeModal: HTMLElement | null = null
  private playerCount = 2
  private playerMarkup = ''

  constructor(root: HTMLElement, handlers: UIHandlers) {
    mountedRoots.get(root)?.abort()
    mountedRoots.set(root, this.listeners)
    this.root = root
    this.handlers = handlers
    root.classList.add('memory-app')
    root.innerHTML = `
      <div class="memory-shell">
        <header class="memory-header">
          <div class="memory-brand" aria-label="충북 동네 한바퀴">
            <div class="memory-brand-mark" aria-hidden="true"><span>충북</span><i></i></div>
            <div class="memory-brand-copy"><span>우리 동네 보물찾기</span><strong>충북 동네 <em>한바퀴</em></strong></div>
          </div>
          <div class="memory-header-middle"><span class="memory-header-spark">${sparkIcon}</span><span><b>특별한 우리 동네 여행</b><small>관광지와 특산물의 짝을 찾아요</small></span></div>
          <div class="memory-header-actions"><span class="memory-offline"><i></i> 같은 기기 플레이</span><button class="memory-header-help" type="button" data-action="rules" aria-label="게임 방법 보기"><span>?</span> 게임 방법</button></div>
        </header>

        <main class="memory-layout">
          <aside class="memory-left" aria-label="게임 소개와 진행 상황">
            <div class="memory-welcome">
              <div class="memory-welcome-top"><span class="memory-eyebrow">CHUNGBUK TRIP</span><span class="memory-leaf">${leafIcon}</span></div>
              <p>어서 와요!</p><h1>우리 같이<br><em>충북 한바퀴</em></h1>
              <div class="memory-welcome-line"></div>
              <span class="memory-welcome-desc">산 따라, 물 따라<br>숨은 짝꿍을 찾아 떠나요.</span>
              <div class="memory-welcome-hills" aria-hidden="true"><i></i><i></i><i></i></div>
            </div>
            <section class="memory-panel memory-progress-panel" aria-labelledby="memory-progress-title">
              <div class="memory-section-heading"><div><span class="memory-kicker">OUR JOURNEY</span><h2 id="memory-progress-title">여행 진행 상황</h2></div><span class="memory-heading-icon">${mapIcon}</span></div>
              <div class="memory-progress-count"><span>찾은 짝</span><strong><b data-field="found">0</b><small> / 11</small></strong></div>
              <div class="memory-progress-track" role="progressbar" aria-label="짝 찾기 진행률" aria-valuemin="0" aria-valuemax="11" aria-valuenow="0"><span data-field="progress-bar"></span></div>
              <p class="memory-progress-caption">아직 <strong data-field="remaining">11쌍</strong>의 짝이 남았어요!</p>
            </section>
            <section class="memory-tips" aria-label="간단한 게임 규칙"><span class="memory-tips-icon">✦</span><div><b>기억해 주세요!</b><p>공개한 카드는 다시<br>뒤집지 않아요.</p></div></section>
            <div class="memory-left-footer"><span>함께여서 더 즐거운</span><b>충북 여행의 시작</b><span class="memory-foot-flower" aria-hidden="true">✿</span></div>
          </aside>

          <section class="memory-board-panel" aria-label="3D 충북 보드 게임판">
            <div class="memory-board-head"><div><span class="memory-kicker">LET'S EXPLORE!</span><h2>우리 동네 보물 지도 <span>✦</span></h2><p>충북 곳곳의 특별한 짝꿍을 만나보세요</p></div><span class="memory-board-badge">11개 지역 <b>·</b> 22장의 카드</span></div>
            <div class="memory-board-frame"><div class="memory-board-element" data-field="board" aria-label="3D 게임 보드"></div><div class="memory-board-overlay"><div class="memory-board-tag"><span>✦</span> 충북으로 떠나는 여행</div><div class="memory-board-zoom" aria-label="보드 보기 조작"><button type="button" data-action="zoom-in" aria-label="보드 확대">+</button><button type="button" data-action="zoom-out" aria-label="보드 축소">−</button><button type="button" data-action="zoom-reset" aria-label="보드 전체 보기">↺</button></div><div class="memory-board-hint">${handIcon}<span>카드를 클릭해서<br><b>숨은 짝을 찾아보세요!</b></span></div></div></div>
            <div class="memory-board-bottom"><span><i></i> 확대 버튼 또는 휠·두 손가락으로 확대해요</span><span>우리의 즐거운 한바퀴 <b>✿</b></span></div>
          </section>

          <aside class="memory-right" aria-label="차례 및 플레이어 상황">
            <section class="memory-turn-card" aria-labelledby="memory-turn-title"><div class="memory-turn-caption"><span class="memory-turn-dot"></span> 지금은 누구 차례?</div><div class="memory-turn-body"><div class="memory-turn-avatar" aria-hidden="true">✦</div><div><h2 id="memory-turn-title" data-field="turn-name">게임을 시작해요</h2><p data-field="turn-caption">차례마다 두 장씩 공개해요</p></div><span class="memory-turn-arrow">›</span></div></section>
            <section class="memory-panel memory-players-panel" aria-labelledby="memory-players-title"><div class="memory-section-heading"><div><span class="memory-kicker">PLAYERS</span><h2 id="memory-players-title">함께하는 여행자</h2></div><span class="memory-players-icon">${peopleIcon}</span></div><p class="memory-player-intro" data-field="player-intro">카드를 공개한 뒤 누구나 도전할 수 있어요!</p><div class="memory-player-list" data-field="players"><div class="memory-empty-players">게임을 시작하면 여행자가 보여요.</div></div></section>
            <section class="memory-status" aria-labelledby="memory-status-title"><div class="memory-status-icon">${sparkIcon}</div><div><h2 id="memory-status-title">지금은 이렇게!</h2><p data-field="instruction">카드 두 장을 공개하고 짝을 찾아보세요.</p></div></section>
            <p class="memory-message" data-field="message" aria-live="polite">함께 충북 여행을 시작해 볼까요?</p>
            <div class="memory-actions"><button type="button" class="memory-btn memory-btn-primary" data-action="next" disabled>다음 차례 ${arrowIcon}</button><button type="button" class="memory-btn memory-btn-secondary" data-action="cancel" hidden>정답 도전 취소</button><button type="button" class="memory-btn memory-btn-quiet" data-action="restart"><span aria-hidden="true">↻</span> 새 게임</button></div>
            <p class="memory-local-note"><span aria-hidden="true">●</span> 같은 기기에서 함께 플레이해요</p>
          </aside>
        </main>
      </div>

      <div class="memory-modal-layer" data-modal="setup" hidden>
        <section class="memory-dialog memory-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-setup-title">
          <div class="memory-dialog-decoration" aria-hidden="true">${leafIcon}<span>✦</span></div><span class="memory-dialog-kicker">LET'S PLAY TOGETHER</span><h2 id="memory-setup-title">같은 기기에서 플레이</h2><p class="memory-dialog-lead">누구와 함께 충북으로 떠날까요?<br>여행자의 이름을 적고 시작해 주세요.</p>
          <form data-form="setup"><div class="memory-form-heading"><label>함께할 인원</label><span>2~6명</span></div><div class="memory-counts" role="group" aria-label="플레이어 인원 선택">${[2, 3, 4, 5, 6].map(count => `<button type="button" data-count="${count}" aria-label="${count}명" aria-pressed="${count === 2}">${count}<small>명</small></button>`).join('')}</div>
          <div class="memory-form-heading memory-names-heading"><label>여행자 이름</label><span>비워두면 기본 이름으로 시작해요</span></div><div class="memory-names">${Array.from({ length: 6 }, (_, index) => `<label class="memory-name-row" data-name-row="${index}" ${index >= 2 ? 'hidden' : ''}><span class="memory-name-index memory-avatar-${index}">${index + 1}</span><input type="text" maxlength="20" placeholder="플레이어 ${index + 1}" aria-label="플레이어 ${index + 1} 이름" autocomplete="off"></label>`).join('')}</div>
          <button type="submit" class="memory-btn memory-btn-primary memory-start-btn">여행 시작하기 ${arrowIcon}</button></form>
          <div class="memory-dialog-foot"><span>한 기기에서 함께 즐기는 게임</span><button type="button" data-action="rules">게임 방법 보기</button></div>
        </section>
      </div>

      <div class="memory-modal-layer" data-modal="rules" hidden><section class="memory-dialog memory-rules-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-rules-title"><button type="button" class="memory-close" data-action="close-modal" aria-label="게임 방법 닫기">×</button><span class="memory-dialog-kicker">HOW TO PLAY</span><h2 id="memory-rules-title">함께 떠나는 게임 방법</h2><p class="memory-dialog-lead">관광지와 특산물, 우리 동네의 짝을 찾아요!</p><ol class="memory-rule-list"><li><b>한 차례에 두 장!</b><span>자기 차례에 뒤집힌 카드 두 장을 차례로 공개해요. 한 번 공개한 카드는 다시 뒤집지 않아요.</span></li><li><b>짝을 찾으면 누구나 도전!</b><span>누구든지 해당 선수의 정답 도전 버튼을 누르고, 공개된 관광지와 특산물 카드를 차례로 클릭해요.</span></li><li><b>함께 찾아 완주해요!</b><span>11쌍을 모두 획득하면 가장 많이 찾은 사람이 우승해요. 동점이면 공동 우승이에요.</span></li></ol><div class="memory-rules-note">같은 기기에서 먼저 클릭한 사람이 우선이에요.<br>온라인 기능은 추후 제공될 예정이에요.</div><button class="memory-btn memory-btn-primary memory-full-btn" type="button" data-action="close-modal">알겠어요!</button></section></div>

      <div class="memory-modal-layer" data-modal="result" hidden><section class="memory-dialog memory-result-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-result-title"><button type="button" class="memory-close" data-action="close-modal" aria-label="결과 닫기">×</button><div class="memory-result-medal" aria-hidden="true">✦</div><span class="memory-dialog-kicker">TRIP COMPLETE!</span><h2 id="memory-result-title">즐거운 여행 끝!</h2><p class="memory-dialog-lead">충북의 11가지 짝꿍을 모두 찾았어요.</p><div class="memory-winner"><span data-field="winner-label">축하해요, 우승자!</span><strong data-field="winners"></strong><small>모두 함께해서 더욱 즐거운 여행이었어요.</small></div><button class="memory-btn memory-btn-primary memory-full-btn" type="button" data-action="restart">새로운 여행 시작하기 ${arrowIcon}</button><button class="memory-result-close" type="button" data-action="close-modal">결과 닫기</button></section></div>
    `
    this.boardElement = this.get<HTMLElement>('[data-field="board"]')
    const options = { signal: this.listeners.signal }
    root.addEventListener('click', this.onClick, options)
    root.addEventListener('submit', this.onSubmit, options)
    root.addEventListener('keydown', this.onKeyDown, options)
    this.showModal('setup')
  }

  render(state: MemoryState, claimingPlayer: number | null, selectedIds: string[]): void {
    const found = Math.min(11, Math.max(0, state.claimed.length))
    this.get('[data-field="found"]').textContent = String(found)
    this.get('[data-field="remaining"]').textContent = `${11 - found}쌍`
    this.get('[data-field="progress-bar"]').style.width = `${found / 11 * 100}%`
    this.get('[role="progressbar"]').setAttribute('aria-valuenow', String(found))
    const current = state.players[state.turn]
    this.get('[data-field="turn-name"]').textContent = state.phase === 'finished' ? '여행 완료!' : current ? `${current.name}의 차례` : '게임을 시작해요'
    this.get('[data-field="turn-caption"]').textContent = state.phase === 'finished' ? '모든 짝을 찾았어요' : '차례마다 두 장씩 공개해요'

    const canClaim = state.phase !== 'finished' && claimingPlayer === null &&
      state.cards.filter(card => card.revealed && !state.claimed.includes(card.regionId)).length >= 2
    const playersMarkup = state.players.length ? state.players.map((player, index) => {
      const active = index === state.turn && state.phase !== 'finished'
      const claiming = player.id === claimingPlayer
      const name = escapeHtml(player.name)
      const label = escapeHtml(`${player.name} 정답 도전${claiming ? ', 선택됨' : ''}`)
      const score = Number.isFinite(player.score) ? player.score : 0
      return `<button type="button" class="memory-player ${active ? 'is-current' : ''} ${claiming ? 'is-claiming' : ''}" data-player="${escapeHtml(String(player.id))}" aria-label="${label}" aria-pressed="${claiming}" ${!canClaim ? 'disabled' : ''}><span class="memory-player-avatar memory-avatar-${index % 6}">${index + 1}</span><span class="memory-player-name">${name}${active ? '<small>차례</small>' : ''}</span><span class="memory-player-score"><b>${score}</b> 쌍</span><span class="memory-player-select">${claiming ? '선택됨' : '도전'}</span></button>`
    }).join('') : '<div class="memory-empty-players">게임을 시작하면 여행자가 보여요.</div>'
    if (playersMarkup !== this.playerMarkup) {
      this.get('[data-field="players"]').innerHTML = playersMarkup
      this.playerMarkup = playersMarkup
    }
    this.get('[data-field="player-intro"]').textContent = state.phase === 'finished' ? '모두 함께 찾아낸 여행의 기록이에요.' : claimingPlayer !== null ? '먼저 도전한 여행자가 카드를 고르고 있어요.' : canClaim ? '짝을 찾은 사람을 선택해 도전해요!' : '공개된 카드가 두 장 이상이면 도전할 수 있어요.'
    const claimant = state.players.find(player => player.id === claimingPlayer)
    const instruction = state.phase === 'finished'
      ? '모든 짝을 찾았어요! 즐거운 여행이었나요?'
      : claimant
        ? selectedIds.length === 0
          ? `${claimant.name}님, 공개된 관광지와 특산물 카드 두 장을 차례로 선택해 주세요.`
          : `${claimant.name}님, 짝이 되는 공개된 카드를 선택해 주세요. (${Math.min(selectedIds.length, 2)}/2)`
        : state.phase === 'flip'
          ? state.flipsThisTurn === 0 ? '뒤집힌 카드 두 장을 차례로 클릭해 공개해 주세요.' : '카드 한 장을 더 클릭해 공개해 주세요. (1/2)'
          : '짝을 발견했다면 누구든 여행자를 선택해 정답에 도전해요!'
    this.get('[data-field="instruction"]').textContent = instruction
    this.get('[data-field="message"]').textContent = state.lastMessage || '함께 충북 여행을 시작해 볼까요?'
    const next = this.get<HTMLButtonElement>('[data-action="next"]')
    next.disabled = !state.players.length || state.phase !== 'claim' || claimingPlayer !== null
    this.get<HTMLButtonElement>('[data-action="cancel"]').hidden = claimingPlayer === null || state.phase === 'finished'
  }

  showResult(winners: string[]): void {
    this.get('[data-field="winner-label"]').textContent = winners.length > 1 ? '축하해요, 공동 우승!' : '축하해요, 우승자!'
    this.get('[data-field="winners"]').textContent = winners.length ? winners.join(' · ') : '모두 수고했어요!'
    this.showModal('result')
  }

  /** Remove listeners when this instance is no longer in use. */
  destroy(): void {
    this.listeners.abort()
    if (mountedRoots.get(this.root) === this.listeners) {
      mountedRoots.delete(this.root)
      this.root.replaceChildren()
      this.root.classList.remove('memory-app')
    }
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) throw new Error(`MemoryUI element not found: ${selector}`)
    return element
  }

  private showModal(name: ModalName | null): void {
    if (name && !this.activeModal && document.activeElement instanceof HTMLElement) this.focusBeforeModal = document.activeElement
    this.activeModal = name
    this.root.querySelectorAll<HTMLElement>('[data-modal]').forEach(layer => { layer.hidden = layer.dataset.modal !== name })
    if (name) {
      const layer = this.get<HTMLElement>(`[data-modal="${name}"]`)
      const focusTarget = layer.querySelector<HTMLElement>(name === 'setup' ? 'input' : 'button')
      focusTarget?.focus()
    } else {
      this.focusBeforeModal?.focus()
      this.focusBeforeModal = null
    }
  }

  private closeModal(): void {
    if (this.activeModal === 'rules' && this.modalUnderRules) {
      const previous = this.modalUnderRules
      this.modalUnderRules = null
      this.showModal(previous)
    } else if (this.activeModal !== 'setup') {
      this.showModal(null)
    }
  }

  private updateCount(count: number): void {
    this.playerCount = Math.min(6, Math.max(2, count))
    this.root.querySelectorAll<HTMLButtonElement>('[data-count]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.count) === this.playerCount)))
    this.root.querySelectorAll<HTMLElement>('[data-name-row]').forEach(row => { row.hidden = Number(row.dataset.nameRow) >= this.playerCount })
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
    if (!target || !this.root.contains(target)) return
    if (target.dataset.count) {
      this.updateCount(Number(target.dataset.count))
      return
    }
    if (target.dataset.player !== undefined) {
      const id = Number(target.dataset.player)
      if (Number.isFinite(id)) this.handlers.onClaimPlayer(id)
      return
    }
    switch (target.dataset.action) {
      case 'rules':
        this.modalUnderRules = this.activeModal
        this.showModal('rules')
        break
      case 'close-modal': this.closeModal(); break
      case 'next': this.handlers.onNextTurn(); break
      case 'cancel': this.handlers.onCancelClaim(); break
      case 'zoom-in': this.handlers.onZoom('in'); break
      case 'zoom-out': this.handlers.onZoom('out'); break
      case 'zoom-reset': this.handlers.onZoom('reset'); break
      case 'restart':
        this.handlers.onRestart()
        this.modalUnderRules = null
        this.showModal('setup')
        break
    }
  }

  private readonly onSubmit = (event: Event): void => {
    if (!(event.target instanceof HTMLFormElement) || event.target.dataset.form !== 'setup') return
    event.preventDefault()
    const inputs = Array.from(event.target.querySelectorAll<HTMLInputElement>('.memory-names input'))
    const names = inputs.slice(0, this.playerCount).map((input, index) => input.value.trim() || `플레이어 ${index + 1}`)
    this.showModal(null)
    this.handlers.onStart(names)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.activeModal) return
    if (event.key === 'Escape' && this.activeModal !== 'setup') {
      event.preventDefault()
      this.closeModal()
      return
    }
    if (event.key !== 'Tab') return
    const modal = this.get<HTMLElement>(`[data-modal="${this.activeModal}"]`)
    const focusable = Array.from(modal.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')).filter(element => element.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
}
