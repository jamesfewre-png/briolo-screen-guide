import { motion } from "motion/react"

interface Props { message: string }

export function StatusToast({ message }: Props) {
  return (
    <motion.div
      className="fixed bottom-4 right-4 pointer-events-none"
      style={{ zIndex: 9999 }}
      initial={{ opacity: 0, y: 12, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.95 }}
      transition={{ duration: 0.2 }}
    >
      <div style={{ background: "rgba(23,27,36,0.97)", border: "1px solid rgba(255,138,0,0.35)", borderRadius: 12, padding: "10px 16px", boxShadow: "0 4px 20px rgba(0,0,0,0.5)", fontSize: 13, fontWeight: 600, color: "#f0f2f7" }}>
        {message}
      </div>
    </motion.div>
  )
}
