import { SettingsView } from '@/agent/components/phone/console/SettingsView'

export const metadata = { title: 'ফোন কনসোল — সীমা ও ক্যাপ' }

export default function Page() {
  return <SettingsView group="limits" />
}
