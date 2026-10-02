import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCurrentWorkspaceDialog, closeAddWorkspaceDialog, setWorkspacesService, getWorkspacesService, getAddWorkspaceDialogState, openAddWorkspaceDialog, subscribeAddWorkspaceDialog } from '../lib/types/client/addWorkspace.js'

test('workspace dialog releases service and closes on plugin disposal', () => {
  const service = { create() {} }
  const dispose = setWorkspacesService(service)
  let notifications = 0
  const unsubscribe = subscribeAddWorkspaceDialog(() => { notifications++ })
  openAddWorkspaceDialog(12, 34)
  assert.equal(getWorkspacesService(), service)
  assert.equal(getAddWorkspaceDialogState().open, true)
  dispose()
  assert.equal(getWorkspacesService(), undefined)
  assert.equal(getAddWorkspaceDialogState().open, false)
  assert.equal(notifications, 2)
  unsubscribe()
})

test('closed and reopened dialogs reject old asynchronous results', async () => {
  openAddWorkspaceDialog(10, 20)
  const old = getAddWorkspaceDialogState()
  let finish
  const pending = new Promise(resolve => { finish = resolve }).then(() => {
    if (isCurrentWorkspaceDialog(old)) closeAddWorkspaceDialog()
  })
  closeAddWorkspaceDialog()
  openAddWorkspaceDialog(10, 20)
  finish()
  await pending
  assert.equal(getAddWorkspaceDialogState().open, true)
  assert.equal(isCurrentWorkspaceDialog(old), false)
  assert.equal(isCurrentWorkspaceDialog(getAddWorkspaceDialogState()), true)
  closeAddWorkspaceDialog()
})

test('old workspace binding cannot release a newer service', () => {
  const oldDispose = setWorkspacesService({ create() {} })
  const current = { create() {} }
  const dispose = setWorkspacesService(current)
  oldDispose()
  assert.equal(getWorkspacesService(), current)
  dispose()
})
