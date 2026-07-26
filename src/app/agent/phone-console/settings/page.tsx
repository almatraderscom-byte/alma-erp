import { SettingsView } from '@/agent/components/phone/console/SettingsView'

export const metadata = { title: 'ফোন কনসোল — ফরওয়ার্ড ও ট্রান্সফার' }

export default function Page() {
  return <SettingsView group="forward" />
}
