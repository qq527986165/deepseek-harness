/** The sidebar foot action that opens the memory panel. */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { createMemoryPanelStore } from '../stores.ts'

/** Props the renderer binds for the foot action. */
export type MemoryFooterActionProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createMemoryPanelStore>>
  & PropsLocale<'memory'>

/**
 * Render the foot action: icon-only on the rail, icon plus label when wide.
 * @param props - the sidebar's wide state, the shared panel store, and copy.
 * @returns the action button.
 */
export function MemoryFooterAction(props: MemoryFooterActionProps) {
  const { wide, useStore, actions, t } = props
  const open = useStore(s => s.open)
  return (
    <Button
      variant="ghost"
      size="md"
      icon={<IconDataOutline16 />}
      aria-label={t('action.open')}
      title={t('action.open')}
      aria-pressed={open}
      onClick={() => { actions.openPanel() }}
    >
      {wide ? t('action.open.label') : null}
    </Button>
  )
}
