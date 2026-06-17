import { motion } from 'motion/react'

interface Step { id: string; label: string; state: 'done' | 'active' | 'pending' }
interface Props { steps: Step[] }

export function WorkflowDock({ steps }: Props) {
  return (
    <motion.div
      className="fixed bottom-0 left-0 right-0 pointer-events-none"
      style={{ zIndex: 10000 }}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <div
        style={{
          margin: '0 auto',
          background: 'rgba(10,12,18,0.70)',
          backdropFilter: 'blur(20px) saturate(160%)',
          borderTop: '1px solid rgba(255,138,0,0.18)',
          padding: '12px 24px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0,
        }}
      >
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-center">
            {/* Connector line */}
            {i > 0 && (
              <div
                style={{
                  width: 32,
                  height: 2,
                  background: step.state === 'pending' ? '#252b3a' : step.state === 'active' ? '#ff8a00' : '#2dd47e',
                  transition: 'background 0.3s',
                }}
              />
            )}
            {/* Step node */}
            <div className="flex flex-col items-center" style={{ minWidth: 72 }}>
              <motion.div
                style={{
                  width: step.state === 'active' ? 32 : 26,
                  height: step.state === 'active' ? 32 : 26,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: step.state === 'done' ? 13 : 11,
                  fontWeight: 700,
                  background:
                    step.state === 'done' ? '#2dd47e' :
                    step.state === 'active' ? '#ff8a00' : '#252b3a',
                  color:
                    step.state === 'done' ? '#0f1117' :
                    step.state === 'active' ? '#111' : '#8a96ac',
                  border: step.state === 'active' ? '2px solid rgba(255,138,0,0.5)' : 'none',
                  boxShadow: step.state === 'active' ? '0 0 16px rgba(255,138,0,0.4)' : 'none',
                }}
                animate={step.state === 'active' ? { scale: [1, 1.06, 1] } : {}}
                transition={{ duration: 1.6, repeat: Infinity }}
              >
                {step.state === 'done' ? 'âœ“' : i + 1}
              </motion.div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: step.state === 'active' ? 700 : 500,
                  color: step.state === 'done' ? '#2dd47e' : step.state === 'active' ? '#ff8a00' : '#8a96ac',
                  marginTop: 5,
                  textAlign: 'center',
                  lineHeight: 1.25,
                  maxWidth: 68,
                }}
              >
                {step.label}
              </span>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  )
}

