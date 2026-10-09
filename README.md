# Remnacust Node

Агент ноды получает конфигурацию и пользователей от панели, запускает Xray и возвращает статистику. Образ включает наше ядро с квотами хостов, ограничениями скорости и отзывом доступа устройств.

**Версия 1.1.6** · **Основа: Remnawave Node 3.4.2** · [Панель](https://github.com/lottman/Remnacust-panel) · [Ядро](https://github.com/lottman/Remnacust-core)

Агент сообщает панели версию `1.1.6-remnacust`; версия Xray передаётся отдельно. Для обычной работы нужны Linux, Docker Engine и Compose v2. Управляющий порт должен быть доступен панели, порты inbound — клиентам.

## Установка

Установщик поддерживает только Ubuntu 22.04 LTS, 24.04 LTS и 26.04 LTS, amd64/arm64. Для работы ноды нужны минимум 1 CPU и 1 GiB RAM; потребление зависит от нагрузки Xray. Установщик скачивает готовый Docker-образ; Node.js и Go на сервере не нужны.

Сначала создайте ноду в панели и скопируйте её ключ подключения. Затем выполните в консоли сервера:

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://github.com/lottman/Remnacust-installer/releases/latest/download/installer.sh -o installer.sh && sudo bash installer.sh install-node
```

[Скачать installer.sh](https://github.com/lottman/Remnacust-installer/releases/latest/download/installer.sh). Скрипт спросит версию выпуска, API-порт, адрес панели для ограничения доступа и ключ; предложит TLS/XHTTP с выбором сертификата и email ACME; Enter выбирает `latest`. Установщик 1.2.25 содержит панель 1.1.7.5, ноду 1.1.6 и ядро 1.1.4. По умолчанию порт управления — 2222. Пример с явно указанным портом и выпуском:

```bash
sudo bash installer.sh install-node --port 2222 --version 1.2.25
```

Укажите тот же порт в карточке ноды. Ключ вводится скрыто; отдельный токен для скачивания не нужен. После запуска назначьте профиль и включите inbound, разрешите его во внутреннем скваде, создайте хост и проверьте подключение тестового пользователя.

Обновление и перенос:

```bash
sudo remnacust upgrade-node
sudo bash installer.sh migrate-remnawave-node --container remnanode
```

Обновляются агент и встроенный Xray. Ключ, порты и mounts сохраняются. Перезапуск может прервать текущие соединения. HTTPS можно настроить через HTTP-01, Cloudflare/Gcore DNS или готовую пару сертификат–ключ; управляемый сертификат продлевается отдельным таймером. Настройка TLS/XHTTP и firewall: [руководство установщика](https://github.com/lottman/Remnacust-installer#readme).

## Сборка из исходников

```bash
git clone https://github.com/lottman/Remnacust-node.git
cd Remnacust-node
docker build -f node/docker/Dockerfile -t remnacust-node:1.1.6 node
cp node/.env.sample node/.env
chmod 600 node/.env
```

Заполните `NODE_PORT` и `SECRET_KEY` в `node/.env`, затем запустите:

```bash
cd node
docker compose -f docker-compose-prod.yml up -d
docker compose -f docker-compose-prod.yml ps
docker compose -f docker-compose-prod.yml logs --tail=100 remnanode
```

Контейнер использует `network_mode: host`. Ограничьте доступ к управляющему порту адресом панели в firewall сервера или провайдера. Порты inbound открывайте по профилю Xray.

Проверенный архив исходников ядра включён в `node/docker` и проверяется по SHA-256. Для изменения ядра клонируйте рядом `Remnacust-core`, внесите изменения и выполните `python3 node/docker/package-remnacust-core.py` из корня этого репозитория. Затем пересоберите образ.

## Если подключение не работает

Если панель не видит агент, проверьте адрес, управляющий порт, ключ и firewall. Если агент доступен, проверьте профиль, клиентский порт, хост и сквад пользователя. После обновления проверьте версии агента и ядра, журнал запуска и изменение счётчика трафика.

Стандартный Xray не выполняет расширения Remnacust для хостов и устройств. Для этих функций используйте агент и ядро одного выпуска. [Совместимость](docs/NODE-COMPATIBILITY.md) · [Поддержка](https://t.me/lottman).

## Xera HTTP

Xera HTTP — форк транспорта XHTTP (SplitHTTP) из Xray-core, с собственными настройками `network: "xera-http"` и `xeraHttpSettings`. Для соединения его должны поддерживать ядра обеих сторон. Настройка, отличия, режимы и переход с XHTTP описаны в [руководстве панели](https://github.com/lottman/Remnacust-panel/blob/main/panel/frontend/public/documentation/guide-ru.md#транспорт-xera-http).

## Лицензия

Агент сохраняет AGPL-3.0 Remnawave Node; встроенное ядро — MPL-2.0 Xray-core. Авторство и лицензии сохранены в исходниках и [NOTICE.md](NOTICE.md).

Готовые Docker-образы для amd64 и arm64 собираются в GitHub Actions и входят в выпуск установщика. Скачивание из GHCR и GitHub Release открыто; токен не нужен.

В ноде 1.1.6 используется ядро 1.1.4: отзыв устройства обрывает его активное соединение, не отключая другие устройства с того же IP. Для применения исправления обновите ноду через `upgrade-node`. Порт, ключ подключения, тома и существующий проект Compose сохраняются.

Управляющий gRPC API Xray доступен агенту через файловый Unix socket в каталоге с правами `0700`; socket имеет права `0600`. Другой локальный пользователь не может обращаться к нему. Обновление ноды сохраняет внешний API-порт и ключ подключения панели.
