// This game currently exposes no adjustable preview-only parameters. The existing
// Manus bridge remains registered, ready for meaningful future board controls.
type LegacyBoundary = 'jump' | 'dash' | 'run'
type Control = { id: string; default: number }
export const tuning = {
  controls: Object.freeze([] as Control[]),
  unranked: false,
  read(): { requested: Record<string, number>; active: Record<string, number> } {
    return { requested: {}, active: {} }
  },
  apply(patch: unknown): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length) {
      throw new Error('변경할 수 있는 설정이 없습니다')
    }
  },
  activate(_boundary?: LegacyBoundary): void {},
}
