'use client'

/**
 * A real phone keypad. Two jobs, and they are genuinely different:
 *  - before a call, it composes a number;
 *  - during a call, each press sends a DTMF tone, which is how you get through the automated
 *    menus couriers and banks put in front of a human.
 * Letters are shown because people read numbers off cards and signs that way.
 */
const KEYS: Array<{ digit: string; letters?: string }> = [
  { digit: '1' }, { digit: '2', letters: 'ABC' }, { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' }, { digit: '5', letters: 'JKL' }, { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' }, { digit: '8', letters: 'TUV' }, { digit: '9', letters: 'WXYZ' },
  { digit: '*' }, { digit: '0', letters: '+' }, { digit: '#' },
]

export default function Dialpad({ onPress }: { onPress: (digit: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {KEYS.map(({ digit, letters }) => (
        <button
          key={digit}
          type="button"
          onClick={() => onPress(digit)}
          // Big targets: this gets used on a phone, one-handed, often in a hurry.
          className="flex h-14 flex-col items-center justify-center rounded-xl border border-border-subtle bg-bg-2 transition-all active:scale-95 hover:border-gold/40 hover:bg-gold/10"
        >
          <span className="text-xl font-medium leading-none text-cream">{digit}</span>
          {letters ? (
            <span className="mt-0.5 text-[9px] tracking-widest text-muted">{letters}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
