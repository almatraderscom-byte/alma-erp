import { SettingsView } from '@/agent/components/phone/console/SettingsView'

export const metadata = { title: 'ফোন কনসোল — আউটবাউন্ড নিয়ম' }

export default function Page() {
  return <SettingsView group="outbound" />
}
