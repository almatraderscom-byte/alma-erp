import { SettingsView } from '@/agent/components/phone/console/SettingsView'

export const metadata = { title: 'ফোন কনসোল — অফিস সময় ও ছুটি' }

export default function Page() {
  return <SettingsView group="hours" />
}
