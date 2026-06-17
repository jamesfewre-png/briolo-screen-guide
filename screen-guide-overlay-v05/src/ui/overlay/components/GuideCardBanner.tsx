import { motion } from 'motion/react'

interface Props {
  message: string
  confidence?: number
  stepIndex: number
  totalSteps: number
  status?: string
}

const STATUS_COLOR: Record<string, string> = {
  ready: '#2dd47e',
  checking: '#ffd479',
  unsure: '#ff8a00',
  complete: '#2dd47e',
  'wrong-page': '#ff5c5c',
}

export function GuideCardBanner({ message, confidence, stepIndex, totalSteps, status = 'ready' }: Props) {
  const pct = typeof confidence === 'number' ? Math.round(confidence * 100) : null
  const color = STATUS_COLOR[status] ?? '#ff8a00'
  const safeMsg = message.replace(/\*\*/g, '').slice(0, 120)

  return (
    <motion.div
      className="fixed top-5 left-1/2 pointer-events-none"
      style={{ transform: 'translateX(-50%)', zIndex: 10000, maxWidth: 560, width: '90vw' }}
      initial={{ opacity: 0, y: -16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -12, scale: 0.96 }}
      transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <div
        style={{
          background: 'rgba(15,17,23,0.96)',
          backdropFilter: 'blur(24px) saturate(180%)',
          border: '1px solid rgba(255,138,0,0.28)',
          borderRadius: 20,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,138,0,0.10)',
          padding: '16px 20px',
        }}
      >
        {/* Step pill */}
        <div className="flex items-center justify-between mb-2.5">
          <span style={{ fontSize: 11, fontWeight: 700, color: '#ff8a00', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Step {stepIndex + 1} of {totalSteps}
          </span>
          {/* Step dots */}
          <div className="flex gap-1.5">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <motion.div
                key={i}
                style={{
                  width: i === stepIndex ? 18 : 6,
                  height: 6,
                  borderRadius: 999,
                  background: i < stepIndex ? '#2dd47e' : i === stepIndex ? '#ff8a00' : '#252b3a',
                }}
                animate={{ width: i === stepIndex ? 18 : 6 }}
                transition={{ duration: 0.25 }}
              />
            ))}
          </div>
        </div>

        {/* Main instruction */}
        <p style={{ fontSize: 16, fontWeight: 700, color: '#f0f2f7', lineHeight: 1.4, marginBottom: 10 }}>
          {safeMsg}
        </p>

        {/* Confidence badge */}
        {pct !== null && (
          <div className="flex items-center gap-2">
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                background: `${color}18`,
                border: `1px solid ${color}44`,
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
              <span style={{ fontSize: 12, fontWeight: 700, color }}>{pct}% confidence</span>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  )
}
