import * as React from "react"
import { StatusIcon } from "@/components/ai-elements/status-icon"
import { TraceIcon } from "@/components/ui/trace"
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
} from "lucide-react"

import { SmithMark } from "@/components/smith-mark"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { usePauseOffscreen } from "@/hooks/use-pause-offscreen"
import { cn } from "@/lib/utils"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { TitleTooltip } from "@/components/ui/tooltip"
import {
  formatDisplayPath,
  shallowRecordEqual,
} from "@/features/smith/app-shell-common"
import type { AppShellDisplaySettingsState } from "@/features/smith/app-shell-types"
import {
  AWAITING_FIRST_RESPONSE_WORKING_LABEL,
  COMPACT_WORKING_LABEL,
  type AppShellWorkingState,
} from "@/features/smith/app-shell-working-state"
import { conversationShowsActivity } from "@/features/smith/conversation-activity"
import { DraftGitStatusBadge } from "@/features/smith/right-sidebar-git-header-actions"
import {
  conversationNavShortcut,
  formatShortcutLabel,
} from "@/features/smith/keyboard-shortcuts"
import {
  AssistantMessagesStoreCard,
  UserMessageCard,
} from "@/features/smith/conversation-view"
import {
  assistantMessagesSnapshotFromStore,
  createConversationItemsStore,
  createMutableAssistantMessagesStore,
  useConversationGroupDescriptors,
  useConversationHasAssistantOutput,
  useConversationHasMessages,
  useConversationItem,
  usePendingCompactionRow,
  type ConversationItemsStore,
  type MutableAssistantMessagesStore,
  type RenderConversationGroupDescriptor,
} from "@/features/smith/app-shell-conversation-store"
import {
  useAppShellMessageScroll,
  useMessageJumpValue,
  type MessageJumpStateStore,
} from "@/features/smith/use-app-shell-message-scroll"
import { smithAgentScopeKey } from "@/features/smith/query-keys"
import { useMachineFeature } from "@/features/smith/machine-store"
import {
  historyGapCount,
  type HistoryLoadKind,
} from "@/features/smith/conversation-history-window"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller"
import {
  useSelector,
  type SmithStore,
} from "@/features/smith/tanstack-store-utils"
import type { AgentState } from "@/lib/smith"
import { parseAgentNotice } from "@/lib/smith/agent-notice"

export type AppShellConversationFrameHandle = {
  jumpToNextMessage: () => void
  jumpToPreviousMessage: () => void
  scrollConversationToBottom: () => void
  scrollConversationToTop: () => void
}

function ConversationLatestMessageButton({
  conversationItemsStore,
  draft,
  onClick,
  streaming,
}: {
  conversationItemsStore: ConversationItemsStore
  draft: boolean
  onClick: () => void
  streaming: boolean
}) {
  const hasMessages = useConversationHasMessages(conversationItemsStore)
  const scrollable = useMessageScrollerScrollable()
  const isDisabled = draft || !hasMessages || !scrollable.end
  // The turn can stream below the view. A ring on the button shows that
  // there is live output out of view.
  const showStreaming = streaming && !isDisabled
  const label = showStreaming
    ? "Jump to latest message, response is streaming"
    : "Jump to latest message"

  return (
    <TitleTooltip
      title="Jump to latest message"
      kbd={formatShortcutLabel(conversationNavShortcut("ArrowDown"))}
    >
      <Button
        variant="outline"
        size="icon"
        disabled={isDisabled}
        className="pointer-events-auto relative rounded-full bg-secondary text-secondary-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-0 dark:bg-secondary dark:hover:bg-accent"
        aria-label={label}
        onClick={onClick}
      >
        <ArrowDownIcon className="size-4" />
        {showStreaming ? (
          <Spinner
            role="presentation"
            aria-hidden="true"
            aria-label={undefined}
            strokeWidth={1.5}
            className="absolute -inset-px size-[calc(100%+2px)]"
          />
        ) : null}
      </Button>
    </TitleTooltip>
  )
}

function ConversationFirstMessageButton({
  canLoadFirst,
  conversationItemsStore,
  draft,
  loading,
  onClick,
}: {
  /** The first message is not loaded, and a click loads it. */
  canLoadFirst: boolean
  conversationItemsStore: ConversationItemsStore
  draft: boolean
  loading: boolean
  onClick: () => void
}) {
  const hasMessages = useConversationHasMessages(conversationItemsStore)
  const scrollable = useMessageScrollerScrollable()
  const isDisabled =
    draft || !hasMessages || (!scrollable.start && !canLoadFirst)

  return (
    <TitleTooltip
      title="Jump to first message"
      kbd={formatShortcutLabel(conversationNavShortcut("ArrowUp"))}
    >
      <Button
        variant="outline"
        size="icon"
        disabled={isDisabled}
        className="pointer-events-auto relative rounded-full bg-secondary text-secondary-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-0 dark:bg-secondary dark:hover:bg-accent"
        aria-label={
          loading ? "Jump to first message, loading" : "Jump to first message"
        }
        aria-busy={loading || undefined}
        onClick={onClick}
      >
        <ArrowUpIcon className="size-4" />
        {loading ? (
          <Spinner
            role="presentation"
            aria-hidden="true"
            aria-label={undefined}
            strokeWidth={1.5}
            className="absolute -inset-px size-[calc(100%+2px)]"
          />
        ) : null}
      </Button>
    </TitleTooltip>
  )
}

