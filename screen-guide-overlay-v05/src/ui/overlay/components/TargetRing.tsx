import { motion } from 'motion/react'
import { Rect } from '../types'

interface Props {
  rect: Rect
  label?: string
}

export function TargetRing({ rect, label }: Props) {
  return (
    <motion.div
      className="fixed pointer-events-none"
      style={{ left: rect.x - 8, top: rect.y - 8, width: rect.w + 16, height: rect.h + 16 }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.88 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      {/* Outer glow pulse */}
      <motion.div
        className="absolute inset-0 rounded-xl border-2"
        style={{ borderColor: '#ff8a00' }}
        animate={{
          boxShadow: [
            '0 0 0 0px rgba(255,138,0,0.7)',
            '0 0 0 10px rgba(255,138,0,0)',
          ],
          opacity: [0.7, 1, 0.7],
        }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* Fill */}
      <motion.div
        className="absolute inset-0 rounded-xl"
        animate={{ backgroundColor: ['rgba(255,138,0,0.06)', 'rgba(255,138,0,0.14)', 'rgba(255,138,0,0.06)'] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* Inner white ring */}
      <div
        className="absolute rounded-lg"
        style={{
          inset: 3,
          border: '1px solid rgba(255,255,255,0.25)',
        }}
      />
      {/* Label tag */}
      {label && (
        <motion.div
          className="absolute -top-10 left-0 flex items-center gap-2 whitespace-nowrap"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <div
            className="text-white text-xs font-bold px-3 py-1.5 rounded-lg"
            style={{
              background: 'rgba(23,27,36,0.95)',
              border: '1px solid rgba(255,138,0,0.6)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}
          >
            {label.slice(0, 40)}
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}
