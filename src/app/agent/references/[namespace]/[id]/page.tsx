import ReferenceFocusView from '@/agent/components/ReferenceFocusView'

export default async function AgentReferencePage(props: {
  params: Promise<{ namespace: string; id: string }>
  searchParams: Promise<{ business_id?: string }>
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  return (
    <ReferenceFocusView
      namespace={params.namespace}
      id={params.id}
      businessId={searchParams.business_id}
    />
  )
}