function ConversationMessageJumpButton({
  direction,
  jumpStateStore,
  onClick,
}: {
  direction: "next" | "previous"
  jumpStateStore: MessageJumpStateStore
  onClick: () => void
}) {
  const isDisabled = useMessageJumpValue(jumpStateStore, (snapshot) =>
    direction === "next"
      ? !snapshot.hasNextMessageJumpTarget
      : !snapshot.hasPreviousMessageJumpTarget
  )
  const label =
    direction === "next"
      ? "Jump to your next message"
      : "Jump to your previous message"
  const Icon = direction === "next" ? ArrowDownToLineIcon : ArrowUpToLineIcon

  return (
    <TitleTooltip
      title={label}
      kbd={formatShortcutLabel(
        conversationNavShortcut(
          direction === "next" ? "ArrowRight" : "ArrowLeft"
        )
      )}
    >
      <Button
        variant="outline"
        size="icon"
        disabled={isDisabled}
        className="pointer-events-auto rounded-full bg-secondary text-secondary-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-0 dark:bg-secondary dark:hover:bg-accent"
        aria-label={label}
        onClick={onClick}
      >
        <Icon className="size-4" />
      </Button>
    </TitleTooltip>
  )
}

// The buttons sit in a column at the bottom right: first, previous, next,
// latest. A hidden button keeps its space, so the buttons do not move.
// With centered messages, the column is 6rem wider than the text column
// (two buttons of 2.25rem and two gaps of 0.75rem). When the pane is wide
// enough, the buttons sit next to the text, not on it.
function ConversationJumpButtons({
  canLoadFirst,
  centerMessages,
  conversationItemsStore,
  draft,
  firstLoading,
  jumpStateStore,
  onFirst,
  onLatest,
  onNext,
  onPrevious,
  streaming,
}: {
  canLoadFirst: boolean
  centerMessages: boolean
  conversationItemsStore: ConversationItemsStore
  draft: boolean
  firstLoading: boolean
  jumpStateStore: MessageJumpStateStore
  onFirst: () => void
  onLatest: () => void
  onNext: () => void
  onPrevious: () => void
  streaming: boolean
}) {
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-10 md:inset-x-[18px] md:bottom-[18px]">
      <div
        className={cn(
          "flex flex-col items-end gap-2",
          centerMessages && "mx-auto w-full max-w-[calc(80ch+6rem)]"
        )}
      >
        <ConversationFirstMessageButton
          canLoadFirst={canLoadFirst}
          conversationItemsStore={conversationItemsStore}
          draft={draft}
          loading={firstLoading}
          onClick={onFirst}
        />
        <ConversationMessageJumpButton
          direction="previous"
          jumpStateStore={jumpStateStore}
          onClick={onPrevious}
        />
        <ConversationMessageJumpButton
          direction="next"
          jumpStateStore={jumpStateStore}
          onClick={onNext}
        />
        <ConversationLatestMessageButton
          conversationItemsStore={conversationItemsStore}
          draft={draft}
          onClick={onLatest}
          streaming={streaming}
        />
      </div>
    </div>
  )
}

type AppShellConversationAgentState = Pick<
  AgentState,
  | "cwd"
  | "draft"
  | "historyOffset"
  | "historyTotalCount"
  | "agentFile"
  | "agentId"
  | "streaming"
> & {
  /** The number of items in the head; see `conversation-history-window.ts`. */
  headCount: number
}

function useAppShellConversationAgentState(store: SmithStore<AgentState>) {
  return useSelector(
    store,
    (agentState) => ({
      cwd: agentState.cwd,
      draft: agentState.draft,
      historyOffset: agentState.historyOffset,
      historyTotalCount: agentState.historyTotalCount,
      agentFile: agentState.agentFile,
      agentId: agentState.agentId,
      streaming: agentState.streaming,
      headCount: agentState.headItems.length,
    }),
    { compare: shallowRecordEqual }
  )
}

const HISTORY_AUTOLOAD_THRESHOLD_PX = 48

// This row sits above the scroller content, not inside it. The first message
// row then stays the first item, so the scroller keeps the reader in place
// when older messages are prepended.
function ConversationEarlierMessages({
  isLoading,
  onLoad,
  viewport,
}: {
  isLoading: boolean
  onLoad: () => Promise<void>
  viewport: HTMLDivElement | null
}) {
  const scrollable = useMessageScrollerScrollable()
  const load = () => {
    if (isLoading) return
    void onLoad()
  }

  React.useEffect(() => {
    if (!viewport || isLoading || scrollable.start) return
    if (viewport.scrollTop > HISTORY_AUTOLOAD_THRESHOLD_PX) return
    load()
  }, [isLoading, load, scrollable.start, viewport])

  return (
    <div className="flex justify-center py-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isLoading}
        onClick={load}
      >
        {isLoading ? <Spinner /> : null}
        {isLoading ? "Loading earlier messages…" : "Load earlier messages"}
      </Button>
    </div>
  )
}

/** How far outside the view the gap row starts to load. */
const HISTORY_GAP_AUTOLOAD_MARGIN_PX = 300

/**
 * The row between the head and the tail of a long conversation. When it
 * comes into view, it loads a page on the side that the reader comes from:
 * below the middle of the view (the reader scrolls down through the head)
 * the next page of the head, which goes in below the view; above the middle
 * (the reader scrolls up from the tail) an older page of the tail, which
 * the scroller keeps the reader in place for. After each page it looks
 * again, so it loads until it leaves the view.
 */
