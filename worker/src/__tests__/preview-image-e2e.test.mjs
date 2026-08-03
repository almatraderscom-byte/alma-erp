import test from 'node:test'
import assert from 'node:assert/strict'
import { selectPreviewImageJob } from '../preview-image-e2e.mjs'

test('selectPreviewImageJob selects only the exact signed Creative Studio project', () => {
  const jobs = [
    { id: 'wrong-project', type: 'image_gen', payload: { creativeStudio: true, studioRunScope: { projectId: 'other' }, studioRunAuthorization: { receipt: 'signed' } } },
    { id: 'unsigned', type: 'image_gen', payload: { creativeStudio: true, studioRunScope: { projectId: 'target' } } },
    { id: 'target', type: 'image_gen', payload: { creativeStudio: true, studioRunScope: { projectId: 'target' }, studioRunAuthorization: { receipt: 'signed' } } },
  ]
  assert.equal(selectPreviewImageJob(jobs, 'target')?.id, 'target')
  assert.equal(selectPreviewImageJob(jobs, 'missing'), null)
})
