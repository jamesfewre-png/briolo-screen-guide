import { motion } from "motion/react"
import { ControlState } from "../types"

interface Step { id: string; label: string; state: "done" | "active" | "pending" }

interface Props {
  state: ControlState
  steps: Step[]
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onNavigate?: () => void
  navigateLabel?: string
}

const CONF_STYLE: Record<string, { color: string; label: string }> = {
  guiding: { color: "#2dd47e", label: "Confirmed" },
  checking: { color: "#ffd479", label: "Checking..." },
  stuck: { color: "#ff5c5c", label: "Not sure — scroll slowly" },
  idle: { color: "#8a96ac", label: "" },
  complete: { color: "#2dd47e", label: "Complete!" },
  "wrong-page": { color: "#ff5c5c", label: "Wrong page" },
}

export function GuideCard({ state, steps, onStart, onStop, onPause, onNavigate, navigateLabel }: Props) {
  const conf = CONF_STYLE[state.status] ?? CONF_STYLE.idle
  const pct = state.running && state.confidence > 0 ? Math.round(state.confidence * 100) : null

  return (
    <div style={{ background: "#171b24", border: "1px solid #252b3a", borderRadius: 16, overflow: "hidden" }}>
      {/* Header */}
      <div className="drag-handle px-4 pt-4 pb-3" style={{ borderBottom: "1px solid #252b3a" }}>
        <div className="no-drag flex items-center justify-between">
          <span style={{ fontSize: 13, fontWeight: 700, color: "#ff8a00" }}>AI Screen Guide</span>
          {state.running && (
            <span style={{ fontSize: 11, color: "#8a96ac" }}>
              Step {state.stepIndex + 1} of {state.totalSteps}
            </span>
          )}
        </div>
        {/* Dots */}
        {state.running && (
          <div className="no-drag flex gap-1.5 mt-2">
            {steps.map((s, i) => (
              <motion.div key={i}
                animate={{ width: s.state === "active" ? 18 : 6 }}
                transition={{ duration: 0.25 }}
                style={{
                  height: 5, borderRadius: 999,
                  background: s.state === "done" ? "#2dd47e" : s.state === "active" ? "#ff8a00" : "#252b3a",
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Instruction */}
      <div className="no-drag px-4 py-4">
        <p style={{ fontSize: 16, fontWeight: 600, color: "#f0f2f7", lineHeight: 1.45, minHeight: 48 }}>
          {state.stepInstruction}
        </p>
        {pct !== null && (
          <p style={{ fontSize: 11, marginTop: 8, color: conf.color, fontWeight: 600 }}>
            {conf.label}{conf.label && pct !== null ? " · " : ""}{pct !== null ? `${pct}%` : ""}
          </p>
        )}
      </div>

      {/* Navigate banner */}
      {onNavigate && (
        <div className="no-drag mx-4 mb-3 rounded-xl p-3" style={{ background: "rgba(255,138,0,0.08)", border: "1px solid rgba(255,138,0,0.28)" }}>
          <p style={{ fontSize: 12, color: "#8a96ac", marginBottom: 8 }}>{"You're on the wrong page. Open the correct one:"}</p>
          <button onClick={onNavigate} className="no-drag w-full rounded-lg py-2 text-sm font-bold" style={{ background: "#ff8a00", color: "#111", border: "none", cursor: "pointer" }}>
            Open {navigateLabel?.replace(/-/g, " ") ?? "page"} →
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="no-drag px-4 pb-4 flex gap-2">
        {!state.running ? (
          <button onClick={onStart} className="no-drag flex-1 rounded-xl py-2.5 font-bold text-sm" style={{ background: "#ff8a00", color: "#111", border: "none", cursor: "pointer" }}>
            Start Guidance
          </button>
        ) : (
          <>
            <button onClick={onPause} className="no-drag rounded-xl px-4 py-2.5 font-bold text-sm" style={{ background: "#171b24", border: "1px solid #252b3a", color: "#f0f2f7", cursor: "pointer" }}>
              {state.paused ? "Resume" : "Pause"}
            </button>
            <button onClick={onStop} className="no-drag rounded-xl px-4 py-2.5 font-bold text-sm" style={{ background: "#3a1a1a", border: "1px solid #5c2330", color: "#ff9292", cursor: "pointer" }}>
              Stop
            </button>
          </>
        )}
      </div>
    </div>
  )
}
