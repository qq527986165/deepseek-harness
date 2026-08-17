/**
 * Pure sequencing of the Win32 `IFileOpenDialog` folder-picker COM
 * conversation over injectable platform bindings, so every outcome path
 * (selection, cancellation, HRESULT failure, cleanup ordering) is testable on
 * any platform. The koffi-backed bindings live in
 * `win32-dialog-bindings.ts`, which only a real win32 process ever loads.
 */

/** `HRESULT_FROM_WIN32(ERROR_CANCELLED)`: the user dismissed the dialog. */
export const HRESULT_CANCELLED = 0x800704c7 | 0

/** `FOS_PICKFOLDERS`: the dialog selects directories, not files. */
export const FOS_PICKFOLDERS = 0x20
/** `FOS_FORCEFILESYSTEM`: only results with a filesystem path can be chosen. */
export const FOS_FORCEFILESYSTEM = 0x40
/** `FOS_NOCHANGEDIR`: never mutate the process working directory. */
export const FOS_NOCHANGEDIR = 0x8

/** One created folder dialog: the vtable calls the sequencing needs. */
export interface Win32FolderDialog {
  /**
   * `IFileDialog::SetOptions`.
   * @param options - the `FOS_*` flag union to apply.
   * @returns the call's HRESULT.
   */
  setOptions(options: number): number
  /**
   * `IFileDialog::SetTitle`.
   * @param title - the dialog title text.
   * @returns the call's HRESULT.
   */
  setTitle(title: string): number
  /**
   * `IModalWindow::Show` with the operator's foreground window as owner;
   * blocks the calling thread until the user selects or dismisses. The owner
   * keeps the dialog above the browser window, disables it for the modal
   * lifetime, and removes the dialog's separate taskbar entry.
   * @param owner - the owner window handle, or null to show without one.
   * @returns the call's HRESULT (`HRESULT_CANCELLED` on dismissal).
   */
  show(owner: unknown): number
  /**
   * `IFileDialog::GetResult` + `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)`,
   * releasing the shell item and freeing the COM string.
   * @returns the call chain's HRESULT and, on success, the selected path.
   */
  resultPath(): { hr: number; path?: string }
  /** Release the dialog's COM reference. */
  release(): void
}

/** The thread-level native surface the dialog sequencing runs against. */
export interface Win32DialogBindings {
  /**
   * Opt the calling thread into the best supported DPI awareness
   * (per-monitor-v2, then per-monitor, then system-aware), checking each
   * call's result. Best-effort on purpose: a host accepting none of them
   * (or lacking the API, pre-1607) still shows the modern dialog — possibly
   * blurry above 100 % scaling — because a cosmetic degradation must not
   * cost the tier.
   */
  setThreadDpiAwareness(): void
  /**
   * `CoInitializeEx(COINIT_APARTMENTTHREADED)` on the calling thread.
   * @returns the call's HRESULT (`S_FALSE` re-entry is still a success).
   */
  coInitializeSta(): number
  /**
   * `CoUninitialize` on the calling thread — COM requires one pairing call
   * for every successful (including `S_FALSE`) `CoInitializeEx`, even on a
   * thread that exits right after the conversation.
   */
  coUninitialize(): void
  /**
   * `CoCreateInstance(CLSID_FileOpenDialog)`.
   * @returns the created dialog surface; throws when creation fails.
   */
  createFolderDialog(): Win32FolderDialog
  /**
   * `GetCurrentThreadId` — the native id a driver needs to close this
   * thread's windows from outside.
   * @returns the calling thread's native id.
   */
  currentThreadId(): number
  /**
   * `GetForegroundWindow` — the window the operator was interacting with
   * (the Web GUI browser window) when the pick started. Used as the
   * dialog's owner and as the thread whose input queue the picker joins
   * for foreground activation.
   * @returns the foreground window handle, or null when there is none.
   */
  foregroundWindow(): unknown
  /**
   * `AttachThreadInput` — join the calling thread's input queue with the
   * owner window's thread so the modal `Show` may activate the dialog
   * despite Windows' foreground lock (the worker is a background process).
   * Best-effort: `false` still shows the owned dialog, only without the
   * activation guarantee.
   * @param owner - the foreground window handle from {@link foregroundWindow}.
   * @returns whether the queues are attached (the caller must then detach).
   */
  attachForegroundInput(owner: unknown): boolean
  /**
   * Undo {@link attachForegroundInput} for the same owner; call exactly
   * once per successful attach, after `Show` returns.
   * @param owner - the window handle attach used.
   */
  detachForegroundInput(owner: unknown): void
}

/**
 * Throw when an HRESULT signals failure.
 * @param hr - the HRESULT to check.
 * @param what - the failing call's name for the error message.
 * @returns the (successful) HRESULT unchanged.
 */
function check(hr: number, what: string): number {
  if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`)
  return hr
}

/**
 * Run one modal folder-picker conversation on the calling thread: DPI opt-in,
 * STA init, dialog creation, owner capture, `Show`, and result extraction,
 * releasing the dialog on every path. The dialog is owned by the operator's
 * current foreground window and this thread's input queue is attached to the
 * owner's for the modal lifetime, so Windows raises and activates the dialog
 * instead of leaving a background child's window behind the browser.
 * @param bindings - the native surface (koffi-backed in production, fakes in tests).
 * @param title - the dialog title text.
 * @param onShowing - called with the native thread id immediately before the
 *   blocking `Show`, so a driver on another thread can close the dialog.
 * @returns the selected filesystem path, or null when the user cancels.
 */
export function runFolderDialog(
  bindings: Win32DialogBindings,
  title: string,
  onShowing: (threadId: number) => void,
): string | null {
  bindings.setThreadDpiAwareness()
  check(bindings.coInitializeSta(), 'CoInitializeEx')
  // From here the apartment is initialized (S_OK or S_FALSE) and must be
  // uninitialized exactly once on every path.
  try {
    const dialog = bindings.createFolderDialog()
    const owner = bindings.foregroundWindow()
    // Attach only right before Show; the pairing detach below is skipped
    // when the attach refused (no foreground window, or a thread Windows
    // would not join — e.g. a cross-integrity owner).
    let inputAttached = false
    try {
      check(dialog.setOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR), 'SetOptions')
      check(dialog.setTitle(title), 'SetTitle')
      onShowing(bindings.currentThreadId())
      inputAttached = owner !== null && bindings.attachForegroundInput(owner)
      const shown = dialog.show(owner)
      if (shown === HRESULT_CANCELLED) return null
      check(shown, 'Show')
      const result = dialog.resultPath()
      check(result.hr, 'GetResult')
      return result.path as string
    } finally {
      if (inputAttached) bindings.detachForegroundInput(owner)
      dialog.release()
    }
  } finally {
    bindings.coUninitialize()
  }
}
