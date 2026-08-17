# Agent Note: The Win32 picker raises over its browser owner

Status: implemented

English | [中文](2026-08-17-win32-picker-foreground-activation.zh.md)

## Problem

Operators on Windows reported that adding a workspace opens the folder dialog behind the browser: the dialog appears only after clicking the program's taskbar entry. The [in-process dialog note](../feature/2026-08-02-win32-in-process-folder-dialog.md) had shipped the assumption that "the dialog is the child's first window, so Windows activates it without a foreground call" — false for a background process. The dialog child is spawned by the Web host server: it is not the foreground process, was not started by the foreground process, and never received input, so Windows' foreground lock denies the activation `Show` requests from inside. The unowned dialog also kept its own taskbar entry, the entry operators had to click.

## Decision

`runFolderDialog` now raises the dialog through its owner instead of relying on being the child's first window. Immediately before `Show` it captures `GetForegroundWindow()` — the browser window the operator just clicked — passes that handle as the `IModalWindow::Show` owner, and attaches this thread's input queue to the owner's thread (`AttachThreadInput(currentThreadId, ownerThreadId, TRUE)`) for the modal lifetime, detaching once `Show` returns on every path (selection, cancel, failure). Ownership keeps the dialog above the browser, disables the owner for proper modality, and removes the dialog's separate taskbar entry; the shared input queue makes the shell dialog's internal activation legal under the foreground lock, so the dialog rises and takes keyboard focus. Both are best-effort: with no foreground window, or when `AttachThreadInput` refuses (a dead owner, or a cross-integrity owner under UIPI), the picker still shows the owned dialog and degrades only the activation guarantee. The `showing` notice, the `WM_CLOSE` abort service, and the worker payload are unchanged — the driver needs no owner awareness.

## Alternatives considered

- **Owner only, no input attach.** Rejected: ownership fixes z-order, modality, and the taskbar entry but not activation — the foreground lock still lets Windows deny the background child's activation request, leaving a visible but unfocused dialog.
- **Activate the dialog window from a helper thread after Show.** Rejected: Show blocks the only thread that can sequence it, so activation needs a second thread polling `EnumThreadWindows` for the dialog window and the same foreground-lock fight; the input attach is one call pair on the blocking thread and makes the shell's own activation succeed.
- **Simulate an ALT keypress to unlock SetForegroundWindow.** Rejected: input injection depends on lock state and still needs the dialog HWND mid-Show.
- **Sample the foreground window in the host and pass it through the worker payload.** Rejected: the host is the server process; sampling must happen as close to Show as possible, which the worker's own pre-Show capture already is, and the payload would grow for no timing benefit.

## Consequences

- The picker appears above the browser, focused, and without its own taskbar entry on hosts with a foreground window at Show time.
- The dialog thread's input queue is joined to the browser's UI thread for the modal lifetime; a hung owner thread stalls dialog input until the pick closes. Accepted because the owner is the window the operator is actively using.
- Closing the browser destroys the owned dialog with it; the caller's connection abort still posts WM_CLOSE and kills the worker as before.
- Fake-binding sequencing tests pin owner capture, attach-before-Show, detach pairing on every path, and the no-owner/attach-refusal degradations; the mocked-koffi COM world pins the GetForegroundWindow/GetWindowThreadProcessId/AttachThreadInput wiring and Show's owner argument; the win32-only open-and-abort smoke still proves the real dialog opens and unwinds. Activation itself is observable only on a real desktop — the CI Windows lane and manual Windows verification own that signal, as keyless snapshots cannot capture OS dialog z-order.
- The [in-process dialog note](../feature/2026-08-02-win32-in-process-folder-dialog.md)'s activation sentence is updated to the shipped mechanism.
