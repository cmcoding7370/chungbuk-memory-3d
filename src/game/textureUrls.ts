import manifest from '../../assets.lock.json'

const registeredAssets = manifest.assets as Record<string, { path: string }>

/** Use the immutable registered asset in hosted games, or a local path before registration. */
export function getTextureUrl(path: string): string {
  return registeredAssets[path]?.path ?? new URL(path, document.baseURI).href
}
