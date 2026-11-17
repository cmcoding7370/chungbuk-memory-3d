import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { getModelUrl } from './modelUrls'
import { getTextureUrl } from './textureUrls'

/** The game owns card state. This class only displays it and reports card clicks. */
export interface VisualCard {
  id: string
  regionId: number
  kind: 'place' | 'product'
  revealed: boolean
}

type CardObject = {
  root: THREE.Group
  pivot: THREE.Group
  hit: THREE.Mesh
  highlight: THREE.Mesh
  targetAngle: number
}

type RegionMarker = {
  root: THREE.Group
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>
  piece: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  model: THREE.Group | null
  mixer: THREE.AnimationMixer | null
  claimed: boolean
  exitProgress: number
}

const CARD_WIDTH = 1.2
const CARD_HEIGHT = CARD_WIDTH * 248 / 163
const CARD_DEPTH = 0.1
const BOARD_WIDTH = 7.75
const BOARD_LENGTH = 11.6
const RESTING_CARD_Y = 0.14
const DEFAULT_VIEW = new THREE.Vector3(0, 22, 13)
const DESKTOP_MAX_PIXEL_RATIO = 2.5
const TOUCH_MAX_PIXEL_RATIO = 2
const DESKTOP_PIXEL_BUDGET = 8_500_000
const TOUCH_PIXEL_BUDGET = 4_000_000
// Normalized positions of the matching regional characters in the supplied map artwork.
// Order: 청주, 충주, 단양, 제천, 음성, 괴산, 진천, 증평, 보은, 옥천, 영동.
const MARKER_UV: ReadonlyArray<readonly [number, number]> = [
  [0.114, 0.666], [0.271, 0.255], [0.911, 0.258], [0.583, 0.258],
  [0.245, 0.422], [0.563, 0.566], [0.620, 0.429], [0.913, 0.466],
  [0.459, 0.728], [0.755, 0.804], [0.917, 0.719],
]

/** Rounded card geometry is in the local XY plane, with its depth along Z. */
function roundedRectangle(width: number, height: number, radius: number): THREE.Shape {
  const x = -width / 2
  const y = -height / 2
  const r = Math.min(radius, width / 2, height / 2)
  const shape = new THREE.Shape()
  shape.moveTo(x + r, y)
  shape.lineTo(x + width - r, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + r)
  shape.lineTo(x + width, y + height - r)
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  shape.lineTo(x + r, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - r)
  shape.lineTo(x, y + r)
  shape.quadraticCurveTo(x, y, x + r, y)
  return shape
}

/** Give ShapeGeometry normalized image UVs instead of its default world-space UVs. */
function cardFaceGeometry(width: number, height: number): THREE.ShapeGeometry {
  const geometry = new THREE.ShapeGeometry(roundedRectangle(width, height, 0.085), 8)
  const positions = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < positions.count; i += 1) {
    uv.setXY(i, positions.getX(i) / width + 0.5, positions.getY(i) / height + 0.5)
  }
  uv.needsUpdate = true
  return geometry
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Avoid excessive fill rate on large or high-density displays without blurring small canvases. */
function renderPixelRatio(width: number, height: number): number {
  const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const limit = touch ? TOUCH_MAX_PIXEL_RATIO : DESKTOP_MAX_PIXEL_RATIO
  const budget = touch ? TOUCH_PIXEL_BUDGET : DESKTOP_PIXEL_BUDGET
  const deviceRatio = window.devicePixelRatio || 1
  return Math.min(deviceRatio, limit, Math.sqrt(budget / (width * height)))
}

/** Fit the card wings and their raised flip animation, retaining perspective and breathing room. */
function defaultFitDistance(aspect: number, fov: number): number {
  const direction = DEFAULT_VIEW.clone().normalize()
  const tangent = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const frame = 0.88
  const halfWidth = 6.11 + (CARD_WIDTH + 0.16) / 2
  const halfLength = 5 + (CARD_HEIGHT + 0.16) / 2
  let distance = 0
  // Perspective makes the near edge larger. Test all vertical/depth corners, including raised cards.
  for (const y of [0, 1.5]) {
    for (const z of [-halfLength, halfLength]) {
      const towardsCamera = y * direction.y + z * direction.z
      const vertical = y * direction.z - z * direction.y
      distance = Math.max(distance,
        towardsCamera + halfWidth / (tangent * aspect * frame),
        towardsCamera + Math.abs(vertical) / (tangent * frame))
    }
  }
  return distance
}

