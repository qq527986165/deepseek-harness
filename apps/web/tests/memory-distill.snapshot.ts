// @vitest-environment jsdom
// The memory-distill conversation node over the BUILT client graph: boot the
// assembled bundles, open the fixture session, and drive turn 74's keyless
// `memory/distill` receipt end to end — the node rebuilds from the log-only
// event alone and renders only the global and project topic-node chips. Each
// chip opens the matching vault's exact note read view. This file
// pins the acceptance criterion the per-package suites cannot reach: the
// transport -> conversation node -> panel projection path only the built client
// graph exposes.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

/** Open the fixture session and wait for its `memory-distill` node to mount. */
async function openSessionAndDistill(): Promise<HTMLElement> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
  return await waitFor(() => {
    const node = document.querySelector('[data-memory-distill]')
    expect(node).not.toBeNull()
    return node as HTMLElement
  }, { timeout: 10_000 })
}

/** Open the memory drawer (already flipped by a chip click) and return it. */
async function drawerOpen(): Promise<HTMLElement> {
  return await screen.findByRole('complementary', { name: 'Memory' }, { timeout: 10_000 })
}

it('rebuilds the distill node from the memory/distill event and opens its chips', async () => {
  mountAssembledApp()
  const node = await openSessionAndDistill()

  // The harness pins the complete en-US node copy: only committed note titles.
  expect(within(node).getByText('Memory distillation')).toBeTruthy()

  const noteChip = within(node).getByRole('button', { name: 'Open note "Coffee preference"' })
  expect(within(noteChip).getByText('Coffee preference')).toBeTruthy()

  const projectNoteChip = within(node).getByRole('button', { name: 'Open note "Project convention"' })
  expect(within(projectNoteChip).getByText('Project convention')).toBeTruthy()
  expect(within(node).getAllByRole('button')).toHaveLength(2)

  // The node's rendered text, pinned inline.
  expect(node.textContent?.trim()).toBe('Memory distillationCoffee preferenceProject convention')

  // The note chip opens the panel at the plain note read view (no read-only
  // pin, so the note body is all that needs asserting).
  fireEvent.click(noteChip)
  let drawer = await drawerOpen()
  await waitFor(() => {
    expect(within(drawer).getByText('Prefers pour-over coffee.')).toBeTruthy()
  }, { timeout: 10_000 })

  // Close the drawer before exercising the project chip.
  fireEvent.click(within(drawer).getByRole('button', { name: 'Close memory panel' }))
  await waitFor(() => {
    expect(screen.queryByRole('complementary', { name: 'Memory' })).toBeNull()
  }, { timeout: 10_000 })

  // The project chip carries the session cwd into memory/read, selecting the
  // project vault instead of falling back to the global fixture notes.
  fireEvent.click(projectNoteChip)
  drawer = await drawerOpen()
  await waitFor(() => {
    expect(within(drawer).getByText('Vitest is the test runner here.')).toBeTruthy()
  }, { timeout: 10_000 })
  fireEvent.click(within(drawer).getByRole('button', { name: 'Close memory panel' }))
  await waitFor(() => {
    expect(screen.queryByRole('complementary', { name: 'Memory' })).toBeNull()
  }, { timeout: 10_000 })
})
