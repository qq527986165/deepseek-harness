/**
 * The `memory-review` Chat node: candidate cards with per-card accept/reject
 * and panel-jump chips, an accept-all shortcut, and one explicit confirm that
 * settles the whole review through `memoryReview.decide`. Pure presentation:
 * staging lives in local state, partition math in review-flow.ts, and every
 * business call rides the injected decide/openCandidate callbacks. The
 * settlement arrives as `memory/review-decided` through the session stream and
 * flips the node into its settled marks.
 * @module @deepseek-ai/dsh-client-ui-memory/client/review/MemoryReviewNode
 */
import { useState } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryReviewCandidate } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { MemoryReviewInjected } from '../contract/slots.ts'
import { failureKeyOf, stagedPartition, type ReviewStaging } from './review-flow.ts'
import css from './MemoryReviewNode.module.css'

/** Complete keyed Chat renderer props. */
export type MemoryReviewNodeProps =
  & PropsRuntime<'conversation.chat.node', 'memory-review'>
  & PropsLocale<'memory'>
  & MemoryReviewInjected

/** One candidate's per-card staging mark or settled outcome. */
type CandidateMark = 'staged-accept' | 'staged-reject' | 'settled-accept' | 'settled-reject'

/** Resolve one candidate's displayed mark from the staging and the settlement. */
function markOf(
  candidate: MemoryReviewCandidate,
  staging: ReviewStaging,
  settledAcceptedIds: ReadonlySet<string> | null,
): CandidateMark | null {
  if (settledAcceptedIds !== null) {
    return settledAcceptedIds.has(String(candidate.id)) ? 'settled-accept' : 'settled-reject'
  }
  const staged = staging.get(String(candidate.id))
  if (staged === undefined) return null
  return staged ? 'staged-accept' : 'staged-reject'
}

/** One candidate card: title, snippet, reason, and its decision/jump chips. */
function CandidateCard(props: {
  candidate: MemoryReviewCandidate
  mark: CandidateMark | null
  onAccept: () => void
  onReject: () => void
  onOpen: () => void
  t: MemoryReviewNodeProps['t']
}) {
  const { candidate, mark, onAccept, onReject, onOpen, t } = props
  const settled = mark === 'settled-accept' || mark === 'settled-reject'
  return (
    <li className={css.card} data-candidate data-mark={mark ?? 'open'}>
      <div className={css.cardTitleRow}>
        <span className={css.cardTitle}>{candidate.title}</span>
        {mark === 'settled-accept' && <Pill className={css.cardMark}>{t('review.accepted')}</Pill>}
        {mark === 'settled-reject' && <Pill className={css.cardMark}>{t('review.rejected')}</Pill>}
      </div>
      <p className={css.cardSnippet}>{candidate.snippet}</p>
      <p className={css.cardReason}>{candidate.reason}</p>
      {!settled && (
        <div className={css.cardActions}>
          <Pill active={mark === 'staged-accept'} onClick={onAccept}>{t('review.accept')}</Pill>
          <Pill active={mark === 'staged-reject'} onClick={onReject}>{t('review.reject')}</Pill>
          <Pill className={css.cardOpen} onClick={onOpen}>{t('review.open')}</Pill>
        </div>
      )}
    </li>
  )
}

/** Render one `/memory-review` proposal: open cards until settled, then marks. */
export function MemoryReviewNode({ node, sessionId, openCandidate, decide, t }: MemoryReviewNodeProps) {
  const [staging, setStaging] = useState<ReviewStaging>(new Map())
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const { candidates, reviewId, workspaceDir, settled } = node.data
  const open = settled === null

  const stage = (id: string, accepted: boolean): void => {
    setStaging(previous => new Map(previous).set(id, accepted))
    setFailure(null)
  }
  const stageAll = (): void => {
    setStaging(new Map(candidates.map(candidate => [String(candidate.id), true])))
    setFailure(null)
  }
  const submit = async (): Promise<void> => {
    const partition = stagedPartition(candidates, staging)
    /* v8 ignore next -- the confirm button is disabled until stagedPartition is complete, so submit never runs with a null partition. */
    if (partition === null) return
    setSubmitting(true)
    setFailure(null)
    const result = await decide(sessionId, reviewId, partition)
    setSubmitting(false)
    if (!result.ok) {
      setFailure(result.error.message)
      return
    }
    if (!result.value.ok) {
      setFailure(t(failureKeyOf(result.value.error)))
    }
    // Success settles the node through the appended memory/review-decided.
  }

  if (candidates.length === 0) {
    return (
      <section className={css.root} data-memory-review>
        <h3 className={css.title}>{t('review.title')}</h3>
        <p className={css.empty}>{t('review.empty')}</p>
      </section>
    )
  }

  const settledAccepted = settled === null ? null : new Set(settled.accepted.map(item => String(item.id)))
  const complete = stagedPartition(candidates, staging) !== null

  return (
    <section className={css.root} data-memory-review>
      <h3 className={css.title}>
        {t('review.title')}
        {settled !== null && <Pill className={css.settledMark}>{t('review.settled')}</Pill>}
      </h3>
      <ul className={css.cards}>
        {candidates.map(candidate => (
          <CandidateCard
            key={String(candidate.id)}
            candidate={candidate}
            mark={markOf(candidate, staging, settledAccepted)}
            onAccept={() => { stage(String(candidate.id), true) }}
            onReject={() => { stage(String(candidate.id), false) }}
            onOpen={() => { openCandidate({ ref: String(candidate.id), scope: 'project', workspaceDir }) }}
            t={t}
          />
        ))}
      </ul>
      {open && (
        <div className={css.footer}>
          <Pill className={css.acceptAll} onClick={stageAll}>{t('review.acceptAll')}</Pill>
          <Button variant="primary" size="sm" disabled={!complete || submitting} onClick={() => { void submit() }}>
            {submitting ? t('review.submitting') : t('review.confirm')}
          </Button>
        </div>
      )}
      {failure !== null && <p className={css.failure}>{failure}</p>}
    </section>
  )
}
