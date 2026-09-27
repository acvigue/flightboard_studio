import { ElectronAPI } from '@electron-toolkit/preload'
import type { StudioApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: StudioApi
  }
}
