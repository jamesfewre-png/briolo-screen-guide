export interface WorkflowStep {
  id: string
  label: string
  state: 'done' | 'active' | 'pending'
}

export type GuidanceStatus = 'idle' | 'guiding' | 'checking' | 'stuck' | 'wrong-page' | 'complete'

export interface ControlState {
  running: boolean
  paused: boolean
  status: GuidanceStatus
  stepInstruction: string
  stepIndex: number
  totalSteps: number
  confidence: number
  helperConnected: boolean
  elementCount: number
  navigateUrl?: string
  navigateLabel?: string
}

declare global {
  interface Window {
    screenGuide: {
      analyzeFrame: (payload: unknown) => Promise<unknown>
      getPageState: () => Promise<unknown>
      clearOverlay: () => Promise<void>
      showOverlay: (g: unknown) => Promise<void>
      startWorkflow: (id: string) => Promise<{ step?: { instruction: string }; stepIndex?: number; totalSteps?: number }>
      pauseWorkflow: (paused: boolean) => Promise<void>
      stopWorkflow: () => Promise<void>
      onPageStateUpdate: (cb: (data: { state: { elements?: unknown[]; url?: string } | null; receivedAt: number }) => void) => void
      onWorkflowStepChange: (cb: (data: { step: { instruction: string }; index: number; total: number }) => void) => void
      onWorkflowStatusChange: (cb: (data: { event: string; state: string }) => void) => void
      onRedetect: (cb: () => void) => void
      onNavigate: (cb: (data: { url: string; label: string }) => void) => void
      openUrl: (url: string) => Promise<void>
    }
  }
}
