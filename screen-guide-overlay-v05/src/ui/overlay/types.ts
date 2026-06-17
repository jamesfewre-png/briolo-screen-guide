export interface Rect { x: number; y: number; w: number; h: number }

export interface OverlayPayload {
  type: 'clear' | 'message' | 'vision-highlight' | 'dom-highlight' | 'callout'
  message?: string
  label?: string
  confidence?: number
  highlight?: Rect
  stepInstruction?: string
  stepIndex?: number
  totalSteps?: number
  status?: 'ready' | 'checking' | 'unsure' | 'complete' | 'wrong-page'
}

declare global {
  interface Window {
    overlayBridge: {
      onUpdate: (cb: (payload: OverlayPayload) => void) => void
    }
  }
}