function ConversationHistoryGap({
  centerMessages,
  count,
  historyLoad,
  onLoadHistory,
  viewport,
}: {
  centerMessages: boolean
  count: number
  historyLoad: HistoryLoadKind | null
  onLoadHistory: (kind: HistoryLoadKind) => Promise<boolean>
  viewport: HTMLDivElement | null
}) {
  const rowRef = React.useRef<HTMLDivElement | null>(null)
  const busy = historyLoad !== null
  const latestRef = React.useRef({ busy, onLoadHistory })
  React.useLayoutEffect(() => {
    latestRef.current = { busy, onLoadHistory }
  })
  const checkRef = React.useRef<() => void>(() => {})

  React.useEffect(() => {
    const row = rowRef.current
    if (!row || !viewport || typeof IntersectionObserver === "undefined") {
      return
    }
    // Measure, not the observer's last entry: after a page, the effect
    // below runs before the observer reports the row's new place.
    const check = () => {
      if (latestRef.current.busy) return
      const rowRect = row.getBoundingClientRect()
      const viewRect = viewport.getBoundingClientRect()
      const margin = HISTORY_GAP_AUTOLOAD_MARGIN_PX
      if (
        rowRect.bottom < viewRect.top - margin ||
        rowRect.top > viewRect.bottom + margin
      ) {
        return
      }
      const below =
        rowRect.top + rowRect.height / 2 >= viewRect.top + viewRect.height / 2
      void latestRef.current.onLoadHistory(below ? "forward" : "older")
    }
    checkRef.current = check
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) check()
      },
      {
        root: viewport,
        rootMargin: `${HISTORY_GAP_AUTOLOAD_MARGIN_PX}px 0px`,
      }
    )
    observer.observe(row)
    return () => {
      observer.disconnect()
      checkRef.current = () => {}
    }
  }, [viewport])

  // Look again after a page, in a frame: the head rows of the page render
  // after this effect.
  React.useEffect(() => {
    if (busy) return
    const frame = window.requestAnimationFrame(() => checkRef.current())
    return () => window.cancelAnimationFrame(frame)
  }, [busy])

  return (
    <div
      ref={rowRef}
      data-conversation-history-gap="true"
      className={cn(
        "flex items-center justify-center gap-1 pt-4 text-sm text-muted-foreground",
        centerMessages && "mx-auto w-full max-w-[80ch]"
      )}
    >
      <span>
        {count.toLocaleString()} earlier {count === 1 ? "message" : "messages"}
      </span>
      <span aria-hidden="true">·</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void onLoadHistory("forward")}
      >
        {busy ? <Spinner /> : null}
        {busy ? "Loading…" : "Load"}
      </Button>
    </div>
  )
}

type AppShellConversationFrameProps = {
  autoScrollEnabled: boolean
  centerMessages: boolean
  children: React.ReactNode
  conversationItemsStore: ConversationItemsStore
  emptyState: React.ReactNode
  /** The rows of the head, above the scroller content. */
  head: React.ReactNode
  historyLoad: HistoryLoadKind | null
  isAgentViewLoading: boolean
  onLoadHistory: (kind: HistoryLoadKind) => Promise<boolean>
  ref?: React.Ref<AppShellConversationFrameHandle>
  agentState: AppShellConversationAgentState
  viewportElementRef?: React.RefObject<HTMLElement | null>
}

/**
 * Keep the scroll position of the conversation while the app shell of this
 * machine is hidden (see `routes/index.tsx`). A hidden shell gets
 * `display: none`, which loses the position. When the shell shows again,
 * the message scroller sees its viewport grow from zero and scrolls to the
 * end in an animation frame from its resize observer. Its observer starts
 * in a passive effect of a child. This observer starts in a passive effect
 * of the parent, so its callback and its animation frame come later: this
 * restore wins. The observer stops after a short time.
 */
function usePreservedScrollWhileHidden(
  elementRef: React.RefObject<HTMLElement | null>
) {
  const savedRef = React.useRef<{ element: HTMLElement; top: number } | null>(
    null
  )
  React.useLayoutEffect(() => {
    // React attaches the viewport ref again only after this effect, so use
    // the element from the hide. It is the same element when it is still in
    // the document.
    const saved = savedRef.current
    if (saved?.element.isConnected) saved.element.scrollTop = saved.top
    return () => {
      const element = elementRef.current
      savedRef.current = element ? { element, top: element.scrollTop } : null
    }
  }, [elementRef])
  React.useEffect(() => {
    const saved = savedRef.current
    if (!saved?.element.isConnected) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        saved.element.scrollTop = saved.top
      })
    })
    observer.observe(saved.element)
    const stop = window.setTimeout(() => observer.disconnect(), 500)
    return () => {
      window.clearTimeout(stop)
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])
}

