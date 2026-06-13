import type { MapleAPI } from '../../preload'

declare global {
  interface Window {
    maple: MapleAPI
  }
}