/**
 * A self-contained, perspective 3D board. Asset paths are absolute so they work from any route.
 * Cards use p0..p10 / s0..s10 IDs when supplied; other IDs use kind and regionId instead.
 */
export class MemoryBoard {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 250)
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly loader = new THREE.TextureLoader()
  private readonly modelLoader = new GLTFLoader()
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly cards = new Map<string, CardObject>()
  private readonly markers: RegionMarker[] = []
  private readonly geometries = new Set<THREE.BufferGeometry>()
  private readonly materials = new Set<THREE.Material>()
  private readonly textures = new Set<THREE.Texture>()
  private readonly skeletons = new Set<THREE.Skeleton>()
  private readonly faceMaterials = new Map<string, THREE.MeshBasicMaterial>()
  private readonly bodyGeometry: THREE.ExtrudeGeometry
  private readonly faceGeometry: THREE.ShapeGeometry
  private readonly bodyMaterial: THREE.MeshStandardMaterial
  private readonly backMaterial: THREE.MeshBasicMaterial
  private readonly highlightGeometry: THREE.ShapeGeometry
  private readonly highlightMaterial: THREE.MeshBasicMaterial
  private readonly resizeObserver: ResizeObserver | null
  private frame = 0
  private lastFrame = 0
  private fitDistance = 0
  private mapWidth = BOARD_WIDTH - 0.65
  private mapHeight = BOARD_LENGTH - 0.65
  private disposed = false
  private needsRender = true
  private nextModelIndex = 0
  private activePointers = new Map<number, { x: number; y: number; moved: boolean }>()
  private gestureHadMultiplePointers = false

  constructor(
    private readonly container: HTMLElement,
    private readonly onCardClick: (id: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.16
    this.renderer.shadowMap.enabled = true
    // Current Three.js already falls back from the removed PCFSoft mode to PCF.
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.touchAction = 'none'
    this.renderer.domElement.setAttribute('aria-label', '충북 지도와 카드가 놓인 3D 게임 보드')
    this.container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color('#dfc6a0')
    this.camera.position.copy(DEFAULT_VIEW)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.085
    this.controls.enablePan = true
    this.controls.minDistance = 6
    this.controls.maxDistance = 150
    this.controls.minPolarAngle = 0.12
    this.controls.maxPolarAngle = Math.PI / 2 - 0.08
    this.controls.rotateSpeed = 0.65
    this.controls.zoomSpeed = 0.9
    this.controls.touches.ONE = THREE.TOUCH.ROTATE
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN
    this.controls.addEventListener('change', this.markDirty)
    this.controls.update()

    this.bodyGeometry = this.keepGeometry(new THREE.ExtrudeGeometry(
      roundedRectangle(CARD_WIDTH - 0.04, CARD_HEIGHT - 0.04, 0.085),
      { depth: CARD_DEPTH, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 3, curveSegments: 8 },
    ))
    this.bodyGeometry.translate(0, 0, -CARD_DEPTH / 2)
    this.faceGeometry = this.keepGeometry(cardFaceGeometry(CARD_WIDTH - 0.06, CARD_HEIGHT - 0.06))
    this.bodyMaterial = this.keepMaterial(new THREE.MeshStandardMaterial({ color: '#ead5ad', roughness: 0.76 }))
    // Printed artwork is unlit and bypasses scene tone mapping; the card body remains 3D and lit.
    this.backMaterial = this.keepMaterial(new THREE.MeshBasicMaterial({
      map: this.makeBackFallback(), color: '#ffffff', toneMapped: false,
    }))
    this.loadIntoMaterial(getTextureUrl('assets/cards-hd/back.webp'), this.backMaterial)

    const highlightShape = roundedRectangle(CARD_WIDTH + 0.16, CARD_HEIGHT + 0.16, 0.13)
    const hole = roundedRectangle(CARD_WIDTH + 0.055, CARD_HEIGHT + 0.055, 0.105)
    highlightShape.holes.push(hole)
    this.highlightGeometry = this.keepGeometry(new THREE.ShapeGeometry(highlightShape, 8))
    this.highlightMaterial = this.keepMaterial(new THREE.MeshBasicMaterial({
      color: '#ffd36b', transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide,
    }))

    this.createEnvironment()
    this.createMapBoard()
    this.createMarkers()

    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.handlePointerDown)
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerup', this.handlePointerUp)
    canvas.addEventListener('pointercancel', this.handlePointerCancel)
    window.addEventListener('resize', this.resize)
    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.resize)
    this.resizeObserver?.observe(container)
    this.resize()
    this.frame = requestAnimationFrame(this.animate)
    // Two independent workers keep download/decode concurrency bounded without blocking UI.
    void this.loadNextModel()
    void this.loadNextModel()
  }

  /**
   * Input order determines the shuffled slot order. Claimed regions stay face-up; selected IDs
   * receive a gold outline. Calling this repeatedly does not recreate unchanged card objects.
   */
  setCards(cards: VisualCard[], claimed: number[], selectedIds: string[]): void {
    if (this.disposed) return
    this.needsRender = true
    const claimedSet = new Set(claimed)
    const selectedSet = new Set(selectedIds)
    const ids = new Set(cards.map((card) => card.id))
    for (const [id, object] of this.cards) {
      if (!ids.has(id)) {
        this.scene.remove(object.root)
        this.cards.delete(id)
      }
    }

    const regionIds = [...new Set(cards.map((card) => card.regionId))].sort((a, b) => a - b)
    const oneBased = regionIds.length === 11 && regionIds[0] === 1 && regionIds[10] === 11
    cards.slice(0, 22).forEach((card, index) => {
      let object = this.cards.get(card.id)
      if (!object) {
        object = this.createCard(card, oneBased)
        this.cards.set(card.id, object)
        this.scene.add(object.root)
        object.pivot.rotation.y = card.revealed || claimedSet.has(card.regionId) ? Math.PI : 0
      }
      // Eleven cards on each side, arranged in two columns, in supplied shuffle order.
      const side = index < 11 ? -1 : 1
      const slot = index % 11
      const column = slot % 2
      const row = Math.floor(slot / 2)
      object.root.position.set(side * (4.75 + column * 1.36), RESTING_CARD_Y, -5 + row * 2)
      object.targetAngle = card.revealed || claimedSet.has(card.regionId) ? Math.PI : 0
      object.highlight.visible = selectedSet.has(card.id)
    })

    // Stable, named marker sockets can later be replaced with the project's actual 3D models.
    this.markers.forEach((marker, index) => {
      const regionId = regionIds.length === 11 ? regionIds[index] : index
      marker.root.name = `region-marker-${regionId}`
      marker.root.userData.regionId = regionId
      const isClaimed = claimedSet.has(regionId)
      marker.claimed = isClaimed
      marker.piece.visible = !marker.model && !isClaimed
      marker.ring.material.color.set(isClaimed ? '#e9b955' : '#b7a783')
      marker.ring.material.emissive.set(isClaimed ? '#7c4d0e' : '#000000')
      marker.ring.material.emissiveIntensity = isClaimed ? 0.28 : 0
      marker.piece.material.color.set(isClaimed ? '#66965f' : '#dbd1bb')
    })
  }

  /** Zoom in or out without changing the 3D board or the selected cards. */
  zoom(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target)
    offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance))
    this.camera.position.copy(this.controls.target).add(offset)
    this.controls.update()
    this.needsRender = true
  }

  resetView(): void {
    this.controls.target.set(0, 0, 0)
    this.camera.position.copy(DEFAULT_VIEW)
    this.fitDistance = 0
    this.resize()
    this.needsRender = true
  }

  /** Screen coordinate of a card, used by the development-only interaction checks. */
  cardScreenPoint(id: string): { x: number; y: number } | null {
    const card = this.cards.get(id)
    if (!card) return null
    this.scene.updateMatrixWorld(true)
    this.camera.updateMatrixWorld()
    const point = card.root.getWorldPosition(new THREE.Vector3()).project(this.camera)
    const bounds = this.renderer.domElement.getBoundingClientRect()
    return { x: bounds.left + (point.x + 1) * bounds.width / 2, y: bounds.top + (1 - point.y) * bounds.height / 2 }
  }

  /** Release the render loop, events, controls, GPU resources, and owned canvas. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
    window.removeEventListener('resize', this.resize)
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.handlePointerDown)
    canvas.removeEventListener('pointermove', this.handlePointerMove)
    canvas.removeEventListener('pointerup', this.handlePointerUp)
    canvas.removeEventListener('pointercancel', this.handlePointerCancel)
    this.controls.removeEventListener('change', this.markDirty)
    this.controls.dispose()
    this.markers.forEach((marker) => {
      marker.mixer?.stopAllAction()
      if (marker.model) marker.mixer?.uncacheRoot(marker.model)
    })
    this.skeletons.forEach((skeleton) => skeleton.dispose())
    this.geometries.forEach((geometry) => geometry.dispose())
    this.materials.forEach((material) => material.dispose())
    this.disposeTextures(this.textures)
    this.renderer.dispose()
    this.cards.clear()
    this.activePointers.clear()
    canvas.remove()
  }

  private keepGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry)
    return geometry
  }

  private keepMaterial<T extends THREE.Material>(material: T): T {
    this.materials.add(material)
    return material
  }

  private keepTexture<T extends THREE.Texture>(texture: T): T {
    texture.colorSpace = THREE.SRGBColorSpace
    // Trilinear mipmaps prevent minification shimmer; anisotropy retains detail at oblique angles.
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.generateMipmaps = true
    texture.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 8)
    this.textures.add(texture)
    return texture
  }

  private canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
    return this.keepTexture(new THREE.CanvasTexture(canvas))
  }

  private loadIntoMaterial(url: string, material: THREE.MeshBasicMaterial, onLoad?: (texture: THREE.Texture) => void): void {
    const texture = this.loader.load(url, (loaded) => {
      if (this.disposed) {
        loaded.dispose()
        return
      }
      material.map = loaded
      material.needsUpdate = true
      onLoad?.(loaded)
      this.needsRender = true
    }, undefined, () => {
      // A neutral, clearly labelled fallback stays visible until the provided assets exist.
    })
    this.keepTexture(texture)
  }

  private makeBackFallback(): THREE.CanvasTexture {
    const canvas = makeCanvas(326, 496)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#486652'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#d6bf88'
    ctx.lineWidth = 7
    ctx.strokeRect(18, 18, 290, 460)
    ctx.lineWidth = 2
    ctx.strokeRect(29, 29, 268, 438)
    ctx.fillStyle = '#e9d8ad'
    ctx.beginPath()
    ctx.arc(163, 229, 78, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#486652'
    ctx.font = 'bold 43px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('충북', 163, 245)
    ctx.fillStyle = '#e9d8ad'
    ctx.font = '24px sans-serif'
    ctx.fillText('동네 한바퀴', 163, 350)
    return this.canvasTexture(canvas)
  }

  private makeFaceFallback(card: VisualCard): THREE.CanvasTexture {
    const canvas = makeCanvas(326, 496)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#f5ead4'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#b29b73'
    ctx.lineWidth = 5
    ctx.strokeRect(16, 16, 294, 464)
    ctx.fillStyle = card.kind === 'place' ? '#90ab8b' : '#c88967'
    ctx.fillRect(35, 35, 256, 270)
    ctx.fillStyle = '#fff9ea'
    ctx.textAlign = 'center'
    ctx.font = 'bold 62px sans-serif'
    ctx.fillText(String(card.regionId + 1), 163, 194)
    ctx.fillStyle = '#5d5141'
    ctx.font = 'bold 29px sans-serif'
    ctx.fillText(card.kind === 'place' ? '장소' : '특산물', 163, 366)
    ctx.font = '20px sans-serif'
    ctx.fillText('이미지 준비 중', 163, 410)
    return this.canvasTexture(canvas)
  }

  private makeWoodTexture(): THREE.CanvasTexture {
    const canvas = makeCanvas(1024, 1024)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#c89661'
    ctx.fillRect(0, 0, 1024, 1024)
    // Deterministic, subtle plank seams and curved wood grain; no image assets needed.
    let seed = 721
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }
    for (let y = 0; y < 1024; y += 205) {
      ctx.fillStyle = 'rgba(83,46,24,0.16)'
      ctx.fillRect(0, y, 1024, 3)
      ctx.fillStyle = 'rgba(255,230,182,0.13)'
      ctx.fillRect(0, y + 4, 1024, 2)
    }
    for (let i = 0; i < 185; i += 1) {
      const y = random() * 1024
      ctx.strokeStyle = i % 3 === 0 ? 'rgba(255,226,180,0.12)' : 'rgba(104,58,32,0.10)'
      ctx.lineWidth = 0.5 + random() * 2
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.bezierCurveTo(260, y + random() * 20 - 10, 700, y + random() * 24 - 12, 1024, y + random() * 8 - 4)
      ctx.stroke()
    }
    const texture = this.canvasTexture(canvas)
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(4, 4)
    return texture
  }

  private createEnvironment(): void {
    const ambient = new THREE.HemisphereLight('#fff8e8', '#aa8163', 2.1)
    this.scene.add(ambient)
    const sun = new THREE.DirectionalLight('#fff1d5', 3.1)
    sun.position.set(-9, 18, 10)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -15
    sun.shadow.camera.right = 15
    sun.shadow.camera.top = 15
    sun.shadow.camera.bottom = -15
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 45
    sun.shadow.normalBias = 0.025
    sun.shadow.bias = -0.0003
    this.scene.add(sun)
    const fill = new THREE.DirectionalLight('#fffdf5', 0.7)
    fill.position.set(8, 10, -8)
    this.scene.add(fill)

    const tabletop = new THREE.Mesh(
      this.keepGeometry(new THREE.PlaneGeometry(100, 100)),
      this.keepMaterial(new THREE.MeshStandardMaterial({ map: this.makeWoodTexture(), roughness: 0.9 })),
    )
    tabletop.rotation.x = -Math.PI / 2
    tabletop.receiveShadow = true
    this.scene.add(tabletop)
  }

  private createMapBoard(): void {
    const board = new THREE.Mesh(
      this.keepGeometry(new THREE.BoxGeometry(BOARD_WIDTH, 0.28, BOARD_LENGTH)),
      this.keepMaterial(new THREE.MeshStandardMaterial({ color: '#845e40', roughness: 0.72 })),
    )
    board.position.y = 0.14
    board.castShadow = true
    board.receiveShadow = true
    this.scene.add(board)
    const mat = new THREE.Mesh(
      this.keepGeometry(new THREE.PlaneGeometry(BOARD_WIDTH - 0.22, BOARD_LENGTH - 0.22)),
      this.keepMaterial(new THREE.MeshStandardMaterial({ color: '#f1e6cf', roughness: 0.95 })),
    )
    mat.rotation.x = -Math.PI / 2
    mat.position.y = 0.285
    mat.receiveShadow = true
    this.scene.add(mat)

    const canvas = makeCanvas(740, 1050)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#f5eddd'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#caba9e'
    ctx.lineWidth = 5
    ctx.strokeRect(30, 30, 680, 990)
    ctx.fillStyle = '#718b73'
    ctx.textAlign = 'center'
    ctx.font = 'bold 48px sans-serif'
    ctx.fillText('충북 동네 한바퀴', 370, 470)
    ctx.fillStyle = '#958775'
    ctx.font = '28px sans-serif'
    ctx.fillText('지도 이미지를 준비하고 있어요', 370, 535)
    // Keep the supplied map colors independent of warm lights and ACES; surrounding objects stay lit.
    const material = this.keepMaterial(new THREE.MeshBasicMaterial({ map: this.canvasTexture(canvas), toneMapped: false }))
    const map = new THREE.Mesh(this.keepGeometry(new THREE.PlaneGeometry(1, 1)), material)
    map.name = 'chungbuk-map'
    map.rotation.x = -Math.PI / 2
    map.position.y = 0.294
    map.scale.set(BOARD_WIDTH - 0.65, BOARD_LENGTH - 0.65, 1)
    this.scene.add(map)
    this.loadIntoMaterial(getTextureUrl('assets/chungbuk-map-hd.webp'), material, (texture) => {
      const image = texture.image as { width?: number; height?: number } | undefined
      if (!image?.width || !image.height) return
      const aspect = image.width / image.height
      const maxWidth = BOARD_WIDTH - 0.65
      const maxHeight = BOARD_LENGTH - 0.65
      const width = Math.min(maxWidth, maxHeight * aspect)
      map.scale.set(width, width / aspect, 1)
      this.mapWidth = width
      this.mapHeight = width / aspect
      this.positionMarkers()
    })
  }

  private createMarkers(): void {
    const pedestalGeometry = this.keepGeometry(new THREE.CylinderGeometry(0.25, 0.3, 0.09, 24))
    const ringGeometry = this.keepGeometry(new THREE.TorusGeometry(0.215, 0.028, 8, 24))
    const pieceGeometry = this.keepGeometry(new THREE.SphereGeometry(0.115, 16, 12))
    const pedestalMaterial = this.keepMaterial(new THREE.MeshStandardMaterial({ color: '#735138', roughness: 0.7 }))
    for (let i = 0; i < 11; i += 1) {
      const root = new THREE.Group()
      root.name = `region-marker-${i}`
      root.userData.regionId = i
      const pedestal = new THREE.Mesh(pedestalGeometry, pedestalMaterial)
      pedestal.position.y = 0.045
      pedestal.castShadow = true
      const ring = new THREE.Mesh(ringGeometry, this.keepMaterial(new THREE.MeshStandardMaterial({ color: '#b7a783', metalness: 0.6, roughness: 0.38 })))
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.10
      const piece = new THREE.Mesh(pieceGeometry, this.keepMaterial(new THREE.MeshStandardMaterial({ color: '#dbd1bb', roughness: 0.55 })))
      piece.position.y = 0.22
      piece.castShadow = true
      const number = makeCanvas(128, 128)
      const ctx = number.getContext('2d')!
      ctx.fillStyle = '#fff6df'
      ctx.beginPath()
      ctx.arc(64, 64, 53, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#5d4932'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = 'bold 60px sans-serif'
      ctx.fillText(String(i + 1), 64, 66)
      const badge = new THREE.Mesh(
        this.keepGeometry(new THREE.PlaneGeometry(0.25, 0.25)),
        this.keepMaterial(new THREE.MeshBasicMaterial({ map: this.canvasTexture(number), transparent: true, depthWrite: false })),
      )
      badge.rotation.x = -Math.PI / 2
      badge.position.set(0, 0.102, 0.16)
      root.add(pedestal, ring, piece, badge)
      this.scene.add(root)
      this.markers.push({ root, ring, piece, model: null, mixer: null, claimed: false, exitProgress: 0 })
    }
    this.positionMarkers()
  }

  private positionMarkers(): void {
    this.markers.forEach((marker, index) => {
      const [u, v] = MARKER_UV[index]
      marker.root.position.set((u - 0.5) * this.mapWidth, 0.31, (v - 0.5) * this.mapHeight)
    })
  }

  /** Load actual user-provided models, not generated replacements. Failures retain the marker. */
  private async loadNextModel(): Promise<void> {
    if (this.disposed) return
    const index = this.nextModelIndex++
    if (index >= this.markers.length) return
    const marker = this.markers[index]
    try {
      const gltf = await this.modelLoader.loadAsync(getModelUrl(index))
      if (this.disposed) {
        this.trackModelResources(gltf.scene, true)
        return
      }
      this.trackModelResources(gltf.scene, false)
      gltf.scene.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new THREE.Vector3())
      if (box.isEmpty() || !Number.isFinite(size.length()) || size.length() < 0.000001) {
        throw new Error('모델의 크기를 계산할 수 없습니다.')
      }
      const center = box.getCenter(new THREE.Vector3())
      const content = new THREE.Group()
      content.add(gltf.scene)
      content.position.set(-center.x, -box.min.y, -center.z)
      const model = new THREE.Group()
      model.name = `region-model-${index}`
      model.userData.regionId = index
      model.add(content)
      const scale = Math.min(0.63 / Math.max(size.x, 0.000001), 0.75 / Math.max(size.y, 0.000001), 0.63 / Math.max(size.z, 0.000001))
      model.scale.setScalar(scale)
      model.position.y = 0.11
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          // User models have hundreds of thousands of triangles each; the small pedestal casts
          // the shadow instead, avoiding a second full geometry pass on mobile GPUs.
          child.castShadow = false
          child.receiveShadow = true
        }
      })
      marker.root.add(model)
      marker.model = model
      marker.piece.visible = false
      marker.exitProgress = marker.claimed ? 1 : 0
      model.visible = !marker.claimed
      if (gltf.animations.length) {
        marker.mixer = new THREE.AnimationMixer(model)
        marker.mixer.clipAction(gltf.animations[0]).play()
      }
      // Preserve the normalized size while the exit animation scales the wrapper.
      model.userData.baseScale = scale
      this.needsRender = true
    } catch (error) {
      if (!this.disposed) console.warn(`지역 ${index + 1} 3D 모델을 불러오지 못해 임시 마커를 표시합니다.`, error)
    }
    if (!this.disposed) window.setTimeout(() => { void this.loadNextModel() }, 0)
  }

  /** GLTF owns additional resources that are not shared with the board primitives. */
  private trackModelResources(root: THREE.Object3D, disposeNow: boolean): void {
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    const skeletons = new Set<THREE.Skeleton>()
    root.traverse((child) => {
      if (child instanceof THREE.SkinnedMesh) skeletons.add(child.skeleton)
      if (!(child instanceof THREE.Mesh)) return
      geometries.add(child.geometry)
      const list = Array.isArray(child.material) ? child.material : [child.material]
      list.forEach((material) => {
        materials.add(material)
        Object.values(material).forEach((value: unknown) => {
          if (value instanceof THREE.Texture) textures.add(value)
        })
      })
    })
    if (disposeNow) {
      skeletons.forEach((skeleton) => skeleton.dispose())
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((material) => material.dispose())
      this.disposeTextures(textures)
    } else {
      skeletons.forEach((skeleton) => this.skeletons.add(skeleton))
      geometries.forEach((geometry) => this.geometries.add(geometry))
      materials.forEach((material) => this.materials.add(material))
      textures.forEach((texture) => this.textures.add(texture))
    }
  }

  private disposeTextures(textures: Set<THREE.Texture>): void {
    const bitmaps = new Set<ImageBitmap>()
    textures.forEach((texture) => {
      texture.dispose()
      const data: unknown = texture.source.data
      if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) bitmaps.add(data)
    })
    bitmaps.forEach((bitmap) => bitmap.close())
  }

  private createCard(card: VisualCard, oneBased: boolean): CardObject {
    const root = new THREE.Group()
    root.name = `card-${card.id}`
    root.rotation.x = -Math.PI / 2
    const pivot = new THREE.Group()
    root.add(pivot)
    const body = new THREE.Mesh(this.bodyGeometry, this.bodyMaterial)
    body.userData.cardId = card.id
    body.castShadow = true
    body.receiveShadow = true
    pivot.add(body)
    const back = new THREE.Mesh(this.faceGeometry, this.backMaterial)
    // The bevel reaches 0.02 beyond the body: keep a visible depth-buffer safety gap.
    back.position.z = CARD_DEPTH / 2 + 0.03
    pivot.add(back)

    const face = new THREE.Mesh(this.faceGeometry, this.getFaceMaterial(card, oneBased))
    face.rotation.y = Math.PI
    face.position.z = -(CARD_DEPTH / 2 + 0.03)
    pivot.add(face)
    const highlight = new THREE.Mesh(this.highlightGeometry, this.highlightMaterial)
    highlight.position.z = -0.10
    highlight.visible = false
    root.add(highlight)
    return { root, pivot, hit: body, highlight, targetAngle: 0 }
  }

  private getFaceMaterial(card: VisualCard, oneBased: boolean): THREE.MeshBasicMaterial {
    const explicit = /^(p|s)(10|[0-9])$/i.exec(card.id)
    const prefix = explicit ? explicit[1].toLowerCase() : card.kind === 'place' ? 'p' : 's'
    const index = explicit ? Number(explicit[2]) : card.regionId - (oneBased ? 1 : 0)
    const key = `${prefix}${index}`
    const existing = this.faceMaterials.get(key)
    if (existing) return existing
    const material = this.keepMaterial(new THREE.MeshBasicMaterial({ map: this.makeFaceFallback(card), toneMapped: false }))
    this.faceMaterials.set(key, material)
    if (Number.isInteger(index) && index >= 0 && index <= 10) this.loadIntoMaterial(getTextureUrl(`assets/cards-hd/${key}.webp`), material)
    return material
  }

  private resize = (): void => {
    if (this.disposed) return
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    const aspect = width / height
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
    const pixelRatio = renderPixelRatio(width, height)
    if (this.renderer.getPixelRatio() !== pixelRatio) this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(width, height, false)
    // Fit both card wings even in portrait. Preserve the user's relative zoom on later resizes.
    const newFitDistance = defaultFitDistance(aspect, this.camera.fov)
    const offset = this.camera.position.clone().sub(this.controls.target)
    const distance = this.fitDistance ? offset.length() * newFitDistance / this.fitDistance : newFitDistance
    offset.setLength(THREE.MathUtils.clamp(distance, this.controls.minDistance, this.controls.maxDistance))
    this.camera.position.copy(this.controls.target).add(offset)
    this.fitDistance = newFitDistance
    this.needsRender = true
    this.controls.update()
  }

  private markDirty = (): void => { this.needsRender = true }

  private animate = (time: number): void => {
    if (this.disposed) return
    // Allow slow devices to advance transitions in real time even with heavy user models.
    const dt = this.lastFrame ? Math.min((time - this.lastFrame) / 1000, 0.5) : 0
    this.lastFrame = time
    for (const card of this.cards.values()) {
      const angle = card.pivot.rotation.y
      const next = angle + (card.targetAngle - angle) * (1 - Math.exp(-10 * dt))
      card.pivot.rotation.y = Math.abs(card.targetAngle - next) < 0.002 ? card.targetAngle : next
      if (card.pivot.rotation.y !== angle) this.needsRender = true
      // Lift while turning so a thick card never clips into the tabletop.
      card.root.position.y = RESTING_CARD_Y + Math.sin(card.pivot.rotation.y) * 0.66
    }
    for (const marker of this.markers) {
      marker.mixer?.update(dt)
      if (marker.mixer) this.needsRender = true
      if (!marker.model) continue
      const previousProgress = marker.exitProgress
      marker.exitProgress = THREE.MathUtils.clamp(marker.exitProgress + (marker.claimed ? dt * 1.8 : -dt * 2.8), 0, 1)
      if (marker.exitProgress !== previousProgress) this.needsRender = true
      const exit = THREE.MathUtils.smoothstep(marker.exitProgress, 0, 1)
      const baseScale = marker.model.userData.baseScale as number
      marker.model.scale.setScalar(baseScale * Math.max(0.001, 1 - exit))
      marker.model.position.y = 0.11 + exit * 0.7
      marker.model.visible = marker.exitProgress < 1
    }
    this.controls.update()
    if (this.needsRender) {
      this.renderer.render(this.scene, this.camera)
      this.needsRender = false
    }
    this.frame = requestAnimationFrame(this.animate)
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: false })
    if (this.activePointers.size > 1) this.gestureHadMultiplePointers = true
  }

  private handlePointerMove = (event: PointerEvent): void => {
    const start = this.activePointers.get(event.pointerId)
    if (!start) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 7) start.moved = true
  }

  private handlePointerUp = (event: PointerEvent): void => {
    const start = this.activePointers.get(event.pointerId)
    this.activePointers.delete(event.pointerId)
    const wasMultiTouch = this.gestureHadMultiplePointers
    if (this.activePointers.size === 0) this.gestureHadMultiplePointers = false
    if (!start || start.moved || wasMultiTouch || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 7) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height * 2 - 1))
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects([...this.cards.values()].map((card) => card.hit), false)
    const id: unknown = hits[0]?.object.userData.cardId
    if (typeof id === 'string') this.onCardClick(id)
  }

  private handlePointerCancel = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId)
    if (this.activePointers.size === 0) this.gestureHadMultiplePointers = false
  }
}
