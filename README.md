[Русский](README.md) · [English](README.en.md)

# Remnacust Node

Агент Remnacust получает конфигурацию от панели, управляет Xray и передаёт статистику. Расширения квот, скорости, хостов и устройств требуют совместимого Remnacust Core.

## Стабильный комплект

| Компонент | Опубликованная версия |
| --- | --- |
| Installer | [1.2.136](https://github.com/lottman/Remnacust-installer/releases/tag/v1.2.136) |
| Панель и страница подписки | [1.1.7.97](https://github.com/lottman/Remnacust-panel/releases/tag/v1.1.7.97) |
| Node | [1.1.22](https://github.com/lottman/Remnacust-node/releases/tag/v1.1.22), основа Remnawave Node 3.4.3 |
| Core | [1.1.13](https://github.com/lottman/Remnacust-core/releases/tag/v1.1.13), Xray v26.10.31 |

Версии агента и ядра независимы. Обновление панели не обновляет удалённую ноду. Текущая ветка может содержать ещё не выпущенные изменения.

## Установка на VPS

Стабильный Installer 1.2.136 поддерживает **Ubuntu 22.04/24.04/26.04 LTS**, Linux **amd64/arm64**. Поддержка Debian 12/13 добавлена локально и **ещё не опубликована**.

Начальный ориентир — **1 CPU и 1 GiB RAM**, без гарантии числа пользователей, соединений или пропускной способности. Расход ресурсов зависит от транспорта, правил, шифрования и нагрузки. На VPS используются готовые Docker-образы; Node.js и Go на хосте не нужны.

Создайте ноду в панели и получите ключ подключения:

```bash
curl -fsSL --proto '=https' --proto-redir '=https' \
  https://github.com/lottman/Remnacust-installer/releases/download/v1.2.136/installer.sh \
  -o installer.sh
sudo bash installer.sh install-node --version 1.2.136
```

Укажите ключ и API-порт (по умолчанию `2222`); порт в панели должен совпадать. Для клиентского трафика отдельно назначьте профиль, включите inbound, разрешите его скваду и создайте хост с нужным адресом и портом.

API использует HTTPS с mTLS и JWT. Ограничивайте доступ к API отдельно от клиентских портов; не отключайте проверку TLS. Опция `--panel-ip` ограничивает **все входящие порты и ICMP адресом панели, кроме SSH**: прямые клиенты и CDN с других IP также будут заблокированы. `NET_ADMIN` — дополнительное право контейнера для сетевых операций; выбирайте его согласно своей схеме.

## Постоянные файлы и состояние

```text
/opt/remnacust/node/.env
/opt/remnacust/node/docker-compose.yml
/opt/remnacust/FILES.txt
/opt/remnacust/backups/
/opt/remnacust/logs/
```

Активные пути перечислены в `FILES.txt`. Сохраняйте `SECRET_KEY`, весь `.env`, Compose, сертификаты и приватное состояние. Не публикуйте ключи и содержимое служебных каталогов.

| Каталог хоста рядом с Compose | Каталог контейнера |
| --- | --- |
| `run/` | `/var/lib/remnacust/run` |
| `state/host-policy/` | `/var/lib/remnanode` |
| `state/core-manager/` | `/var/lib/remnawave/core-manager` |

Установщик задаёт эти постоянные mounts. Старый ручной контейнер без mounts **до пересоздания** остановите и сохраните все три приватных каталога, например через `docker cp -a`, с владельцами и правами. Пустые mounts скрывают прежние checkpoint и журналы. Не удаляйте выданное состояние квот ради запуска или отката.

После изменения `.env` нужен recreate: обычный restart не перечитывает переменные. Убедившись в сохранности состояния и корректности mounts:

```bash
cd /opt/remnacust/node
docker compose config --quiet
docker compose up -d --no-build --pull never
```

## Обновление и диагностика

```bash
sudo remnacust upgrade-node
sudo remnacust manage-node
sudo remnacust status --component node
sudo remnacust logs --component node
sudo remnacust restart --component node
```

`upgrade-node` обновляет образ агента со встроенным Core. Отдельно выбранное управляемое ядро может оставаться закреплённым: проверяйте фактически активную версию и режим через управление нодой. Обновление или выбор Core — отдельная операция с проверкой совместимости сохранённых политик.

Совместимые runtime-изменения профиля могут сохранять соединения; смена listener, порта, транспорта или процесса может их прервать. Планируйте обслуживание без обещаний обновления без разрыва сессий.

При проблемах проверьте API-адрес, порт, ключ, TLS и firewall, затем Core, inbound, хост, сквад и подписку. Статус API online не доказывает доступность клиентского пути через CDN. [Руководство установщика](https://github.com/lottman/Remnacust-installer/blob/main/installer/README.md).

## Автономность и совместимость

Работающий Core может обслуживать трафик без панели в пределах действующих прав и сохранённых политик. Срок доступа продолжает действовать; локальный кредит ограничен остатком грантов применимых квот USER/HOST/TAG и границами их периода. Календарный сброс не выдаёт новый кредит без панели.

Для суток автономности нужен запас срока и локального кредита на ожидаемый трафик и восстановление. Restart дополнительно требует совместимых версий, сохранённых конфигурации, credentials и журналов. Это не безусловная гарантия 24 часов для любой старой установки. [Условия автономности](https://github.com/lottman/Remnacust-panel/blob/main/docs/NODE-AUTONOMY.md).

Обычные Remnawave Node/Xray совместимы со стандартными конфигурациями в пределах своих возможностей; они не получают автоматически расширения Remnacust для квот, устройств и восстановления. Не обходите проверки политик для установки старого ядра. Xera HTTP (`network: "xera-http"`) требует совместимых клиента и сервера; стандартный XHTTP — отдельный транспорт. [Совместимость](docs/NODE-COMPATIBILITY.md) · [Области лимитов](https://github.com/lottman/Remnacust-panel/blob/main/docs/HOST-LIMITS.md).

## Ещё не опубликовано

Локальная ветка добавляет ограниченное восстановление Core после аварии без панели с учётом административной паузы и проверки состояния, а также постоянные mounts ручного Compose. Полное исправление offline restart требует новых согласованных Node и Core; его нет в опубликованном комплекте выше. Новые MUX/Xera/uTLS-исправления описаны в [Core](https://github.com/lottman/Remnacust-core).

## Сборка и документация

Разработка агента требует **Node.js 24**, сборка самого Core — **Go 1.27.3**. Из корня репозитория:

```bash
docker build -f node/docker/Dockerfile -t remnacust-node:local node
```

Это сборка текущего checkout, а не загрузка стабильного релиза. Архив Core проверяется по SHA-256; изменение ядра требует согласованной перепаковки и сборки. [Разработка агента](node/README.md) · [Сборка](docs/BUILDING.md) · [Панель](https://github.com/lottman/Remnacust-panel).

## Авторство и лицензии

Remnacust поддерживается lottman. Агент основан на [Remnawave Node](https://github.com/remnawave/node), сохраняет авторство REMNAWAVE и участников проекта и лицензию **AGPL-3.0-only**. Core сохраняет **MPL-2.0** и авторство XTLS/Xray-core; зависимости — собственные лицензии. [NOTICE.md](NOTICE.md) · [Поддержка](https://t.me/lottman).
