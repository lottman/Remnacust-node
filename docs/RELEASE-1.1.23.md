# Node 1.1.23

Встроен Core 1.1.14 на Xray v26.10.31.

- Добавлено ограниченное восстановление совместимого Core после аварии без панели. Watchdog учитывает административную паузу, проверяет сохранённое состояние и готовность приватного API, ограничивает попытки и не мешает обновлению или остановке ядра.
- Постоянные каталоги состояния добавлены в ручной Compose. Старую установку без mounts перед recreate нужно остановить и сохранить все три приватных каталога с владельцами и правами; пустые mounts не являются миграцией.
- Проверка совместимости читает бинарник один раз за одну валидацию; метрики удаляют исчезнувшие сетевые интерфейсы.

Автономность ограничена сроками доступа, остатком локальных грантов и границами квотного периода. Восстановление требует сохранённых конфигурации, ключей и журналов; повреждённое состояние не открывает доступ. Для полного исправления offline restart нужны Node 1.1.23 и Core 1.1.14. Замена процесса прерывает его соединения.

---

Bundles Core 1.1.14 on Xray v26.10.31.

- Adds bounded recovery of a compatible Core after a crash without the panel. The watchdog respects administrative pause, validates persisted state and private API readiness, limits attempts and coordinates with core updates and stops.
- Adds persistent state directories to manual Compose. Before recreating an older deployment without mounts, stop it and preserve all three private directories with ownership and permissions; empty mounts are not a migration.
- Compatibility validation reads the binary once per validation; metrics remove disappeared network interfaces.

Offline operation remains limited by access expiry, remaining local grants and quota period deadlines. Recovery requires persisted configuration, keys and journals; damaged state does not grant access. The complete offline restart fix requires Node 1.1.23 and Core 1.1.14. Replacing the process interrupts its connections.
