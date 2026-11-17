import '../styles/memory.css'
import manifest from '../../assets.lock.json'
import { REGIONS } from '../game/memoryRules'
import { getTextureUrl } from '../game/textureUrls'

export interface UIHandlers {
  onStart: (names: string[]) => void
  onNextTurn: () => void
  onRestart: () => void
  onZoom: (action: 'in' | 'out' | 'reset') => void
  onOnlineCreate: (name: string) => void
  onOnlineJoin: (room: string, name: string) => void
  onOnlineLeave: () => void
  onCopyInvite: () => void
}

export type OnlineView = {
  active: boolean
  status: 'offline' | 'connecting' | 'waiting' | 'playing' | 'reconnecting' | 'error' | 'finished'
  message: string
  room: string
  seat: number | null
  canAct: boolean
  isHost: boolean
  /** True only when the server connection and current room permit a restart request. */
  canRestart: boolean
  members: { id: number; name: string; connected: boolean }[]
}

export type MemoryState = {
  players: { id: number; name: string; score: number; collected: number[] }[]
  /** The zero-based index of the player whose turn it is. */
  turn: number
  phase: 'flip' | 'resolving' | 'turnEnd' | 'finished'
  cards: { id: string; regionId: number; kind: 'place' | 'product'; revealed: boolean }[]
  selectedIds: string[]
  /** One entry for each collected pair. */
  claimed: number[]
  lastMessage: string
}

type ModalName = 'setup' | 'rules' | 'result'
type SetupMode = 'local' | 'online'

const offlineView = (): OnlineView => ({
  active: false, status: 'offline', message: '', room: '', seat: null,
  canAct: false, isHost: false, canRestart: false, members: [],
})

const onlineStatusLabels: Record<OnlineView['status'], string> = {
  offline: '연결되지 않음', connecting: '서버 연결 중', waiting: '참가자 대기 중',
  playing: '온라인 게임 중', reconnecting: '재접속 중', error: '연결 오류', finished: '온라인 게임 종료',
}

const onlineStatusMessages: Record<OnlineView['status'], string> = {
  offline: '온라인 플레이에는 서버 연결이 필요해요. 서버가 설정되어 있어야 이용할 수 있어요.',
  connecting: '서버에 연결하고 있어요. 잠시만 기다려 주세요.',
  waiting: '방에 연결됐어요. 다른 여행자를 초대하고 기다려 주세요.',
  playing: '같은 방의 여행자들과 함께 플레이하고 있어요.',
  reconnecting: '연결이 끊겨 재접속을 시도하고 있어요. 잠시 기다려 주세요.',
  error: '서버에 연결하지 못했어요. 서버 설정과 연결 상태를 확인하고 다시 시도해 주세요.',
  finished: '온라인 여행이 끝났어요. 새 게임 준비를 확인해 주세요.',
}

// A second UI mounted on the same root must not leave the first one's listeners behind.
const mountedRoots = new WeakMap<HTMLElement, AbortController>()

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character] ?? character)

const mascotAssets = manifest.assets as Record<string, { path: string }>
const regionsById = new Map(REGIONS.map(region => [region.id, region]))

