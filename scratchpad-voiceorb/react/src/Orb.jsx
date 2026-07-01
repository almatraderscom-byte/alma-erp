import { motion } from 'framer-motion';
import './orb.css';

/**
 * Orb — the animated voice orb.
 *
 * Scale is driven by Framer Motion and depends on `state`:
 *   idle      -> slow looping breathe   (5.4s)
 *   thinking  -> quicker looping breathe (2.3s)
 *   listening -> tracks the live audio `level` (springs to a new scale each frame)
 *
 * Everything else (cloud drift, conic sheen, liquid edge) is continuous CSS /
 * SVG animation defined in orb.css + OrbFilters.
 */
export default function Orb({ state, level = 0 }) {
  const animate =
    state === 'listening'
      ? { scale: 1 + level * 0.13 }
      : state === 'thinking'
      ? { scale: [1, 1.05, 1] }
      : { scale: [1, 1.045, 1] };

  const transition =
    state === 'listening'
      ? { type: 'spring', stiffness: 220, damping: 18, mass: 0.3 }
      : { duration: state === 'thinking' ? 2.3 : 5.4, repeat: Infinity, ease: 'easeInOut' };

  return (
    <motion.div className={`orb-stage ${state}`} animate={animate} transition={transition}>
      <div className="orb-glow" />
      <div className="orb">
        <div className="orb-body" />
        {/* two fractal-noise cloud layers -> flowing, morphing white wisps */}
        <svg className="cloud-layer c1" viewBox="0 0 220 220" preserveAspectRatio="xMidYMid slice">
          <rect width="220" height="220" filter="url(#clouds1)" />
        </svg>
        <svg className="cloud-layer c2" viewBox="0 0 220 220" preserveAspectRatio="xMidYMid slice">
          <rect width="220" height="220" filter="url(#clouds2)" />
        </svg>
        <div className="orb-sheen" />
        <div className="orb-hi" />
      </div>
    </motion.div>
  );
}