function AppShellConversationFrame(props: AppShellConversationFrameProps) {
  const viewportElementRef = React.useRef<HTMLElement | null>(null)
  usePreservedScrollWhileHidden(viewportElementRef)
  // Remount the scroller for each agent so the opening position applies
  // again and no follow state leaks between agents.
  // The key also changes when the agent view finishes loading, because
  // the scroller treats rows that arrive later as new turns.
  const agentScrollKey = `${smithAgentScopeKey(props.agentState) || "none"}:${
    props.isAgentViewLoading ? "loading" : "ready"
  }`

  return (
    <MessageScrollerProvider
      key={agentScrollKey}
      autoScroll={props.autoScrollEnabled}
      defaultScrollPosition="end"
      scrollPreviousItemPeek={64}
    >
      <AppShellConversationScroller
        {...props}
        viewportElementRef={viewportElementRef}
      />
    </MessageScrollerProvider>
  )
}

function AppShellConversationScroller({
  children,
  centerMessages,
  conversationItemsStore,
  emptyState,
  head,
  historyLoad,
  isAgentViewLoading,
  onLoadHistory,
  ref,
  agentState,
  viewportElementRef,
}: AppShellConversationFrameProps) {
  const {
    jumpStateStore,
    jumpToNextMessage,
    jumpToPreviousMessage,
    scrollConversationToBottom,
    scrollConversationToTop,
    setViewport,
    stopScrollMomentum,
    viewport,
  } = useAppShellMessageScroll()
  const canLoadHistoryHead = useMachineFeature("conversation-history-after")
  const canLoadFirst =
    canLoadHistoryHead &&
    !agentState.draft &&
    agentState.historyOffset > 0 &&
    agentState.headCount === 0
  const gapCount = historyGapCount(
    agentState.headCount,
    agentState.historyOffset
  )

  // A jump to the first message of a long conversation loads the first
  // page (the head) and scrolls to it when it shows. Clicks while it loads
  // do nothing.
  const scrollToTopWhenHeadShowsRef = React.useRef(false)
  const jumpToFirstMessage = () => {
    if (!canLoadFirst) {
      scrollConversationToTop()
      return
    }
    if (scrollToTopWhenHeadShowsRef.current) return
    stopScrollMomentum()
    scrollToTopWhenHeadShowsRef.current = true
    void onLoadHistory("first").then((applied) => {
      if (applied || !scrollToTopWhenHeadShowsRef.current) return
      // The page did not load: scroll to the top of what is loaded.
      scrollToTopWhenHeadShowsRef.current = false
      scrollConversationToTop()
    })
  }
  const scrollToTopAfterHeadShows = React.useEffectEvent(() => {
    scrollConversationToTop()
  })
  React.useLayoutEffect(() => {
    if (!scrollToTopWhenHeadShowsRef.current || agentState.headCount === 0) {
      return
    }
    scrollToTopWhenHeadShowsRef.current = false
    // The head rows render after this effect, from their store: scroll in
    // the next frame, before it paints.
    window.requestAnimationFrame(() => scrollToTopAfterHeadShows())
  }, [agentState.headCount])

  React.useLayoutEffect(() => {
    if (viewportElementRef) viewportElementRef.current = viewport
  }, [viewport, viewportElementRef])

  React.useImperativeHandle(
    ref,
    () => ({
      jumpToNextMessage,
      jumpToPreviousMessage,
      scrollConversationToBottom,
      scrollConversationToTop: jumpToFirstMessage,
    }),
    [
      jumpToNextMessage,
      jumpToPreviousMessage,
      scrollConversationToBottom,
      jumpToFirstMessage,
    ]
  )

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport
        ref={setViewport}
        data-conversation-viewport="true"
        aria-label="Conversation messages"
        // Without centered messages, the text fills the width. The right
        // padding keeps it clear of the jump buttons: inset, button width,
        // and a gap of 0.75rem.
        className={cn(
          "overflow-x-hidden px-9 outline-none",
          !centerMessages && "pr-16 md:pr-[66px]"
        )}
      >
        {isAgentViewLoading || agentState.headCount === 0 ? null : head}
        {isAgentViewLoading ? null : gapCount > 0 ? (
          <ConversationHistoryGap
            centerMessages={centerMessages}
            count={gapCount}
            historyLoad={historyLoad}
            onLoadHistory={onLoadHistory}
            viewport={viewport}
          />
        ) : agentState.historyOffset > 0 && agentState.headCount === 0 ? (
          <ConversationEarlierMessages
            isLoading={historyLoad !== null}
            onLoad={async () => {
              await onLoadHistory("older")
            }}
            viewport={viewport}
          />
        ) : null}
        <MessageScrollerContent
          aria-busy={agentState.streaming}
          className="gap-4 py-4"
        >
          {isAgentViewLoading ? null : children}
        </MessageScrollerContent>
      </MessageScrollerViewport>

      {emptyState}

      {!isAgentViewLoading ? (
        <ConversationJumpButtons
          canLoadFirst={canLoadFirst}
          centerMessages={centerMessages}
          conversationItemsStore={conversationItemsStore}
          draft={agentState.draft}
          firstLoading={historyLoad === "first"}
          jumpStateStore={jumpStateStore}
          onFirst={jumpToFirstMessage}
          onLatest={scrollConversationToBottom}
          onNext={jumpToNextMessage}
          onPrevious={jumpToPreviousMessage}
          streaming={agentState.streaming}
        />
      ) : null}
    </MessageScroller>
  )
}

