import manifest from '../../assets.lock.json'

/** Immutable project-storage URLs; the local preview resolves these to local files. */
export function getModelUrl(index: number): string {
  const models = manifest.assets as Record<string, { path: string }>
  const record = models[`assets/models/${index}.glb`]
  return record?.path ?? `/assets/models/${index}.glb`
}