const leafIcon = `<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M8 31C8 16 17 8 33 7c0 15-6 25-21 25" fill="#9acb59" stroke="#557d37" stroke-width="2.2" stroke-linejoin="round"/><path d="M8 33c6-8 12-13 20-18" stroke="#557d37" stroke-width="2.2" stroke-linecap="round"/></svg>`
const sparkIcon = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5l2.1 6.4 6.4 2.1-6.4 2.1L12 19.5l-2.1-6.4L3.5 11l6.4-2.1L12 2.5z" fill="currentColor"/><path d="M19 15v5M16.5 17.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
const mapIcon = `<svg viewBox="0 0 42 42" fill="none" aria-hidden="true"><path d="M4.5 10.5l10-4 13 4 10-4v25l-10 4-13-4-10 4v-25z" fill="#fff9db" stroke="#8d673e" stroke-width="2" stroke-linejoin="round"/><path d="M14.5 6.5v25m13-21v25" stroke="#bda87b" stroke-width="1.5"/><path d="M18 25c1-5 7-2 6-7" stroke="#e7954e" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 3"/><circle cx="23.5" cy="16" r="3" fill="#d97448"/></svg>`
const peopleIcon = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19v-1.5a5.5 5.5 0 0111 0V19H3.5zm12-12.7a3 3 0 010 5.7m1 1.8a4.8 4.8 0 013.9 4.7V19h-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const handIcon = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.5 12V4.7a1.6 1.6 0 013.2 0v5.7-2a1.5 1.5 0 013 0v2-1.2a1.5 1.5 0 013 0v1.5a1.5 1.5 0 013 0v3.7c0 4-2.2 6.2-6 6.2h-1.5c-2 0-3.5-.7-4.7-2.2l-3.4-4.3a1.5 1.5 0 012.2-2l1.2 1.1z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const arrowIcon = `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const onlineDetailsMarkup = (context: 'setup' | 'panel'): string => `
  <div class="memory-online-details" data-online-context="${context}">
    <div class="memory-online-heading"><span class="memory-online-dot" aria-hidden="true"></span><strong data-online-field="status"></strong></div>
    <p class="memory-online-message" data-online-field="message" role="status" aria-live="polite"></p>
    <div class="memory-online-room" data-online-field="room-section" hidden>
      <div class="memory-online-code"><span>방 코드</span><strong data-online-field="room"></strong></div>
      <div class="memory-online-copy-actions"><button type="button" data-action="copy-room">코드 복사</button><button type="button" data-action="copy-invite">초대 링크 복사</button></div>
    </div>
    <div class="memory-online-members" data-online-field="members-section" hidden><div class="memory-online-members-heading">함께하는 여행자 <span data-online-field="member-count"></span></div><ul data-online-field="members" aria-label="온라인 방 참가자"></ul></div>
    <p class="memory-copy-feedback" data-online-field="copy-feedback" role="status" aria-live="polite"></p>
    <div class="memory-online-bottom"><button type="button" data-action="online-setup" ${context === 'setup' ? 'hidden' : ''}>연결 다시 시도</button><button type="button" data-action="online-leave" hidden>연결 종료하고 같은 기기로</button></div>
  </div>`

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
  private wasFinished = false
  private setupMode: SetupMode = 'local'
  private online: OnlineView = offlineView()
  private lastState: MemoryState | null = null
  private hasOnlineGame = false
  private requestAction: 'create' | 'join' | null = null
  // The rules clear selectedIds after a match, so retain only this turn's IDs.
  private previewIds: string[] = []
  private previewMarkup = ''

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
          <div class="memory-header-actions"><span class="memory-offline" data-field="connection-label"><i></i><span data-field="connection-text">같은 기기 플레이</span></span><button class="memory-header-help" type="button" data-action="rules" aria-label="게임 방법 보기"><span>?</span> 게임 방법</button></div>
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
            <section class="memory-tips" aria-label="간단한 게임 규칙"><span class="memory-tips-icon">✦</span><div><b>기억해 주세요!</b><p>짝이 다르면 두 카드는<br>다시 뒤집혀요.</p></div></section>
            <div class="memory-left-footer"><span>함께여서 더 즐거운</span><b>충북 여행의 시작</b><span class="memory-foot-flower" aria-hidden="true">✿</span></div>
          </aside>

          <section class="memory-board-panel" aria-label="3D 충북 보드 게임판">
            <div class="memory-board-head"><div><span class="memory-kicker">LET'S EXPLORE!</span><h2>우리 동네 보물 지도 <span>✦</span></h2><p>충북 곳곳의 특별한 짝꿍을 만나보세요</p></div><span class="memory-board-badge">11개 지역 <b>·</b> 22장의 카드</span></div>
            <div class="memory-board-frame"><div class="memory-board-element" data-field="board" aria-label="3D 게임 보드"></div><div class="memory-board-overlay"><div class="memory-board-tag"><span>✦</span> 충북으로 떠나는 여행</div><div class="memory-board-zoom" aria-label="보드 보기 조작"><button type="button" data-action="zoom-in" aria-label="보드 확대">+</button><button type="button" data-action="zoom-out" aria-label="보드 축소">−</button><button type="button" data-action="zoom-reset" aria-label="보드 전체 보기">↺</button></div><div class="memory-board-hint">${handIcon}<span>카드를 클릭해서<br><b>숨은 짝을 찾아보세요!</b></span></div></div><div class="memory-board-network" data-field="board-network" hidden><strong data-field="board-network-title"></strong><span data-field="board-network-message"></span></div></div>
            <div class="memory-board-bottom"><span><i></i> 확대 버튼 또는 휠·두 손가락으로 확대해요</span><span>우리의 즐거운 한바퀴 <b>✿</b></span></div>
          </section>

          <aside class="memory-right" aria-label="차례 및 플레이어 상황">
            <section class="memory-panel memory-online-panel" data-field="online-panel" aria-label="온라인 방 상태" hidden>${onlineDetailsMarkup('panel')}</section>
            <section class="memory-turn-card" aria-labelledby="memory-turn-title"><div class="memory-turn-caption"><span class="memory-turn-dot"></span> 지금은 누구 차례?</div><div class="memory-turn-body"><div class="memory-turn-avatar" aria-hidden="true">✦</div><div><h2 id="memory-turn-title" data-field="turn-name">게임을 시작해요</h2><p data-field="turn-caption">차례마다 두 장씩 공개해요</p></div><span class="memory-turn-arrow">›</span></div></section>
            <div class="memory-actions"><button type="button" class="memory-btn memory-btn-primary" data-action="next" disabled>다음 차례 ${arrowIcon}</button><button type="button" class="memory-btn memory-btn-quiet" data-action="restart"><span aria-hidden="true">↻</span> 새 게임</button></div>
            <p class="memory-permission-note" data-field="online-permission" aria-live="polite" hidden></p>
            <section class="memory-panel memory-preview-panel" aria-labelledby="memory-preview-title"><div class="memory-preview-heading"><div><span class="memory-kicker">OPEN CARDS</span><h2 id="memory-preview-title">공개된 카드 크게 보기</h2></div><span class="memory-preview-count" data-field="preview-count">0 / 2</span></div><p class="memory-preview-caption">3D 보드에서 공개한 카드만 보여요.</p><div class="memory-preview-cards" data-field="preview-cards" aria-live="polite"><p class="memory-preview-empty">아직 공개된 카드가 없어요.<br>보드에서 카드를 선택해 주세요.</p></div></section>
            <section class="memory-panel memory-players-panel" aria-labelledby="memory-players-title"><div class="memory-section-heading"><div><span class="memory-kicker">PLAYERS</span><h2 id="memory-players-title">함께하는 여행자</h2></div><span class="memory-players-icon">${peopleIcon}</span></div><p class="memory-player-intro" data-field="player-intro">여행자들이 찾은 짝을 살펴봐요.</p><div class="memory-player-list" data-field="players" role="list"><div class="memory-empty-players">게임을 시작하면 여행자가 보여요.</div></div></section>
            <section class="memory-status" aria-labelledby="memory-status-title"><div class="memory-status-icon">${sparkIcon}</div><div><h2 id="memory-status-title">지금은 이렇게!</h2><p data-field="instruction">카드 두 장을 공개하고 짝을 찾아보세요.</p></div></section>
            <p class="memory-message" data-field="message" aria-live="polite">함께 충북 여행을 시작해 볼까요?</p>
            <p class="memory-local-note" data-field="play-note">같은 기기에서 함께 플레이해요</p>
          </aside>
        </main>
      </div>

      <div class="memory-modal-layer" data-modal="setup" hidden>
        <section class="memory-dialog memory-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-setup-title">
          <div class="memory-dialog-decoration" aria-hidden="true">${leafIcon}<span>✦</span></div><span class="memory-dialog-kicker">LET'S PLAY TOGETHER</span><h2 id="memory-setup-title" data-field="setup-title">같은 기기에서 플레이</h2><p class="memory-dialog-lead" data-field="setup-lead">누구와 함께 충북으로 떠날까요?<br>여행자의 이름을 적고 시작해 주세요.</p>
          <div class="memory-mode-switch" role="group" aria-label="플레이 방식 선택"><button type="button" data-action="mode-local" aria-pressed="true">같은 기기</button><button type="button" data-action="mode-online" aria-pressed="false">온라인</button></div>
          <form data-form="setup" data-setup-mode="local"><div class="memory-form-heading"><label>함께할 인원</label><span>2~6명</span></div><div class="memory-counts" role="group" aria-label="플레이어 인원 선택">${[2, 3, 4, 5, 6].map(count => `<button type="button" data-count="${count}" aria-label="${count}명" aria-pressed="${count === 2}">${count}<small>명</small></button>`).join('')}</div>
          <div class="memory-form-heading memory-names-heading"><label>여행자 이름</label><span>비워두면 기본 이름으로 시작해요</span></div><div class="memory-names">${Array.from({ length: 6 }, (_, index) => `<label class="memory-name-row" data-name-row="${index}" ${index >= 2 ? 'hidden' : ''}><span class="memory-name-index memory-avatar-${index}">${index + 1}</span><input type="text" maxlength="20" placeholder="플레이어 ${index + 1}" aria-label="플레이어 ${index + 1} 이름" autocomplete="off"></label>`).join('')}</div>
          <button type="submit" class="memory-btn memory-btn-primary memory-start-btn">여행 시작하기 ${arrowIcon}</button></form>
          <div data-setup-mode="online" hidden><form data-form="online" novalidate><label class="memory-online-label" for="memory-online-name">온라인에서 사용할 이름</label><input class="memory-online-input" id="memory-online-name" data-field="online-name" type="text" maxlength="20" autocomplete="nickname" placeholder="이름을 입력해 주세요"><button type="button" class="memory-btn memory-btn-primary memory-online-create" data-action="online-create">방 만들기</button><div class="memory-online-divider"><span>또는 초대 코드로 참가</span></div><label class="memory-online-label" for="memory-room-input">6자리 방 코드</label><div class="memory-join-row"><input class="memory-online-input memory-code-input" id="memory-room-input" data-field="room-input" type="text" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDEF" aria-describedby="memory-room-help"><button type="submit" class="memory-btn memory-btn-primary" data-action="online-join">참가하기</button></div><p id="memory-room-help" class="memory-online-hint">영문 대문자 6자리를 입력해 주세요.</p><p data-field="online-form-error" class="memory-form-error" role="alert" hidden></p></form>${onlineDetailsMarkup('setup')}</div>
          <div class="memory-dialog-foot"><span data-field="setup-foot">한 기기에서 함께 즐기는 게임</span><button type="button" data-action="rules">게임 방법 보기</button></div>
        </section>
      </div>

      <div class="memory-modal-layer" data-modal="rules" hidden><section class="memory-dialog memory-rules-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-rules-title"><button type="button" class="memory-close" data-action="close-modal" aria-label="게임 방법 닫기">×</button><span class="memory-dialog-kicker">HOW TO PLAY</span><h2 id="memory-rules-title">함께 떠나는 게임 방법</h2><p class="memory-dialog-lead">관광지와 특산물, 우리 동네의 짝을 찾아요!</p><ol class="memory-rule-list"><li><b>한 차례에 두 장!</b><span>자기 차례에 뒷면이 보이는 카드 두 장을 차례로 클릭해 공개해요.</span></li><li><b>같은 지역의 짝을 찾아요!</b><span>관광지와 특산물이 같은 지역이면 현재 차례 참가자가 그 지역 캐릭터를 자동으로 획득해요. 틀리면 잠시 보여 준 뒤 두 카드가 다시 뒤집혀요.</span></li><li><b>다음 차례로 출발!</b><span>결과를 확인한 뒤 다음 차례 버튼을 눌러요. 11쌍을 모두 찾으면 가장 많이 찾은 사람이 우승하고, 동점이면 공동 우승이에요.</span></li></ol><div class="memory-rules-note">같은 기기 또는 서버에 연결된 온라인 방에서 함께 플레이해요.<br>온라인에서는 자기 차례에만 카드를 공개하거나 다음 차례로 넘길 수 있고, 방장만 새 게임을 시작할 수 있어요.</div><button class="memory-btn memory-btn-primary memory-full-btn" type="button" data-action="close-modal">알겠어요!</button></section></div>

      <div class="memory-modal-layer" data-modal="result" hidden><section class="memory-dialog memory-result-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-result-title"><button type="button" class="memory-close" data-action="close-modal" aria-label="결과 닫기">×</button><div class="memory-result-medal" aria-hidden="true">✦</div><span class="memory-dialog-kicker">TRIP COMPLETE!</span><h2 id="memory-result-title">즐거운 여행 끝!</h2><p class="memory-dialog-lead">충북의 11가지 짝꿍을 모두 찾았어요.</p><div class="memory-winner"><span data-field="winner-label">축하해요, 우승자!</span><strong data-field="winners"></strong><small>모두 함께해서 더욱 즐거운 여행이었어요.</small></div><button class="memory-btn memory-btn-primary memory-full-btn" type="button" data-action="restart">새로운 여행 시작하기 ${arrowIcon}</button><p class="memory-result-permission" data-field="restart-help" hidden></p><p class="memory-result-message" data-field="result-online-message" role="status" aria-live="polite" hidden></p><button class="memory-result-close" type="button" data-action="close-modal">결과 닫기</button></section></div>
    `
    this.boardElement = this.get<HTMLElement>('[data-field="board"]')
    const options = { signal: this.listeners.signal }
    root.addEventListener('click', this.onClick, options)
    root.addEventListener('submit', this.onSubmit, options)
    root.addEventListener('keydown', this.onKeyDown, options)
    const invitedRoom = new URL(window.location.href).searchParams.get('room')
    if (invitedRoom !== null) {
      // Do not silently turn an invalid long invite into a different valid room code.
      this.get<HTMLInputElement>('[data-field="room-input"]').value = invitedRoom.trim().toUpperCase().slice(0, 64)
      this.setSetupMode('online')
    }
    this.updateOnlineUI()
    this.showModal('setup')
  }

  /** Reflect the real connection; the caller decides when a successful connection closes setup. */
  setOnline(view: OnlineView): void {
    this.online = { ...view, members: view.members.map(member => ({ ...member })) }
    if (view.status !== 'connecting') this.requestAction = null
    if (view.active) this.setSetupMode('online')
    if (view.status === 'playing' || view.status === 'finished') this.hasOnlineGame = true
    if (!view.active && view.status === 'offline') this.hasOnlineGame = false
    this.updateOnlineUI()
    // A connecting/lobby view must not expose the previous local game's scores as online data.
    if (this.lastState && this.isOnlineContext() && !this.hasOnlineGame) this.render(this.lastState)
    else this.updateGameControls()
  }

  /** Close only setup, including when the rules dialog is temporarily above it. */
  hideSetup(): void {
    if (this.modalUnderRules === 'setup') this.modalUnderRules = null
    if (this.activeModal === 'setup') this.showModal(null)
  }

  private isOnlineContext(): boolean {
    // An unexpected offline notification is still an online failure, not a local game.
    return this.online.active || this.online.status !== 'offline' || (this.setupMode === 'online' && !!this.online.message)
  }

  private setSetupMode(mode: SetupMode): void {
    this.setupMode = mode
    this.root.querySelectorAll<HTMLElement>('[data-setup-mode]').forEach(element => { element.hidden = element.dataset.setupMode !== mode })
    this.get<HTMLButtonElement>('[data-action="mode-local"]').setAttribute('aria-pressed', String(mode === 'local'))
    this.get<HTMLButtonElement>('[data-action="mode-online"]').setAttribute('aria-pressed', String(mode === 'online'))
    this.get('[data-field="setup-title"]').textContent = mode === 'local' ? '같은 기기에서 플레이' : '온라인으로 함께 플레이'
    this.get('[data-field="setup-lead"]').textContent = mode === 'local'
      ? '누구와 함께 충북으로 떠날까요? 여행자의 이름을 적고 시작해 주세요.'
      : '이름을 적고 방을 만들거나 친구의 방에 참가해 주세요.'
    this.get('[data-field="setup-foot"]').textContent = mode === 'local' ? '한 기기에서 함께 즐기는 게임' : '온라인 플레이에는 서버 연결이 필요해요'
    this.clearFormError()
  }

  private updateOnlineUI(): void {
    const { active, status, room, members, seat } = this.online
    const context = this.isOnlineContext()
    const message = this.online.message || onlineStatusMessages[status]
    const pending = status === 'connecting' || status === 'reconnecting'
    const alreadyConnected = active && (status === 'waiting' || status === 'playing' || status === 'finished')
    const formLocked = pending || alreadyConnected
    const focused = document.activeElement
    const focusedOnlineForm = focused instanceof HTMLElement && this.get('[data-form="online"]').contains(focused)

    this.get<HTMLElement>('[data-field="online-panel"]').hidden = !context
    const label = this.get<HTMLElement>('[data-field="connection-label"]')
    label.dataset.status = context ? status : 'local'
    this.get('[data-field="connection-text"]').textContent = context ? onlineStatusLabels[status] : '같은 기기 플레이'
    this.get('[data-field="play-note"]').textContent = context ? '온라인 방의 진행 상황은 서버와 동기화돼요.' : '같은 기기에서 함께 플레이해요'

    this.root.querySelectorAll<HTMLElement>('[data-online-context]').forEach(section => {
      section.dataset.status = status
      const find = <T extends HTMLElement = HTMLElement>(field: string): T => section.querySelector<T>(`[data-online-field="${field}"]`)!
      find('status').textContent = onlineStatusLabels[status]
      find('message').textContent = message
      find('room-section').hidden = !room
      find('room').textContent = room
      find('members-section').hidden = !room && members.length === 0
      find('member-count').textContent = `${members.length}명 / 최대 6명`
      const list = find<HTMLUListElement>('members')
      const items = members.map(member => {
        const li = document.createElement('li')
        li.dataset.memberId = String(member.id)
        const name = document.createElement('span')
        name.className = 'memory-online-member-name'
        name.textContent = `${member.name}${seat === member.id ? ' (나)' : ''}`
        const connection = document.createElement('span')
        connection.className = member.connected ? 'memory-member-connected' : 'memory-member-disconnected'
        connection.textContent = member.connected ? '접속 중' : '연결 끊김'
        li.append(name, connection)
        return li
      })
      list.replaceChildren(...items)
      const leave = section.querySelector<HTMLButtonElement>('[data-action="online-leave"]')!
      leave.hidden = !context
      const retry = section.querySelector<HTMLButtonElement>('[data-action="online-setup"]')!
      retry.hidden = section.dataset.onlineContext === 'setup' || !(status === 'error' || status === 'offline')
    })

    this.get<HTMLInputElement>('[data-field="online-name"]').disabled = formLocked
    this.get<HTMLInputElement>('[data-field="room-input"]').disabled = formLocked
    const create = this.get<HTMLButtonElement>('[data-action="online-create"]')
    const join = this.get<HTMLButtonElement>('[data-action="online-join"]')
    create.disabled = formLocked
    join.disabled = formLocked
    create.textContent = pending && this.requestAction === 'create' ? '연결 중…' : '방 만들기'
    join.textContent = pending && this.requestAction === 'join' ? '연결 중…' : '참가하기'
    if (this.activeModal === 'setup' && focusedOnlineForm && formLocked &&
      (focused instanceof HTMLButtonElement || focused instanceof HTMLInputElement) && focused.disabled) {
      this.get<HTMLButtonElement>('[data-action="mode-online"]').focus()
    }

    const blocker = this.get<HTMLElement>('[data-field="board-network"]')
    blocker.hidden = !context || (active && (status === 'playing' || status === 'finished'))
    this.get('[data-field="board-network-title"]').textContent = onlineStatusLabels[status]
    this.get('[data-field="board-network-message"]').textContent = message
  }

  render(state: MemoryState): void {
    this.lastState = state
    if (this.isOnlineContext() && !this.hasOnlineGame) {
      this.get('[data-field="found"]').textContent = '0'
      this.get('[data-field="remaining"]').textContent = '11쌍'
      this.get('[data-field="progress-bar"]').style.width = '0%'
      this.get('[role="progressbar"]').setAttribute('aria-valuenow', '0')
      this.get('[data-field="turn-name"]').textContent = '온라인 게임 대기 중'
      this.get('[data-field="turn-caption"]').textContent = '게임이 시작되면 차례가 보여요'
      this.get('[data-field="player-intro"]').textContent = '온라인 방의 참가자는 위에서 확인해요.'
      this.get('[data-field="players"]').innerHTML = '<div class="memory-empty-players">게임이 시작되면 점수가 보여요.</div>'
      this.playerMarkup = ''
      this.previewIds = []
      this.previewMarkup = ''
      this.get('[data-field="preview-cards"]').innerHTML = '<p class="memory-preview-empty">게임이 시작되면 공개된 카드를 볼 수 있어요.</p>'
      this.get('[data-field="preview-count"]').textContent = '0 / 2'
      this.get('[data-field="message"]').textContent = ''
      this.wasFinished = false
      this.updateGameControls()
      return
    }
    const found = Math.min(11, Math.max(0, state.claimed.length))
    this.get('[data-field="found"]').textContent = String(found)
    this.get('[data-field="remaining"]').textContent = `${11 - found}쌍`
    this.get('[data-field="progress-bar"]').style.width = `${found / 11 * 100}%`
    this.get('[role="progressbar"]').setAttribute('aria-valuenow', String(found))
    const current = state.players[state.turn]
    this.get('[data-field="turn-name"]').textContent = state.phase === 'finished' ? '여행 완료!' : current ? `${current.name}의 차례` : '게임을 시작해요'
    this.get('[data-field="turn-caption"]').textContent = state.phase === 'finished' ? '모든 짝을 찾았어요' : state.phase === 'resolving' ? '짝을 확인하고 있어요' : state.phase === 'turnEnd' ? '다음 차례를 기다려요' : '차례마다 두 장씩 공개해요'
    this.renderPreview(state)

    const playersMarkup = state.players.length ? state.players.map((player, index) => {
      const active = index === state.turn && state.phase !== 'finished'
      const name = escapeHtml(player.name)
      const score = Number.isFinite(player.score) ? player.score : 0
      const mascots = player.collected.map(id => {
        const region = regionsById.get(id)
        const asset = mascotAssets[`assets/mascots/${id}.webp`]
        if (!region || !asset) return ''
        const label = escapeHtml(`${region.region} ${region.product}`)
        return `<img src="${escapeHtml(asset.path)}" alt="${label}" title="${label}" width="30" height="30">`
      }).join('')
      const collection = mascots ? `<div class="memory-player-collection" role="group" aria-label="획득한 지역 캐릭터">${mascots}</div>` : ''
      return `<div role="listitem" class="memory-player ${active ? 'is-current' : ''}"${active ? ' aria-current="true"' : ''}><span class="memory-player-avatar memory-avatar-${index % 6}" aria-hidden="true">${index + 1}</span><span class="memory-player-name">${name}${active ? '<small>차례</small>' : ''}</span><span class="memory-player-score"><b>${score}</b> 쌍</span>${collection}</div>`
    }).join('') : '<div class="memory-empty-players">게임을 시작하면 여행자가 보여요.</div>'
    if (playersMarkup !== this.playerMarkup) {
      this.get('[data-field="players"]').innerHTML = playersMarkup
      this.playerMarkup = playersMarkup
    }
    this.get('[data-field="player-intro"]').textContent = state.phase === 'finished' ? '모두 함께 찾아낸 여행의 기록이에요.' : '현재 차례의 여행자가 찾은 짝을 획득해요.'
    const instruction = state.phase === 'finished'
      ? '모든 짝을 찾았어요! 즐거운 여행이었나요?'
      : state.phase === 'resolving'
        ? '짝을 확인하고 있어요. 잠시 기다려 주세요.'
        : state.phase === 'turnEnd'
          ? '다음 차례를 눌러 주세요.'
          : state.selectedIds.length === 0
            ? '뒤집힌 카드 두 장을 차례로 클릭해 공개해 주세요.'
            : '카드 한 장 더 클릭해 공개해 주세요. (1/2)'
    this.get('[data-field="instruction"]').textContent = instruction
    this.get('[data-field="message"]').textContent = state.lastMessage || '함께 충북 여행을 시작해 볼까요?'
    this.updateGameControls()

    const finished = state.phase === 'finished'
    if (!finished && this.wasFinished) {
      if (this.modalUnderRules === 'result') this.modalUnderRules = null
      if (this.activeModal === 'result') this.showModal(null)
    }
    if (finished) {
      const topScore = Math.max(...state.players.map(player => player.score))
      const winners = state.players.filter(player => player.score === topScore).map(player => player.name)
      this.updateResult(winners)
      if (!this.wasFinished) {
        this.modalUnderRules = null
        this.showModal('result')
      }
    }
    this.wasFinished = finished
  }

  private updateGameControls(): void {
    const state = this.lastState
    const context = this.isOnlineContext()
    const connected = this.online.active && (this.online.status === 'playing' || this.online.status === 'finished')
    const inRoom = connected || (this.online.active && this.online.status === 'waiting')
    const nextAllowed = !!state && state.phase === 'turnEnd' && (!context || (connected && this.online.status === 'playing' && this.online.canAct))
    const restartAllowed = !context || (connected && this.online.canRestart)
    const restartText = !inRoom ? '연결이 완료될 때까지 기다려 주세요.'
      : this.online.seat !== null && !this.online.isHost ? '방장만 새 게임을 시작할 수 있어요.'
        : this.online.members.filter(member => member.connected).length < 2 ? '새 게임에는 접속 중인 참가자 두 명 이상이 필요해요.'
          : !restartAllowed ? '서버 확인을 기다리고 있어요. 잠시만 기다려 주세요.'
            : '방장이 새 게임을 시작할 수 있어요.'
    const focusedRestart = document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.dataset.action === 'restart' && this.get('[data-modal="result"]').contains(document.activeElement)
    this.get<HTMLButtonElement>('[data-action="next"]').disabled = !nextAllowed
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="restart"]').forEach(button => {
      button.disabled = !restartAllowed
      button.title = context && !restartAllowed ? restartText : ''
    })
    if (!restartAllowed && focusedRestart && this.activeModal === 'result') {
      this.get<HTMLButtonElement>('[data-modal="result"] [data-action="close-modal"]').focus()
    }

    const permission = this.get<HTMLElement>('[data-field="online-permission"]')
    const restartHelp = this.get<HTMLElement>('[data-field="restart-help"]')
    const resultMessage = this.get<HTMLElement>('[data-field="result-online-message"]')
    permission.hidden = !context
    restartHelp.hidden = !context
    const onlineMessage = this.online.message || (!connected ? onlineStatusMessages[this.online.status] : '')
    resultMessage.hidden = !context || !onlineMessage
    resultMessage.textContent = context ? onlineMessage : ''
    if (!context) {
      if (state) this.get('[data-field="instruction"]').textContent = state.phase === 'finished' ? '모든 짝을 찾았어요! 즐거운 여행이었나요?'
        : state.phase === 'resolving' ? '짝을 확인하고 있어요. 잠시 기다려 주세요.'
          : state.phase === 'turnEnd' ? '다음 차례를 눌러 주세요.'
            : state.selectedIds.length === 0 ? '뒤집힌 카드 두 장을 차례로 클릭해 공개해 주세요.' : '카드 한 장 더 클릭해 공개해 주세요. (1/2)'
      return
    }

    const turnText = !connected ? '연결이 완료될 때까지 게임 조작을 기다려 주세요.'
      : this.online.status === 'finished' ? '게임이 끝났어요.'
        : this.online.canAct ? '내 차례예요. 차례가 끝나면 다음 차례를 넘길 수 있어요.'
          : '내 차례가 아니에요. 현재 차례의 여행자만 다음 차례를 넘길 수 있어요.'
    permission.textContent = `${turnText} ${restartText}`
    restartHelp.textContent = restartText
    if (!connected) this.get('[data-field="instruction"]').textContent = this.online.message || onlineStatusMessages[this.online.status]
    else if (this.online.status === 'playing' && !this.online.canAct) this.get('[data-field="instruction"]').textContent = '다른 여행자의 차례예요. 내 차례를 기다려 주세요.'
    else if (state && this.online.status === 'playing') {
      this.get('[data-field="instruction"]').textContent = state.phase === 'resolving' ? '짝을 확인하고 있어요. 잠시 기다려 주세요.'
        : state.phase === 'turnEnd' ? '다음 차례를 눌러 주세요.'
          : state.selectedIds.length === 0 ? '뒤집힌 카드 두 장을 차례로 클릭해 공개해 주세요.' : '카드 한 장 더 클릭해 공개해 주세요. (1/2)'
    }
  }

  private clearFormError(): void {
    const error = this.get<HTMLElement>('[data-field="online-form-error"]')
    error.textContent = ''
    error.hidden = true
  }

  private showFormError(message: string, input: HTMLInputElement): void {
    const error = this.get<HTMLElement>('[data-field="online-form-error"]')
    error.textContent = message
    error.hidden = false
    input.focus()
  }

  private requestOnline(action: 'create' | 'join'): void {
    if (this.get<HTMLButtonElement>(`[data-action="online-${action}"]`).disabled) return
    const nameInput = this.get<HTMLInputElement>('[data-field="online-name"]')
    const roomInput = this.get<HTMLInputElement>('[data-field="room-input"]')
    const name = nameInput.value.trim()
    const room = roomInput.value.trim().toUpperCase()
    if (!name) { this.showFormError('온라인에서 사용할 이름을 입력해 주세요.', nameInput); return }
    if (action === 'join' && !/^[A-Z]{6}$/.test(room)) {
      this.showFormError('방 코드는 영문 대문자 6자리로 입력해 주세요.', roomInput)
      return
    }
    nameInput.value = name
    roomInput.value = room
    this.clearFormError()
    this.requestAction = action
    this.hasOnlineGame = false
    this.setOnline({ ...offlineView(), active: true, status: 'connecting' })
    try {
      if (action === 'create') this.handlers.onOnlineCreate(name)
      else this.handlers.onOnlineJoin(room, name)
    } catch (error) {
      this.setOnline({ ...offlineView(), status: 'error', message: error instanceof Error ? error.message : onlineStatusMessages.error })
    }
  }

  private returnToLocal(): void {
    const wasOnline = this.isOnlineContext()
    this.setSetupMode('local')
    this.setOnline(offlineView())
    this.showModal('setup')
    if (wasOnline) this.handlers.onOnlineLeave()
  }

  private showCopyFeedback(message: string): void {
    this.root.querySelectorAll<HTMLElement>('[data-online-field="copy-feedback"]').forEach(element => { element.textContent = message })
  }

  private async copyRoom(): Promise<void> {
    const room = this.online.room
    if (!room) return
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(room)
      else {
        const input = document.createElement('textarea')
        input.value = room
        input.setAttribute('readonly', '')
        input.style.cssText = 'position:fixed;left:-9999px;top:0'
        const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        this.root.append(input)
        let copied = false
        try {
          input.select()
          copied = document.execCommand('copy')
        } finally {
          input.remove()
          focus?.focus()
        }
        if (!copied) throw new Error('copy failed')
      }
      if (this.online.room === room) this.showCopyFeedback('방 코드를 복사했어요.')
    } catch {
      this.showCopyFeedback('코드를 복사하지 못했어요. 표시된 방 코드를 직접 입력해 주세요.')
    }
  }

  private renderPreview(state: MemoryState): void {
    if (state.phase === 'flip' || state.phase === 'resolving') {
      // Never derive the preview from all revealed cards: older claimed pairs stay face up.
      this.previewIds = state.selectedIds.slice(0, 2)
    } else {
      const [first, second] = this.previewIds.map(id => state.cards.find(card => card.id === id))
      const matched = this.previewIds.length === 2 && first && second && first.id !== second.id &&
        first.revealed && second.revealed && first.regionId === second.regionId &&
        first.kind !== second.kind && state.claimed.includes(first.regionId)
      if (!matched) this.previewIds = []
    }

    const cards = this.previewIds.flatMap(id => {
      const card = state.cards.find(candidate => candidate.id === id)
      const region = card && regionsById.get(card.regionId)
      // A card that is no longer actually face up must not leave its image or name in the DOM.
      if (!card?.revealed || !region) return []
      const isPlace = card.kind === 'place'
      const kind = isPlace ? '관광지' : '특산물'
      const name = isPlace ? region.place : region.product
      const url = getTextureUrl(`assets/cards-hd/${isPlace ? 'p' : 's'}${region.id}.webp`)
      const label = `${region.region} ${kind} ${name} 카드`
      return [`<figure class="memory-preview-card"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" width="684" height="1037" decoding="async"><figcaption><span>${escapeHtml(region.region)} · ${kind}</span><b>${escapeHtml(name)}</b></figcaption></figure>`]
    })
    const markup = cards.length ? cards.join('') : '<p class="memory-preview-empty">아직 공개된 카드가 없어요.<br>보드에서 카드를 선택해 주세요.</p>'
    if (markup !== this.previewMarkup) {
      this.get('[data-field="preview-cards"]').innerHTML = markup
      this.previewMarkup = markup
    }
    this.get('[data-field="preview-count"]').textContent = `${cards.length} / 2`
  }

  private updateResult(winners: string[]): void {
    this.get('[data-field="winner-label"]').textContent = winners.length > 1 ? '축하해요, 공동 우승!' : '축하해요, 우승자!'
    this.get('[data-field="winners"]').textContent = winners.length ? winners.join(' · ') : '모두 수고했어요!'
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
      const focusTarget = layer.querySelector<HTMLElement>(name === 'setup' ? `[data-setup-mode="${this.setupMode}"] input:not([disabled])` : 'button:not([disabled])') ?? layer.querySelector<HTMLElement>('button:not([disabled])')
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
    if (target instanceof HTMLButtonElement && target.disabled) return
    if (target.dataset.count) {
      this.updateCount(Number(target.dataset.count))
      return
    }
    switch (target.dataset.action) {
      case 'mode-local':
        if (this.isOnlineContext()) this.returnToLocal()
        else this.setSetupMode('local')
        break
      case 'mode-online': this.setSetupMode('online'); break
      case 'online-create': this.requestOnline('create'); break
      case 'online-setup': this.setSetupMode('online'); this.showModal('setup'); break
      case 'online-leave': this.returnToLocal(); break
      case 'copy-room': void this.copyRoom(); break
      case 'copy-invite':
        if (!this.online.room) break
        try {
          this.handlers.onCopyInvite()
          this.showCopyFeedback('초대 링크 복사를 요청했어요. 복사되지 않았다면 브라우저 권한을 확인해 주세요.')
        } catch {
          this.showCopyFeedback('초대 링크를 복사하지 못했어요. 브라우저 권한을 확인해 주세요.')
        }
        break
      case 'rules':
        this.modalUnderRules = this.activeModal
        this.showModal('rules')
        break
      case 'close-modal': this.closeModal(); break
      case 'next': this.handlers.onNextTurn(); break
      case 'zoom-in': this.handlers.onZoom('in'); break
      case 'zoom-out': this.handlers.onZoom('out'); break
      case 'zoom-reset': this.handlers.onZoom('reset'); break
      case 'restart':
        if (this.isOnlineContext()) {
          this.handlers.onRestart()
        } else {
          this.handlers.onRestart()
          this.modalUnderRules = null
          this.showModal('setup')
        }
        break
    }
  }

  private readonly onSubmit = (event: Event): void => {
    if (!(event.target instanceof HTMLFormElement)) return
    if (event.target.dataset.form === 'online') {
      event.preventDefault()
      if (this.setupMode === 'online') this.requestOnline('join')
      return
    }
    if (event.target.dataset.form !== 'setup') return
    event.preventDefault()
    if (this.setupMode !== 'local' || this.isOnlineContext()) return
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