function AppShellWorkingIndicatorLabel({ label }: { label: string }) {
  // Out of view (a reply that grows below the bottom), the shimmer pauses.
  const pauseRef = usePauseOffscreen<HTMLDivElement>(Boolean(label.trim()))
  if (!label.trim()) {
    return (
      <div aria-hidden="true" className="invisible leading-5 font-medium">
        Working…
      </div>
    )
  }

  // The shimmer of AI Elements (https://ui.shadcn.com/docs/utils/shimmer)
  // shows that the agent works.
  return (
    <div
      ref={pauseRef}
      className="shimmer leading-5 font-medium text-foreground"
    >
      {label}
    </div>
  )
}

function AppShellMessagesWorkingIndicator({
  onCancel,
  state,
}: {
  onCancel?: () => void
  state: AppShellWorkingState
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex w-full items-start gap-2 text-sm text-muted-foreground"
    >
      {/* The same icon, size, and spacing as the lines of the agent's work
          (Trace and its status icon), so the two line up. */}
      <TraceIcon
        className={cn(
          "mt-0.5",
          state.done && "text-emerald-600",
          state.error && "text-destructive"
        )}
      >
        <StatusIcon
          status={state.done ? undefined : state.error ? "error" : "running"}
        />
      </TraceIcon>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-5 min-w-0 items-center justify-start gap-2">
          <div className="min-w-0 shrink-0">
            {state.done ? (
              <div className="font-medium text-foreground">Done</div>
            ) : state.error ? (
              <div className="font-medium text-destructive">{state.label}</div>
            ) : (
              <AppShellWorkingIndicatorLabel label={state.label} />
            )}
          </div>
          {state.cancelable && !state.done && !state.error && onCancel ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1.5 text-xs"
              onClick={onCancel}
            >
              Cancel
              <Kbd>Esc</Kbd>
            </Button>
          ) : null}
        </div>
        {state.summary ? (
          <div className="truncate text-muted-foreground">{state.summary}</div>
        ) : null}
      </div>
    </div>
  )
}

// The head rows sit above the scroller content (see `ConversationHistoryHead`),
// so they are plain elements: the scroller must not see them as its rows.
const ConversationPlainRowsContext = React.createContext(false)

function ConversationRow({
  children,
  className,
  messageId,
  scrollAnchor,
}: {
  children: React.ReactNode
  className: string
  messageId: string
  scrollAnchor?: boolean
}) {
  const plain = React.useContext(ConversationPlainRowsContext)
  if (plain) {
    return <div className={cn("min-w-0 shrink-0", className)}>{children}</div>
  }
  return (
    <MessageScrollerItem
      messageId={messageId}
      scrollAnchor={scrollAnchor}
      className={className}
    >
      {children}
    </MessageScrollerItem>
  )
}

// Paint containment from content-visibility clips list markers and other
// content that overflows the row, so rows stay fully painted.
// The working footer can share the last row, so rows stack with a gap.
const conversationItemClassName =
  "flex flex-col gap-4 [content-visibility:visible]"

function ConversationGroupView({
  className,
  group,
  hideFooter,
  hideThinking,
  hideToolBlocks,
  messageId,
  store,
  workingFooter,
}: {
  className: string
  group: RenderConversationGroupDescriptor
  hideFooter: boolean
  hideThinking: boolean
  hideToolBlocks: boolean
  messageId: string
  store: ConversationItemsStore
  workingFooter?: React.ReactNode
}) {
  if (group.kind === "compaction") {
    // The pending row and the summary row share this element, so keep the
    // same element type at the root for both.
    return (
      <ConversationRow
        messageId={messageId}
        scrollAnchor
        className={conversationItemClassName}
      >
        {group.pending ? null : (
          <ConversationAssistantGroupView
            className={className}
            groupKey={group.key}
            hideFooter={hideFooter}
            hideThinking={hideThinking}
            hideToolBlocks={hideToolBlocks}
            store={store}
          />
        )}
        {workingFooter}
      </ConversationRow>
    )
  }

  if (group.kind === "question") {
    return (
      <ConversationQuestionGroupRow
        className={className}
        groupKey={group.key}
        hidden={group.hidden}
        hideThinking={hideThinking}
        hideToolBlocks={hideToolBlocks}
        messageId={messageId}
        store={store}
        workingFooter={workingFooter}
      />
    )
  }

  if (group.kind === "user") {
    return (
      <ConversationUserGroupRow
        className={className}
        itemKey={group.itemKey}
        messageId={messageId}
        store={store}
        workingFooter={workingFooter}
      />
    )
  }

  return (
    <ConversationRow
      messageId={messageId}
      className={cn(
        conversationItemClassName,
        // A hidden row has no gap: it stays only so that the question row
        // after it is a new row for the scroller.
        group.hidden && !workingFooter && "hidden"
      )}
    >
      <ConversationAssistantGroupView
        className={className}
        groupKey={group.key}
        hideFooter={hideFooter}
        hideThinking={hideThinking}
        hideToolBlocks={hideToolBlocks}
        store={store}
      />
      {workingFooter}
    </ConversationRow>
  )
}

/**
 * An answered question. The answer is a turn of the user, so the row is a
 * scroll anchor and a target of the jumps between messages, like a user
 * message. When the tool blocks are hidden, the row shows nothing.
 */
