---
description: 备份、恢复或从旧 WorkLog 导入归档
---

用户输入：$ARGUMENTS

调用 `worklog_backup`：

- 为空或 `list` → `{ action: "list" }`
- `create` → `{ action: "create" }`
- `restore <文件名>` → `{ action: "restore", name }`。**恢复会覆盖同名日日志与待办**，执行前必须让用户确认目标文件名和影响范围。
- `delete <文件名>` → `{ action: "delete", name }`。删除前同样确认。
- `import <旧 WorkLog 安装目录>` → `{ action: "import", sourceDir }`，例如 `E:\WorkLog`。只复制 `data\archive`，不删除源目录。

操作后用中文汇报结果（多少天日志、多少条待办）。
