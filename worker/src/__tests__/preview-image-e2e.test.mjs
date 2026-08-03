import test from 'node:test'
import assert from 'node:assert/strict'
import { selectPreviewImageJob, terminalPreviewImageQcFailure } from '../preview-image-e2e.mjs'

test('selectPreviewImageJob selects only the exact signed Creative Studio project', () => {
  const jobs = [
    { id: 'wrong-project', type: 'image_gen', payload: { creativeStudio: true, studioSurface: 'v3', studioRunScope: { projectId: 'other' }, studioRunAuthorization: { receipt: 'signed' } } },
    { id: 'unsigned', type: 'image_gen', payload: { creativeStudio: true, studioSurface: 'v3', studioRunScope: { projectId: 'target' } } },
    { id: 'target', type: 'image_gen', payload: { creativeStudio: true, studioSurface: 'v3', studioRunScope: { projectId: 'target' }, studioRunAuthorization: { receipt: 'signed' } } },
  ]
  assert.equal(selectPreviewImageJob(jobs, 'target')?.id, 'target')
  assert.equal(selectPreviewImageJob(jobs, 'missing'), null)
})

test('selectPreviewImageJob includes signed internal Studio V3 chain steps', () => {
  const jobs = [{
    id: 'garment-prep',
    type: 'image_gen',
    payload: {
      creativeStudio: false,
      chainInternal: true,
      studioSurface: 'v3',
      studioRunScope: { projectId: 'target' },
      studioRunAuthorization: { receipt: 'signed' },
    },
  }]
  assert.equal(selectPreviewImageJob(jobs, 'target')?.id, 'garment-prep')
})

test('terminal strict-QC failure fails certification with an actionable reason', () => {
  const payload = { familyChain: { plan: ['garment_prep', 'adult_tryon', 'rescene'], stepIndex: 2 } }
  const result = { data: { qc: { pass: false, overall: 3, flagged: 'weak garment fidelity' } } }
  assert.equal(
    terminalPreviewImageQcFailure(payload, result),
    'preview_image_qc_failed:3/5:weak garment fidelity',
  )
})

test('intermediate QC failure does not stop a chain that may still improve', () => {
  const payload = { familyChain: { plan: ['garment_prep', 'adult_tryon', 'rescene'], stepIndex: 1 } }
  const result = { data: { qc: { pass: false, overall: 2 } } }
  assert.equal(terminalPreviewImageQcFailure(payload, result), null)
})

test('terminal QC pass keeps certification green', () => {
  const payload = { familyChain: { plan: ['adult_tryon', 'rescene'], stepIndex: 1 } }
  const result = { data: { qc: { pass: true, overall: 5 } } }
  assert.equal(terminalPreviewImageQcFailure(payload, result), null)
})