function ConversationQuestionGroupRow({
  className,
  groupKey,
  hidden,
  hideThinking,
  hideToolBlocks,
  messageId,
  store,
  workingFooter,
}: {
  className: string
  groupKey: string
  hidden: boolean
  hideThinking: boolean
  hideToolBlocks: boolean
  messageId: string
  store: ConversationItemsStore
  workingFooter?: React.ReactNode
}) {
  return (
    <ConversationRow
      messageId={messageId}
      scrollAnchor={!hidden}
      className={cn(
        conversationItemClassName,
        hidden && !workingFooter && "hidden"
      )}
    >
      <div data-user-message-anchor={hidden ? undefined : "true"}>
        <ConversationAssistantGroupView
          className={className}
          groupKey={groupKey}
          hideFooter
          hideThinking={hideThinking}
          hideToolBlocks={hideToolBlocks}
          store={store}
        />
      </div>
      {workingFooter}
    </ConversationRow>
  )
}

/**
 * A user message is a scroll anchor: when the user sends it, the view
 * scrolls it to the top. A notice of an agent or a job is not, so it does
 * not move the view. The jumps between messages skip notices too.
 */
function ConversationUserGroupRow({
  className,
  itemKey,
  messageId,
  store,
  workingFooter,
}: {
  className: string
  itemKey: string
  messageId: string
  store: ConversationItemsStore
  workingFooter?: React.ReactNode
}) {
  const item = useConversationItem(store, itemKey)
  const userItem = item?.kind === "user" ? item : undefined
  const notice = Boolean(
    userItem && userItem.images.length === 0 && parseAgentNotice(userItem.text)
  )
  return (
    <ConversationRow
      messageId={messageId}
      scrollAnchor={!notice}
      className={conversationItemClassName}
    >
      {userItem ? (
        <div
          data-user-message-anchor={notice ? undefined : "true"}
          className={className}
        >
          <UserMessageCard item={userItem} />
        </div>
      ) : null}
      {workingFooter}
    </ConversationRow>
  )
}

function useConversationGroupParts(
  store: ConversationItemsStore,
  groupKey: string
) {
  return React.useSyncExternalStore(
    (listener) => store.subscribeGroupParts(groupKey, listener),
    () => store.getGroupParts(groupKey),
    () => store.getGroupParts(groupKey)
  )
}

function ConversationAssistantGroupView({
  className,
  groupKey,
  hideFooter,
  hideThinking,
  hideToolBlocks,
  store,
}: {
  className: string
  groupKey: string
  hideFooter: boolean
  hideThinking: boolean
  hideToolBlocks: boolean
  store: ConversationItemsStore
}) {
  const parts = useConversationGroupParts(store, groupKey)
  const [assistantMessagesStore] =
    React.useState<MutableAssistantMessagesStore>(() =>
      createMutableAssistantMessagesStore(
        assistantMessagesSnapshotFromStore({
          hideThinking,
          hideToolBlocks,
          parts,
          store,
        })
      )
    )

  React.useLayoutEffect(() => {
    const updateSnapshot = () => {
      assistantMessagesStore.setSnapshot(
        assistantMessagesSnapshotFromStore({
          hideThinking,
          hideToolBlocks,
          parts,
          store,
        })
      )
    }

    updateSnapshot()
    return store.subscribeItems(
      parts.map((part) => part.itemKey),
      updateSnapshot
    )
  }, [assistantMessagesStore, hideThinking, hideToolBlocks, parts, store])

  return (
    <AssistantMessagesStoreCard
      className={className}
      hideFooter={hideFooter}
      store={assistantMessagesStore}
    />
  )
}

function AppShellConversationItemGroups({
  centerMessages,
  compacting,
  conversationItemsStore,
  hideFooter,
  hideThinking,
  hideToolBlocks,
  streaming,
  workingFooter,
}: {
  centerMessages: boolean
  compacting: boolean
  conversationItemsStore: ConversationItemsStore
  hideFooter: boolean
  hideThinking: boolean
  hideToolBlocks: boolean
  streaming: boolean
  workingFooter: React.ReactNode
}) {
  const conversationMessageColumnClassName = centerMessages
    ? "mx-auto w-full max-w-[80ch]"
    : "w-full"
  const conversationGroups = useConversationGroupDescriptors({
    store: conversationItemsStore,
    hideFooter,
    hideThinking,
    hideToolBlocks,
  })
  const { groups: renderedConversationGroups, rowKey } =
    usePendingCompactionRow(conversationGroups, compacting, streaming)

  if (renderedConversationGroups.length === 0) {
    return (
      <MessageScrollerItem
        messageId="working-footer"
        className={conversationItemClassName}
      >
        {workingFooter}
      </MessageScrollerItem>
    )
  }

  const lastGroupIndex = renderedConversationGroups.length - 1

  // The working footer renders inside the last row, not as a row of its own.
  // The scroller looks for a new turn only after the rows it already knows,
  // so a footer row at the end would hide the new user message from it.
  return (
    <>
      {renderedConversationGroups.map((group, index) => (
        <ConversationGroupView
          key={rowKey(group)}
          className={conversationMessageColumnClassName}
          group={group}
          hideFooter={hideFooter}
          hideThinking={hideThinking}
          hideToolBlocks={hideToolBlocks}
          messageId={rowKey(group)}
          store={conversationItemsStore}
          workingFooter={index === lastGroupIndex ? workingFooter : null}
        />
      ))}
    </>
  )
}

/**
 * The first items of a long conversation, after a jump to the first
 * message. They sit above the scroller content, like the "Load earlier
 * messages" row: the scroller looks for new turns in the rows that come
 * after the rows it knows, and keeps the reader in place only when rows
 * come before its first row. Head rows that go in above the gap are neither.
 */
