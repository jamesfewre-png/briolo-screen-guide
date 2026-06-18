import { useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence } from "motion/react"
import { ControlState } from "./types"
import { GuideCard } from "./components/GuideCard"
import { AssistantCoachCard } from "./components/AssistantCoachCard"
import { StatusToast } from "./components/StatusToast"

const STEP_LABELS = [
  "Open Business Suite",
  "Open Settings",
  "System Users",
  "Add System User",
  "Generate Token",
  "Copy Token",
  "Paste in Dashboard",
]

const INITIAL: ControlState = {
  running: false, paused: false, status: "idle",
  stepInstruction: "Click Start Guidance to begin.",
  stepIndex: 0, totalSteps: 7, confidence: 0,
  helperConnected: false, elementCount: 0,
}

const MOCK_STATE: ControlState = {
  running: true, paused: false, status: "guiding",
  stepInstruction: "In the left sidebar, click Connected apps.",
  stepIndex: 2, totalSteps: 7, confidence: 0.86,
  helperConnected: false, elementCount: 0,
}

export function App() {
  const isMock = new URLSearchParams(location.search).get("mock") === "1"
  const [state, setState] = useState<ControlState>(isMock ? MOCK_STATE : INITIAL)
  const [toast, setToast] = useState<string | null>(null)
  const [debugData, setDebugData] = useState<string>("")
  const [showDebug, setShowDebug] = useState(false)
  const [chromeMetrics, setChromeMetrics] = useState<Record<string, unknown> | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const analyzingRef = useRef(false)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    if (isMock || !window.screenGuide) return
    window.screenGuide.onPageStateUpdate((data) => {
      const connected = Boolean(data?.state)
      const count = Array.isArray(data?.state?.elements) ? (data.state.elements as unknown[]).length : 0
      setState(s => ({ ...s, helperConnected: connected, elementCount: count }))
      if (data?.state?.windowMetrics) setChromeMetrics(data.state.windowMetrics as Record<string, unknown>)
    })
    window.screenGuide.onWorkflowStepChange(({ step, index, total }) => {
      setState(s => ({ ...s, stepInstruction: step?.instruction ?? s.stepInstruction, stepIndex: index, totalSteps: total }))
    })
    window.screenGuide.onWorkflowStatusChange(({ state: wfState, event }) => {
      if (wfState === "complete") {
        setState(s => ({ ...s, status: "complete", stepInstruction: "All done! Your Meta account is connected." }))
        showToast("Connected successfully!")
      }
      if (event === "stuck") setState(s => ({ ...s, status: "stuck" }))
    })
    window.screenGuide.onNavigate(({ url, label }) => {
      setState(s => ({ ...s, navigateUrl: url, navigateLabel: label }))
    })
    window.screenGuide.onRedetect(() => {
      if (!analyzingRef.current) captureAndAnalyze()
    })
  }, [isMock])

  const scheduleLoop = useCallback((ms: number) => {
    if (loopRef.current) clearTimeout(loopRef.current)
    loopRef.current = setTimeout(captureAndAnalyze, ms)
  }, [])

  const captureFrame = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || !video.videoWidth) return null
    const scale = Math.min(1, 800 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext("2d")!
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    // Mask bottom 8% of frame — WorkflowDock renders there; without masking the AI
    // targets dock step nodes instead of actual page elements.
    const maskH = Math.round(canvas.height * 0.08)
    ctx.fillStyle = "#000000"
    ctx.fillRect(0, canvas.height - maskH, canvas.width, maskH)
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.40), w: canvas.width, h: canvas.height }
  }

  const captureAndAnalyze = async () => {
    if (analyzingRef.current) return
    analyzingRef.current = true
    try {
      const frame = captureFrame()
      const result = await window.screenGuide.analyzeFrame({
        task: "Help me connect my Meta account to my dashboard.",
        frameDataUrl: frame?.dataUrl,
        captureMeta: frame ? { videoWidth: videoRef.current!.videoWidth, videoHeight: videoRef.current!.videoHeight, frameWidth: frame.w, frameHeight: frame.h } : undefined
      }) as Record<string, unknown>
      setDebugData(JSON.stringify(result, null, 2))
      const conf = Number(result?.confidence ?? 0)
      setState(s => ({ ...s, confidence: conf, status: conf < 0.45 ? "stuck" : conf < 0.65 ? "checking" : "guiding" }))
      scheduleLoop(conf < 0.55 ? 800 : 2000)
    } catch {
      scheduleLoop(1200)
    } finally {
      analyzingRef.current = false
    }
  }

  const startGuidance = async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false })
    streamRef.current = stream
    const video = document.createElement("video")
    video.autoplay = true; video.muted = true; video.srcObject = stream
    await video.play()
    videoRef.current = video
    canvasRef.current = document.createElement("canvas")
    stream.getVideoTracks()[0].addEventListener("ended", stopGuidance)
    const result = await window.screenGuide.startWorkflow("meta-connect-assets")
    setState(s => ({
      ...s, running: true, paused: false, status: "guiding",
      stepInstruction: result.step?.instruction ?? s.stepInstruction,
      stepIndex: result.stepIndex ?? 0,
      totalSteps: result.totalSteps ?? 7,
    }))
    setTimeout(captureAndAnalyze, 300)
  }

  const stopGuidance = () => {
    if (loopRef.current) clearTimeout(loopRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (window.screenGuide) window.screenGuide.stopWorkflow()
    setState(s => ({ ...s, running: false, paused: false, status: "idle", confidence: 0 }))
  }

  const togglePause = () => {
    const newPaused = !state.paused
    window.screenGuide.pauseWorkflow(newPaused)
    setState(s => ({ ...s, paused: newPaused, status: newPaused ? "idle" : "guiding" }))
    if (!newPaused) setTimeout(captureAndAnalyze, 200)
  }

  const steps = STEP_LABELS.slice(0, state.totalSteps).map((label, i) => ({
    id: String(i), label,
    state: (i < state.stepIndex ? "done" : i === state.stepIndex ? "active" : "pending") as "done" | "active" | "pending",
  }))

  return (
    <div className="flex flex-col h-screen" style={{ background: "#0f1117" }}>
      <div className="drag-handle h-8 flex items-center justify-center" style={{ borderBottom: "1px solid #252b3a" }}>
        <div className="no-drag" style={{ width: 40, height: 4, borderRadius: 999, background: "#252b3a" }} />
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        <GuideCard
          state={state} steps={steps}
          onStart={startGuidance} onStop={stopGuidance} onPause={togglePause}
          onNavigate={state.navigateUrl ? () => window.screenGuide.openUrl(state.navigateUrl!) : undefined}
          navigateLabel={state.navigateLabel}
        />
        <AssistantCoachCard
          status={state.status}
          stepInstruction={state.stepInstruction}
          onISeeIt={() => showToast("Great! Moving to next step...")}
          onImStuck={() => showToast("Checking the screen again...")}
        />
        <div className="flex items-center gap-2 px-1">
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: state.helperConnected ? "#2dd47e" : "#ff5c5c" }} />
          <span style={{ fontSize: 12, color: "#8a96ac" }}>
            {state.helperConnected ? `Extension connected · ${state.elementCount} elements` : "Browser extension not connected"}
          </span>
        </div>
        <button className="no-drag text-left" style={{ fontSize: 12, color: "#8a96ac", background: "none", border: "none", cursor: "pointer" }} onClick={() => setShowDebug(v => !v)}>
          {showDebug ? "▾ Hide debug" : "▸ Show debug"}
        </button>
        {showDebug && (
          <pre style={{ fontSize: 10, color: "#8a96ac", background: "#171b24", border: "1px solid #252b3a", borderRadius: 8, padding: 10, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {debugData || "Idle."}
          </pre>
        )}
        {showDebug && chromeMetrics && (
          <div style={{ fontSize: 10, color: "#6b7280", padding: "6px 10px", background: "#0f1117", border: "1px solid #1e2535", borderRadius: 8 }}>
            <strong style={{ color: "#ff8a00" }}>Chrome window metrics (from extension):</strong><br />
            {(() => {
              const o = chromeMetrics.outer as Record<string, number>
              const i = chromeMetrics.inner as Record<string, number>
              const vp = chromeMetrics.estimatedViewportOnScreen as Record<string, number>
              const dpr = chromeMetrics.devicePixelRatio as number
              return <>
                screenY={o.y} outerH={o.height} innerH={i.height} DPR={dpr}<br />
                chromeH=outerH-innerH={o.height - i.height}<br />
                <strong style={{ color: "#2dd47e" }}>vpY={vp.y}</strong> (should equal browser chrome bar height on screen)<br />
                <strong style={{ color: "#2dd47e" }}>vpX={vp.x}</strong>
              </>
            })()}
          </div>
        )}
      </div>
      <AnimatePresence>
        {toast && <StatusToast key="toast" message={toast} />}
      </AnimatePresence>
    </div>
  )
}
