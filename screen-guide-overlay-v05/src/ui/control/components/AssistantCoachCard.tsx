import { motion, AnimatePresence } from "motion/react"

interface Props {
  status: string
  stepInstruction: string
  onISeeIt: () => void
  onImStuck: () => void
}

const COACH_MESSAGES: Record<string, { headline: string; body: string }> = {
  guiding: { headline: "Almost there!", body: "Follow the orange highlight on screen. Click the element it points to." },
  checking: { headline: "Checking the screen...", body: "The AI is scanning what you see. This takes a moment." },
  stuck: { headline: "Need a hand?", body: "Scroll slowly or look around the highlighted area. The element might be hidden or renamed." },
  "wrong-page": { headline: "Wrong page", body: "Use the button above to navigate to the correct page." },
  complete: { headline: "All done!", body: "Your account is connected. You can close this guide." },
  idle: { headline: "Ready when you are", body: "Hit Start Guidance to begin the step-by-step walkthrough." },
}

export function AssistantCoachCard({ status, onISeeIt, onImStuck }: Props) {
  const msg = COACH_MESSAGES[status] ?? COACH_MESSAGES.idle

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={status}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.2 }}
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid #252b3a", borderRadius: 16, padding: "16px" }}
      >
        <div className="flex gap-3 items-start mb-3">
          {/* Avatar */}
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(255,138,0,0.12)", border: "1px solid rgba(255,138,0,0.25)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 20 }}>
            🤖
          </div>
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, color: "#f0f2f7", marginBottom: 4 }}>{msg.headline}</p>
            <p style={{ fontSize: 13, color: "#8a96ac", lineHeight: 1.45 }}>{msg.body}</p>
          </div>
        </div>
        {status !== "idle" && status !== "complete" && (
          <div className="flex gap-2">
            <button onClick={onISeeIt} className="no-drag flex-1 rounded-xl py-2 font-bold text-sm flex items-center justify-center gap-1.5" style={{ background: "#ff8a00", color: "#111", border: "none", cursor: "pointer" }}>
              <span>I see it</span>
              <span style={{ fontSize: 16 }}>✓</span>
            </button>
            <button onClick={onImStuck} className="no-drag flex-1 rounded-xl py-2 font-bold text-sm" style={{ background: "#171b24", border: "1px solid #252b3a", color: "#f0f2f7", cursor: "pointer" }}>
              {"I'm stuck 💬"}
            </button>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
