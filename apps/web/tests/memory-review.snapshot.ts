// @vitest-environment jsdom
// The memory-review conversation node over the BUILT client graph: boot the
// assembled bundles, open the fixture session, and drive turn 75's keyless
// `/memory-review` proposal end to end — two candidate cards render with the
// pinned EN copy, the confirm control stays disabled until every candidate is
// staged, and confirming promotes the accepted project note into the global
// vault (the panel's `memory/list` then lists it) while the rejected note stays
// in the project vault. This file pins the acceptance criterion the per-package
// suites cannot reach: the transport -> conversation node -> settle -> panel
// projection path only the built client graph exposes.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

/** Open the fixture session and wait for its `memory-review` node to mount. */
async function openSessionAndReview(): Promise<HTMLElement> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
  return await waitFor(() => {
    const node = document.querySelector('[data-memory-review]')
    expect(node).not.toBeNull()
    return node as HTMLElement
  }, { timeout: 10_000 })
}

/** One candidate card, resolved by its pinned title within the review node. */
function candidateCard(node: HTMLElement, title: string): HTMLElement {
  const card = [...node.querySelectorAll('[data-candidate]')]
    .find(el => within(el as HTMLElement).queryByText(title) !== null)
  if (card === undefined) throw new Error(`candidate card "${title}" missing`)
  return card as HTMLElement
}

/** Open the memory drawer from the sidebar foot action and wait for its list. */
async function openPanel(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: 'Open memory panel' }, { timeout: 10_000 })
  fireEvent.click(button)
  const drawer = await screen.findByRole('complementary', { name: 'Memory' }, { timeout: 10_000 })
  await waitFor(() => {
    expect(within(drawer).getByRole('button', { name: /Coffee preference/ })).toBeTruthy()
  }, { timeout: 10_000 })
  return drawer
}

it('renders the candidates, pins the confirm on full staging, and promotes the accepted note', async () => {
  mountAssembledApp()
  const node = await openSessionAndReview()

  // Candidates and pinned EN copy: titles, snippets, reasons, and the per-card
  // + footer controls. The harness pins en-US, so assert the English strings.
  expect(within(node).getByText('Memory promotion review')).toBeTruthy()
  const p1 = candidateCard(node, 'Session notes')
  const p2 = candidateCard(node, 'Project convention')
  expect(within(p1).getByText('The user keeps session notes in the project.')).toBeTruthy()
  expect(within(p1).getByText('User-wide workflow preference.')).toBeTruthy()
  expect(within(p2).getByText('Vitest is the test runner here.')).toBeTruthy()
  expect(within(p2).getByText('Project-specific, not user-wide.')).toBeTruthy()
  expect(within(p1).getByRole('button', { name: 'Accept' })).toBeTruthy()
  expect(within(p1).getByRole('button', { name: 'Reject' })).toBeTruthy()
  expect(within(p1).getByRole('button', { name: 'Open note' })).toBeTruthy()
  expect(within(p2).getByRole('button', { name: 'Accept' })).toBeTruthy()
  expect(within(p2).getByRole('button', { name: 'Reject' })).toBeTruthy()
  expect(within(node).getByRole('button', { name: 'Accept all' })).toBeTruthy()

  // Confirm stays disabled until every candidate is staged. The repo carries no
  // @testing-library/jest-dom (no test imports it, it is not a dependency), so
  // pin the native `disabled` property its `toBeDisabled()` matcher reads.
  const confirm = within(node).getByRole('button', { name: 'Confirm promotion' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.click(within(p1).getByRole('button', { name: 'Accept' }))
  expect(confirm.disabled).toBe(true)
  fireEvent.click(within(p2).getByRole('button', { name: 'Reject' }))
  expect(confirm.disabled).toBe(false)

  // Confirm settles the review: the fixture `memoryReview/decide` promotes p1
  // into the global vault and appends `memory/review-decided`, which flips the
  // node into its settled marks.
  fireEvent.click(confirm)
  const settled = await waitFor(() => {
    const el = document.querySelector('[data-memory-review]')
    expect(el).not.toBeNull()
    expect(within(el as HTMLElement).getByText('Settled')).toBeTruthy()
    return el as HTMLElement
  }, { timeout: 10_000 })
  expect(within(candidateCard(settled, 'Session notes')).getByText('Promoted to global')).toBeTruthy()
  expect(within(candidateCard(settled, 'Project convention')).getByText('Rejected')).toBeTruthy()

  // The settled node's rendered copy, pinned inline.
  expect(settled.textContent?.trim()).toBe('Memory promotion reviewSettledSession notesPromoted to globalThe user keeps session notes in the project.User-wide workflow preference.Project conventionRejectedVitest is the test runner here.Project-specific, not user-wide.')

  // Vault promotion through the panel: the global list now carries the
  // promoted `Session notes`, while `Project convention` stays in the project
  // vault and never appears in the global list.
  const drawer = await openPanel()
  expect(within(drawer).getByRole('button', { name: /Session notes/ })).toBeTruthy()
  expect(within(drawer).queryByRole('button', { name: /Project convention/ })).toBeNull()
})