function ConversationHistoryHead({
  centerMessages,
  hideThinking,
  hideToolBlocks,
  store,
}: {
  centerMessages: boolean
  hideThinking: boolean
  hideToolBlocks: boolean
  store: ConversationItemsStore
}) {
  const groups = useConversationGroupDescriptors({
    store,
    hideFooter: false,
    hideThinking,
    hideToolBlocks,
  })
  if (groups.length === 0) return null
  const columnClassName = centerMessages
    ? "mx-auto w-full max-w-[80ch]"
    : "w-full"

  return (
    <ConversationPlainRowsContext value>
      <div
        data-conversation-history-head="true"
        className="flex flex-col gap-4 pt-4"
      >
        {groups.map((group) => (
          <ConversationGroupView
            key={group.key}
            className={columnClassName}
            group={group}
            hideFooter={false}
            hideThinking={hideThinking}
            hideToolBlocks={hideToolBlocks}
            messageId={group.key}
            store={store}
          />
        ))}
      </div>
    </ConversationPlainRowsContext>
  )
}

function AppShellConversationEmptyState({
  awaitingFirstTurn,
  conversationItemsStore,
  draft,
  cwd,
  isAgentViewLoading,
  isSubmitting,
  onCreateAgent,
  streaming,
  viewerContextId,
  workingStateStore,
}: {
  awaitingFirstTurn: boolean
  conversationItemsStore: ConversationItemsStore
  draft: boolean
  cwd?: string
  isAgentViewLoading: boolean
  isSubmitting: boolean
  onCreateAgent: () => void
  streaming: boolean
  viewerContextId: string
  workingStateStore: SmithStore<AppShellWorkingState | null>
}) {
  const hasMessages = useConversationHasMessages(conversationItemsStore)
  const hasAssistantOutput = useConversationHasAssistantOutput(
    conversationItemsStore
  )
  const workingState = useSelector(workingStateStore)
  const displayedWorkingState =
    workingState ||
    (hasAssistantOutput
      ? {
          label: "Done",
          done: true,
        }
      : null)
  const showConversationLoadingState = Boolean(
    isAgentViewLoading ||
    (!draft &&
      !hasMessages &&
      (isSubmitting ||
        awaitingFirstTurn ||
        streaming ||
        Boolean(displayedWorkingState)))
  )
  const conversationLoadingLabel = isAgentViewLoading
    ? "Loading agent…"
    : displayedWorkingState && !displayedWorkingState.done
      ? displayedWorkingState.label
      : "Loading…"

  if (showConversationLoadingState) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
        <Spinner />
        {conversationLoadingLabel ? (
          <div>{conversationLoadingLabel}</div>
        ) : null}
      </div>
    )
  }

  if (hasMessages) return null

  return (
    <Empty className="absolute inset-0">
      <EmptyHeader>
        <EmptyMedia className="text-muted-foreground">
          <SmithMark className="h-6 w-auto" />
        </EmptyMedia>
        <EmptyTitle>
          {draft ? "New agent" : "Start a new conversation"}
        </EmptyTitle>
        <EmptyDescription>
          {draft
            ? undefined
            : "This is the native Smith agent view backed by the new TypeScript runtime."}
        </EmptyDescription>
      </EmptyHeader>
      {draft ? (
        <EmptyContent className="flex flex-col items-center gap-3">
          {cwd ? (
            <Badge variant="outline">{formatDisplayPath(cwd)}</Badge>
          ) : null}
          <DraftGitStatusBadge viewerContextId={viewerContextId} cwd={cwd} />
        </EmptyContent>
      ) : (
        <EmptyContent>
          <Button onClick={onCreateAgent}>New agent</Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

function AppShellConversationWorkingFooter({
  centerMessages,
  conversationItemsStore,
  onCancelCompaction,
  workingStateStore,
}: {
  centerMessages: boolean
  conversationItemsStore: ConversationItemsStore
  onCancelCompaction: () => void
  workingStateStore: SmithStore<AppShellWorkingState | null>
}) {
  const hasMessages = useConversationHasMessages(conversationItemsStore)
  const showsActivity = React.useSyncExternalStore(
    conversationItemsStore.subscribe,
    () => conversationShowsActivity(conversationItemsStore.getSnapshot().items),
    () => conversationShowsActivity(conversationItemsStore.getSnapshot().items)
  )
  const conversationMessageColumnClassName = centerMessages
    ? "mx-auto w-full max-w-[80ch]"
    : "w-full"
  const workingState = useSelector(workingStateStore)
  // The plain "Working…" line shows only in the gaps, when nothing else in
  // the conversation moves. Compaction, status text, and errors always show.
  const plainWorking =
    !workingState?.error &&
    !workingState?.cancelable &&
    (workingState?.label === "Working…" ||
      workingState?.label === AWAITING_FIRST_RESPONSE_WORKING_LABEL)
  // A gap shows the line only after it lasts a moment, so a short gap
  // between two steps does not make it flash.
  const plainGap = useTrueAfter(
    Boolean(workingState) && plainWorking && !showsActivity,
    WORKING_GAP_DELAY_MS
  )
  const displayedWorkingState =
    workingState && (!plainWorking || plainGap) ? workingState : null

  if (!hasMessages || !displayedWorkingState) return null

  return (
    <div className={conversationMessageColumnClassName}>
      <AppShellMessagesWorkingIndicator
        onCancel={onCancelCompaction}
        state={displayedWorkingState}
      />
    </div>
  )
}

const WORKING_GAP_DELAY_MS = 300

/** `value`, but it turns true only after it was true for `delayMs`. */
function useTrueAfter(value: boolean, delayMs: number) {
  const [settled, setSettled] = React.useState(false)
  React.useEffect(() => {
    if (!value) {
      setSettled(false)
      return
    }
    const timer = window.setTimeout(() => setSettled(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return value && settled
}

function AppShellConversationMessageStack({
  centerMessages,
  conversationItemsStore,
  hideToolBlocks,
  agentStore,
  workingFooter,
  workingStateStore,
}: {
  centerMessages: boolean
  conversationItemsStore: ConversationItemsStore
  hideToolBlocks: boolean
  agentStore: SmithStore<AgentState>
  workingFooter: React.ReactNode
  workingStateStore: SmithStore<AppShellWorkingState | null>
}) {
  const hideThinking = useSelector(
    agentStore,
    (agentState) => agentState.hideThinkingBlock
  )
  const compacting = useSelector(
    workingStateStore,
    (workingState) => workingState?.label === COMPACT_WORKING_LABEL
  )
  const streaming = useSelector(
    agentStore,
    (agentState) => agentState.streaming
  )
  const hasMessages = useConversationHasMessages(conversationItemsStore)
  if (!hasMessages) return null

  return (
    <AppShellConversationItemGroups
      centerMessages={centerMessages}
      compacting={compacting}
      conversationItemsStore={conversationItemsStore}
      hideFooter={false}
      hideThinking={hideThinking}
      hideToolBlocks={hideToolBlocks}
      streaming={streaming}
      workingFooter={workingFooter}
    />
  )
}

export const AppShellAgentConversation = React.memo(
  function AppShellAgentConversation({
    awaitingFirstTurn,
    conversationFrameRef,
    conversationItemsStore,
    displaySettingsStore,
    historyLoad,
    isAgentViewLoading,
    isSubmitting,
    onCancelCompaction,
    onCreateAgent,
    onLoadHistory,
    agentStore,
    viewerContextId,
    workingStateStore,
  }: {
    awaitingFirstTurn: boolean
    conversationFrameRef: React.RefObject<AppShellConversationFrameHandle | null>
    conversationItemsStore: ConversationItemsStore
    displaySettingsStore: SmithStore<AppShellDisplaySettingsState>
    historyLoad: HistoryLoadKind | null
    isAgentViewLoading: boolean
    isSubmitting: boolean
    onCancelCompaction: () => void
    onCreateAgent: () => void
    onLoadHistory: (kind: HistoryLoadKind) => Promise<boolean>
    agentStore: SmithStore<AgentState>
    viewerContextId: string
    workingStateStore: SmithStore<AppShellWorkingState | null>
  }) {
    const agentState = useAppShellConversationAgentState(agentStore)
    const { autoScrollEnabled, centerMessages, hideToolBlocks } =
      useSelector(displaySettingsStore)
    const hideThinking = useSelector(
      agentStore,
      (currentAgentState) => currentAgentState.hideThinkingBlock
    )

    React.useLayoutEffect(() => {
      conversationItemsStore.setItems(agentStore.state.items)
    }, [conversationItemsStore, hideThinking, hideToolBlocks, agentStore])

    const headItems = useSelector(
      agentStore,
      (currentAgentState) => currentAgentState.headItems
    )
    const [headItemsStore] = React.useState<ConversationItemsStore>(() =>
      createConversationItemsStore(agentStore.state.headItems)
    )
    React.useLayoutEffect(() => {
      headItemsStore.setItems(headItems)
    }, [headItems, headItemsStore, hideThinking, hideToolBlocks])

    return (
      <AppShellConversationFrame
        ref={conversationFrameRef}
        autoScrollEnabled={autoScrollEnabled}
        centerMessages={centerMessages}
        conversationItemsStore={conversationItemsStore}
        head={
          <ConversationHistoryHead
            centerMessages={centerMessages}
            hideThinking={hideThinking}
            hideToolBlocks={hideToolBlocks}
            store={headItemsStore}
          />
        }
        historyLoad={historyLoad}
        isAgentViewLoading={isAgentViewLoading}
        onLoadHistory={onLoadHistory}
        agentState={agentState}
        emptyState={
          <AppShellConversationEmptyState
            awaitingFirstTurn={awaitingFirstTurn}
            conversationItemsStore={conversationItemsStore}
            cwd={agentState.cwd}
            draft={agentState.draft}
            isAgentViewLoading={isAgentViewLoading}
            isSubmitting={isSubmitting}
            onCreateAgent={onCreateAgent}
            streaming={agentState.streaming}
            viewerContextId={viewerContextId}
            workingStateStore={workingStateStore}
          />
        }
      >
        <AppShellConversationMessageStack
          centerMessages={centerMessages}
          conversationItemsStore={conversationItemsStore}
          hideToolBlocks={hideToolBlocks}
          agentStore={agentStore}
          workingFooter={
            <AppShellConversationWorkingFooter
              centerMessages={centerMessages}
              conversationItemsStore={conversationItemsStore}
              onCancelCompaction={onCancelCompaction}
              workingStateStore={workingStateStore}
            />
          }
          workingStateStore={workingStateStore}
        />
      </AppShellConversationFrame>
    )
  }
)
