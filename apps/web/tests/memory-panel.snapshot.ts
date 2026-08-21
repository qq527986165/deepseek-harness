// @vitest-environment jsdom
// The memory panel over the BUILT client graph: the sidebar foot action opens
// the drawer, the fixture memory Remote serves one global vault, and the
// pinned surfaces cover the vault listing, the note read view with backlinks
// and the wikilink mention, ranked search, and the deletion confirm dialog.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

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

it('lists the fixture vault and opens a note with backlinks and a wikilink mention', async () => {
  mountAssembledApp()
  const drawer = await openPanel()
  expect(within(drawer).getByText('Persona')).toBeTruthy()
  expect(within(drawer).getAllByRole('button', { name: /^About the user/ })).toHaveLength(1)
  expect(within(drawer).getByRole('button', { name: /Coffee gear/ })).toBeTruthy()
  expect([...drawer.querySelectorAll('li button')].map(button => button.textContent)).toMatchInlineSnapshot(`
    [
      "About the userPersonajust now",
      "Coffee preferenceidentitypreferencejust now",
      "Coffee gearjust now",
    ]
  `)

  fireEvent.click(within(drawer).getByRole('button', { name: /Coffee preference/ }))
  await waitFor(() => {
    expect(within(drawer).getByText('Prefers pour-over coffee.')).toBeTruthy()
  }, { timeout: 10_000 })
  expect(within(drawer).getByRole('heading', { name: 'Backlinks' })).toBeTruthy()
  // The body wikilink resolves to the Coffee gear note and opens it in-panel
  // (the mention carries the target title as its tooltip).
  const mention = within(drawer).getAllByTitle('Coffee gear')[0]
  if (mention === undefined) throw new Error('wikilink mention missing')
  fireEvent.click(mention)
  await waitFor(() => {
    expect(within(drawer).getByText('Owns a hand grinder and a V60.')).toBeTruthy()
  }, { timeout: 10_000 })
})

it('searches the vault and confirms a deletion', async () => {
  mountAssembledApp()
  const drawer = await openPanel()
  const search = within(drawer).getByPlaceholderText('Search this vault')
  fireEvent.change(search, { target: { value: 'gear' } })
  await waitFor(() => {
    expect(within(drawer).getByRole('button', { name: /Coffee gear/ })).toBeTruthy()
  }, { timeout: 10_000 })
  expect(within(drawer).queryByRole('button', { name: /Coffee preference/ })).toBeNull()

  fireEvent.click(within(drawer).getByRole('button', { name: /Coffee gear/ }))
  await waitFor(() => {
    expect(within(drawer).getByText('Owns a hand grinder and a V60.')).toBeTruthy()
  }, { timeout: 10_000 })
  fireEvent.click(within(drawer).getByRole('button', { name: 'Delete' }))
  const dialog = await screen.findByRole('dialog', {}, { timeout: 10_000 })
  expect(within(dialog).getByText(/Coffee gear/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull()
  }, { timeout: 10_000 })
  await waitFor(() => {
    expect(within(drawer).queryByRole('button', { name: /Coffee gear/ })).toBeNull()
  }, { timeout: 10_000 })
})
