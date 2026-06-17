import { motion } from 'motion/react'
import { Rect } from '../types'

interface Props { rect: Rect }

export function AnimatedArrow({ rect }: Props) {
  const cx = rect.x + rect.w / 2
  const tipY = rect.y - 10

  // 3 chevrons stacked above the target, each cascading downward
  return (
    <svg
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh' }}
    >
      <defs>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {[0, 1, 2].map((i) => {
        const baseY = tipY - 56 + i * 20
        const w = 20 - i * 2
        const strokeW = 3.5 - i * 0.5
        return (
          <motion.g key={i} filter="url(#glow)">
            <motion.polyline
              points={`${cx - w},${baseY} ${cx},${baseY + 13} ${cx + w},${baseY}`}
              fill="none"
              stroke="#ff8a00"
              strokeWidth={strokeW}
              strokeLinecap="round"
              strokeLinejoin="round"
              animate={{ opacity: [0, 1, 1, 0], y: [0, 6, 12, 18] }}
              transition={{
                duration: 1.0,
                repeat: Infinity,
                ease: 'easeInOut',
                delay: i * 0.33,
              }}
            />
          </motion.g>
        )
      })}
    </svg>
  )
}
