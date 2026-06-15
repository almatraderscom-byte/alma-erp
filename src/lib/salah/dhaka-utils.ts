export function isFridayDhaka(ymd: string): boolean {
  const noon = new Date(`${ymd}T12:00:00+06:00`)
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', weekday: 'long' }).format(noon) ===
    'Friday'
  )
}

export function dhakaInstant(ymd: string, h: number, min: number): Date {
  return new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+06:00`)
}
