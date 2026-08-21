/**
 * The memory settings card: the six memory-lifecycle knobs plus the read-only
 * global vault directory. Owns its chrome and its staged form (bundle purity
 * forbids importing the settings section's card shell): edits stage locally,
 * Save commits through the revision-fenced scope, Discard drops the stage.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemorySettingsCardInjected } from '../contract/slots.ts'
import type { MemorySettingsCardState } from './settings-card-controller.ts'
import css from './MemorySettingsCard.module.css'

/** Props the renderer binds for the card entry. */
export type MemorySettingsCardProps =
  & PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.memory'>
  & InjectFace<MemorySettingsCardInjected>

/** One numeric field row: label, hint, input, and the invalid/reset affordances. */
function NumberField(props: {
  id: string
  label: string
  hint: string
  field: MemorySettingsCardState['fields']['minTurnChars']
  disabled: boolean
  onChange: (text: string) => void
  invalidLabel: string
  overriddenLabel: string
}) {
  const { id, label, hint, field, disabled, onChange, invalidLabel, overriddenLabel } = props
  return (
    <div className={css.field}>
      <label className={css.fieldHead} htmlFor={id}>
        <span className={css.fieldLabel}>{label}</span>
        <span className={css.fieldHint}>{hint}</span>
        {field.overridden && <span className={css.overridden}>{overriddenLabel}</span>}
      </label>
      <div className={css.fieldRow}>
        <input
          id={id}
          className={css.input}
          type="text"
          inputMode="numeric"
          value={field.text}
          aria-invalid={field.invalid || undefined}
          disabled={disabled}
          onChange={(event) => { onChange(event.target.value) }}
        />
        {field.invalid && <span className={css.invalid}>{invalidLabel}</span>}
      </div>
    </div>
  )
}

/**
 * Render the card.
 * @param props - locale copy, the card snapshot, and its staged-form actions.
 * @returns the card.
 */
export function MemorySettingsCard(props: MemorySettingsCardProps) {
  const { t } = props
  const state = props.useMemorySettingsCard(snapshot => snapshot)
  const disabled = !state.writable

  const globalDir = state.globalDir.kind === 'dir'
    ? state.globalDir.dir
    : state.globalDir.kind === 'loading'
      ? t('globalDir.loading')
      : t('globalDir.unavailable')

  return (
    <section className={css.card}>
      <header className={css.head}>
        <h3 className={css.title}>{t('title')}</h3>
        <p className={css.description}>{t('description')}</p>
      </header>
      <div className={css.toggleRow}>
        <label className={css.toggle}>
          <input
            type="checkbox"
            checked={state.fields.distill.value}
            disabled={disabled}
            onChange={() => { props.toggleDistill() }}
          />
          <span>
            <span className={css.fieldLabel}>{t('distill')}</span>
            <span className={css.fieldHint}>{t('distillHint')}</span>
          </span>
        </label>
        {state.fields.distill.overridden && <span className={css.overridden}>{t('overridden')}</span>}
      </div>
      <div className={css.field}>
        <label className={css.fieldHead} htmlFor="memory-settings-mode">
          <span className={css.fieldLabel}>{t('distillMode')}</span>
          <span className={css.fieldHint}>{t('distillModeHint')}</span>
        </label>
        <select
          id="memory-settings-mode"
          className={css.input}
          value={state.fields.distillMode.value}
          disabled={disabled}
          onChange={(event) => { props.editMode(event.target.value === 'detailed' ? 'detailed' : 'concise') }}
        >
          <option value="concise">{t('distillMode.concise')}</option>
          <option value="detailed">{t('distillMode.detailed')}</option>
        </select>
      </div>
      <NumberField
        id="memory-settings-min-turn"
        label={t('minTurnChars')}
        hint={t('minTurnCharsHint')}
        field={state.fields.minTurnChars}
        disabled={disabled}
        onChange={(text) => { props.editNumber('minTurnChars', text) }}
        invalidLabel={t('invalidNumber')}
        overriddenLabel={t('overridden')}
      />
      <NumberField
        id="memory-settings-max-inject"
        label={t('maxInjectBytes')}
        hint={t('maxInjectBytesHint')}
        field={state.fields.maxInjectBytes}
        disabled={disabled}
        onChange={(text) => { props.editNumber('maxInjectBytes', text) }}
        invalidLabel={t('invalidNumber')}
        overriddenLabel={t('overridden')}
      />
      <NumberField
        id="memory-settings-max-review"
        label={t('maxReviewCandidates')}
        hint={t('maxReviewCandidatesHint')}
        field={state.fields.maxReviewCandidates}
        disabled={disabled}
        onChange={(text) => { props.editNumber('maxReviewCandidates', text) }}
        invalidLabel={t('invalidNumber')}
        overriddenLabel={t('overridden')}
      />
      <NumberField
        id="memory-settings-review-days"
        label={t('reviewAfterDays')}
        hint={t('reviewAfterDaysHint')}
        field={state.fields.reviewAfterDays}
        disabled={disabled}
        onChange={(text) => { props.editNumber('reviewAfterDays', text) }}
        invalidLabel={t('invalidNumber')}
        overriddenLabel={t('overridden')}
      />
      <div className={css.field}>
        <span className={css.fieldHead}>
          <span className={css.fieldLabel}>{t('globalDir')}</span>
        </span>
        <span className={css.dir}>{globalDir}</span>
      </div>
      {(state.dirty || state.saving || state.saved || state.error !== null) && (
        <footer className={css.actions}>
          {state.error !== null && <span className={css.invalid}>{t('saveFailed')}: {state.error}</span>}
          {state.saved && !state.saving && state.error === null && <span className={css.saved}>{t('saved')}</span>}
          <span className={css.spacer} />
          <Button variant="ghost" size="sm" disabled={!state.dirty || state.saving} onClick={props.discard}>{t('discard')}</Button>
          <Button variant="primary" size="sm" disabled={!state.dirty || state.saving} onClick={() => { void props.save() }}>{t('save')}</Button>
        </footer>
      )}
    </section>
  )
}
