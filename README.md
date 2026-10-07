# Remnacust Node

Агент ноды получает конфигурацию и пользователей от панели, запускает Xray и возвращает статистику. Образ включает наше ядро с квотами хостов, ограничениями скорости и отзывом доступа устройств.

**Версия 1.1.1** · **Основа: Remnawave Node 3.4.1** · [Панель](https://github.com/lottman/Remnacust-panel) · [Ядро](https://github.com/lottman/Remnacust-core)

Агент сообщает панели версию `1.1.1-remnacust`; версия Xray передаётся отдельно. Для обычной работы нужны Linux, Docker Engine и Compose v2. Управляющий порт должен быть доступен панели, порты inbound — клиентам.

## Установка

Установщик поддерживает только Ubuntu 22.04 LTS и 24.04 LTS, amd64/arm64. Для работы ноды нужны минимум 1 CPU и 1 GiB RAM; потребление зависит от нагрузки Xray. Установщик скачивает готовый Docker-образ; Node.js и Go на сервере не нужны.

Сначала создайте ноду в панели и скопируйте её ключ подключения. Затем выполните в консоли сервера:

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://github.com/lottman/Remnacust-installer/releases/latest/download/installer.sh -o installer.sh && sudo bash installer.sh install-node
```

[Скачать installer.sh](https://github.com/lottman/Remnacust-installer/releases/latest/download/installer.sh). Скрипт спросит версию выпуска установщика и ключ; Enter выбирает `latest`. Установщик 1.1.6 содержит панель 1.1.2, ноду и ядро 1.1.1. По умолчанию порт управления — 2222. Пример с явно указанным портом и выпуском:

```bash
sudo bash installer.sh install-node --port 2222 --version 1.1.6
```

Укажите тот же порт в карточке ноды. Ключ вводится скрыто; отдельный токен для скачивания не нужен. После запуска назначьте профиль и включите inbound, разрешите его во внутреннем скваде, создайте хост и проверьте подключение тестового пользователя.

Обновление и перенос:

```bash
sudo remnacust upgrade-node
sudo bash installer.sh migrate-remnawave-node --container remnanode
```

Обновляются агент и встроенный Xray. Ключ, порты и mounts сохраняются. Перезапуск может прервать текущие соединения. Настройка TLS/XHTTP и firewall: [руководство установщика](https://github.com/lottman/Remnacust-installer#readme).

## Сборка из исходников

```bash
git clone https://github.com/lottman/Remnacust-node.git
cd Remnacust-node
docker build -f node/docker/Dockerfile -t remnacust-node:1.1.1 node
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

## Лицензия

Агент сохраняет AGPL-3.0 Remnawave Node; встроенное ядро — MPL-2.0 Xray-core. Авторство и лицензии сохранены в исходниках и [NOTICE.md](NOTICE.md).

Готовые Docker-образы для amd64 и arm64 собираются в GitHub Actions и входят в выпуск установщика. Скачивание из GHCR и GitHub Release открыто; токен не нужен.
