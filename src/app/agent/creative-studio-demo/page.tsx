import { redirect } from 'next/navigation'

/** Legacy preview URL → production Creative Studio */
export default function CreativeStudioDemoRedirect() {
  redirect('/agent/creative-studio')
}
