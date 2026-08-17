# Agent Note: Win32 选择器提升到浏览器所有者窗口之上

Status: implemented

[English](2026-08-17-win32-picker-foreground-activation.md) | 中文

## 问题

Windows 上的操作者反馈：添加工作区时，文件夹对话框出现在浏览器后面，只有点击程序的任务栏入口才会显示。此前的[进程内对话框 note](../feature/2026-08-02-win32-in-process-folder-dialog.md) 基于「对话框是子进程的第一个窗口，因此 Windows 会自动激活它，无需前台调用」的假设——对后台进程而言这一假设不成立。对话框子进程由 Web 宿主服务器 spawn：它不是前台进程、不是由前台进程启动的、也从未收到过输入，因此 Windows 的前台锁会拒绝 `Show` 内部的激活请求。无所有者的对话框还保留自己的任务栏入口——正是操作者不得不点击的那个入口。

## 决策

`runFolderDialog` 现在通过所有者提升对话框，而不是依赖「子进程的第一个窗口」。在 `Show` 之前，它立即捕获 `GetForegroundWindow()`——操作者刚刚点击的浏览器窗口——把该句柄作为 `IModalWindow::Show` 的所有者传入，并在模态存续期间把本线程的输入队列挂接到所有者的线程上（`AttachThreadInput(currentThreadId, ownerThreadId, TRUE)`），`Show` 返回后在每条路径上（选择、取消、失败）解除挂接。所有者关系让对话框保持在浏览器之上、为正确的模态行为禁用所有者窗口，并去掉对话框独立的任务栏入口；共享的输入队列使 shell 对话框内部的激活在前台锁下合法，对话框因此浮起并获得键盘焦点。两者均为 best-effort：没有前台窗口、或 `AttachThreadInput` 被拒绝（所有者已销毁，或 UIPI 下的跨完整性级别所有者）时，选择器仍以带所有者的形式显示，只损失激活保证。`showing` 通知、`WM_CLOSE` 中止服务与 worker 载荷保持不变——driver 无需感知所有者。

## 考虑过的替代方案

- **只传所有者，不挂接输入。** 否决：所有者关系修复 z 顺序、模态与任务栏入口，但不修复激活——前台锁仍允许 Windows 拒绝后台子进程的激活请求，留下一个可见但无焦点的对话框。
- **Show 之后由辅助线程激活对话框窗口。** 否决：Show 阻塞了唯一能对其排程的线程，因此激活需要一个第二线程轮询 `EnumThreadWindows` 找对话框窗口，并再次面对同样的前台锁；输入挂接是阻塞线程上的一对调用，并让 shell 自己的激活成功。
- **模拟 ALT 按键以解锁 SetForegroundWindow。** 否决：输入注入依赖锁状态，且仍需要 Show 中途的对话框 HWND。
- **在宿主进程采样前台窗口并经 worker 载荷传递。** 否决：宿主是服务器进程；采样必须尽量贴近 Show 时刻，而 worker 自身的 Show 前捕获已经是这一时刻，载荷为此扩容没有任何时序收益。

## 后果

- 在 Show 时刻存在前台窗口的宿主机上，选择器出现在浏览器之上、持有焦点、且没有自己的任务栏入口。
- 对话框线程的输入队列在模态存续期间与浏览器 UI 线程相连；所有者线程挂起会拖住对话框输入直到选择关闭。这一点被接受，因为所有者正是操作者正在使用的窗口。
- 关闭浏览器会连同销毁其所拥有的对话框；调用方的连接中止仍照旧投递 WM_CLOSE 并终止 worker。
- fake 绑定时序测试钉住所有者捕获、Show 前挂接、每条路径上的解除配对，以及无所有者／挂接被拒的降级；mock koffi 的 COM 世界钉住 GetForegroundWindow/GetWindowThreadProcessId/AttachThreadInput 接线与 Show 的所有者实参；win32 专属的打开即中止冒烟测试仍证明真实对话框能打开并收尾。激活本身只能在真实桌面上观察——CI Windows lane 与手动 Windows 验证负责这一信号，因为 keyless 快照无法捕获 OS 对话框的 z 顺序。
- [进程内对话框 note](../feature/2026-08-02-win32-in-process-folder-dialog.md) 的激活表述已更新为实际交付的机制。
