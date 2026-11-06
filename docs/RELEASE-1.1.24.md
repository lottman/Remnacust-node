# Node 1.1.24

Встроен Core 1.1.15 на Xray v26.10.31.

- Отображаемое имя агента изменено на `rc-node`, ядра в Linux — на `rc-core`. Исполняемый файл `rw-core`, пути, приватное состояние и контракты core-manager сохраняются.
- Упаковщик исходников Core проверяет обязательные файлы vendored uTLS и olcRTC до записи архива, SHA-256 и Dockerfile. Неполный соседний или объединённый checkout завершается явной ошибкой, сохраняя прежние выходные файлы.
- Архив встроенного Core и его SHA-256 обновлены согласованно с версией 1.1.15.

Обновление панели не обновляет удалённые ноды. Обновите образ агента отдельно и проверьте активное ядро: отдельно выбранное managed-ядро может оставаться закреплённым. Сохраняйте `.env`, `SECRET_KEY` и все приватные каталоги состояния. Ограничения срока, квот и offline recovery из 1.1.23 сохраняются; замена процесса прерывает его соединения.

---

Bundles Core 1.1.15 on Xray v26.10.31.

- Changes the agent display name to `rc-node` and the Linux Core display name to `rc-core`. The `rw-core` executable filename, paths, private state and core-manager contracts remain compatible.
- The Core source packager checks required vendored uTLS and olcRTC files before writing the archive, SHA-256 or Dockerfile. An incomplete sibling or combined checkout fails explicitly and preserves previous outputs.
- Updates the bundled Core archive and its SHA-256 together with version 1.1.15.

Updating the panel does not update remote nodes. Update the agent image separately and check the active Core: a separately selected managed Core may remain pinned. Preserve `.env`, `SECRET_KEY` and all private state directories. Expiry, quota and offline recovery limits from 1.1.23 still apply; replacing the process interrupts its connections.
