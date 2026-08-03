import test from 'node:test'
import assert from 'node:assert/strict'
import { selectPreviewImageJob } from '../preview-image-e2e.mjs'

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
