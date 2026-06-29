/**
 * Maps an office task's (status, verificationStatus) into a single glanceable
 * todolist state — shared by the staff and owner todolists so both read the
 * same way: done / awaiting-approval / redo / carried / in-progress.
 */
export type TodoStateKey = 'done' | 'approval' | 'redo' | 'carry' | 'active'

export type TodoState = {
  key: TodoStateKey
  /** Char rendered inside the status circle ('' = hollow/unchecked). */
  icon: string
  /** Bangla status label for the pill. */
  label: string
  /** Office badge class (.b-done / .b-pending / .b-redo / .b-carry / .b-active). */
  badge: string
  done: boolean
  /** Sort weight — not-done surfaces above done. */
  rank: number
}

export function todoState(t: {
  status: string
  verificationStatus: string
  carriedOver?: boolean
  needsOwner?: boolean
}): TodoState {
  if (t.status === 'done' || t.verificationStatus === 'owner_approved') {
    return { key: 'done', icon: '✓', label: 'সম্পন্ন', badge: 'b-done', done: true, rank: 5 }
  }
  if (t.verificationStatus === 'redo_requested') {
    return { key: 'redo', icon: '↻', label: 'সংশোধন দরকার', badge: 'b-redo', done: false, rank: 1 }
  }
  if (t.verificationStatus === 'proof_submitted' || t.verificationStatus === 'auto_verified' || t.needsOwner) {
    return { key: 'approval', icon: '⏳', label: 'অনুমোদনের অপেক্ষায়', badge: 'b-pending', done: false, rank: 2 }
  }
  if (t.carriedOver) {
    return { key: 'carry', icon: '↪', label: 'আগের দিনের · বাকি', badge: 'b-carry', done: false, rank: 3 }
  }
  return { key: 'active', icon: '', label: 'বাকি', badge: 'b-active', done: false, rank: 4 }
}
