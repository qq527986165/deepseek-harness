// @vitest-environment jsdom
/** The sidebar foot action: renders label only when wide, opens the shared store. */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MemoryFooterAction } from '../src/client/panel/MemoryPanelFooterAction.tsx'
import { createMemoryPanelStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** Test-side selector-hook stub over the bare store engine. */
function selectorHook<T>(source: { getSnapshot(): T; subscribe(fn: () => void): () => void }) {
  return function useSelect<S>(selector: (snapshot: T) => S): S {
    return useSyncExternalStore(
      listener => source.subscribe(listener),
      () => selector(source.getSnapshot()),
    )
  }
}

function bench() {
  const store = createMemoryPanelStore().create()
  const t = makeTranslate(zh)
  // The global standard-kit seats the root-scope entry receives; the footer
  // action reads neither, so inert stubs satisfy the props share.
  const inert = (() => undefined) as never
  return {
    store,
    actions: store.actions,
    useStore: selectorHook(store),
    useSessions: inert,
    useWorkspaces: inert,
    t: t as never,
  }
}

describe('MemoryFooterAction', () => {
  it('renders an icon-only button on the rail that opens the panel', () => {
    const { store, actions, useStore, useSessions, useWorkspaces, t } = bench()
    const view = render(
      <MemoryFooterAction
        wide={false}
        useStore={useStore}
        useSessions={useSessions}
        useWorkspaces={useWorkspaces}
        actions={actions}
        t={t}
      />,
    )
    const button = view.getByRole('button', { name: '打开记忆面板' })
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(store.getSnapshot().open).toBe(true)
  })

  it('renders the label when the sidebar is wide and reflects the open state', () => {
    const { actions, useStore, useSessions, useWorkspaces, t } = bench()
    const view = render(
      <MemoryFooterAction
        wide={true}
        useStore={useStore}
        useSessions={useSessions}
        useWorkspaces={useWorkspaces}
        actions={actions}
        t={t}
      />,
    )
    const button = view.getByRole('button', { name: '打开记忆面板' })
    expect(button.textContent).toBe('记忆')
    actions.openPanel()
    view.rerender(
      <MemoryFooterAction
        wide={true}
        useStore={useStore}
        useSessions={useSessions}
        useWorkspaces={useWorkspaces}
        actions={actions}
        t={t}
      />,
    )
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })
})
