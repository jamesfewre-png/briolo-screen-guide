import { useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { OverlayPayload } from './types'
import { TargetRing } from './components/TargetRing'
import { AnimatedArrow } from './components/AnimatedArrow'
import { GuideCardBanner } from './components/GuideCardBanner'
import { WorkflowDock } from './components/WorkflowDock'

const MOCK: OverlayPayload = {
  type: 'vision-highlight',
  message: 'Click Connected apps in the sidebar',
  label: 'Connected apps',
  confidence: 0.86,
  highlight: { x: 80, y: 300, w: 200, h: 28 },
  stepInstruction: 'In the left sidebar, click Connected apps.',
  stepIndex: 2,
  totalSteps: 7,
  status: 'ready',
}

const STEP_LABELS = [
  'Open Meta Business Suite',
  'Find Business Settings',
  'Go to Integrations',
  'Generate Token',
  'Copy Token',
  'Paste in Your Dashboard',
  'Verify Connection',
]

export function App() {
  const isMock = new URLSearchParams(location.search).get('mock') === '1'
  const [payload, setPayload] = useState<OverlayPayload>(isMock ? MOCK : { type: 'clear' })

  useEffect(() => {
    if (isMock) return
    if (!window.overlayBridge) return
    window.overlayBridge.onUpdate((p) => setPayload(p || { type: 'clear' }))
  }, [isMock])

  // dom-highlight: extension draws it in-page via CSS — no Electron overlay ring needed.
  // vision-highlight / callout: Electron overlay draws it (no DOM selector available).
  const hasHighlight = payload.type === 'vision-highlight' && payload.highlight
  const stepIdx = payload.stepIndex ?? 0
  const totalSteps = payload.totalSteps ?? 7

  const steps = STEP_LABELS.slice(0, totalSteps).map((label, i) => ({
    id: String(i),
    label,
    state: (i < stepIdx ? 'done' : i === stepIdx ? 'active' : 'pending') as 'done' | 'active' | 'pending',
  }))

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 9999 }}>
      {/* Guide card at top — only when there's guidance */}
      <AnimatePresence>
        {payload.type !== 'clear' && (
          <GuideCardBanner
            key="banner"
            message={payload.stepInstruction || payload.message || ''}
            confidence={payload.confidence}
            stepIndex={stepIdx}
            totalSteps={totalSteps}
            status={payload.status}
          />
        )}
      </AnimatePresence>

      {/* Target highlight ring */}
      <AnimatePresence>
        {hasHighlight && (
          <TargetRing key="ring" rect={payload.highlight!} label={payload.label} />
        )}
      </AnimatePresence>

      {/* Cascading arrow pointing at target */}
      <AnimatePresence>
        {hasHighlight && (
          <AnimatedArrow key="arrow" rect={payload.highlight!} />
        )}
      </AnimatePresence>

      {/* Workflow dock at bottom */}
      <AnimatePresence>
        {payload.type !== 'clear' && steps.length > 0 && (
          <WorkflowDock key="dock" steps={steps} />
        )}
      </AnimatePresence>
    </div>
  )
}
