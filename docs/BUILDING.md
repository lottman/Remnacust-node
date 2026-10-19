# Сборка ноды

Проверка агента требует Node.js 24:

```bash
cd node
npm ci
npm run typecheck
NODE_ENV=production npm run build
```

Runtime использует Linux и Unix-сокеты. Полный образ из корня checkout:

```bash
docker build -f node/docker/Dockerfile -t remnacust-node:local-check node
bash scripts/test-node-startup.sh remnacust-node:local-check
```

Проверка запуска создаёт временные ключи и контейнер, сверяет версии с текущим package.json ноды и lock-файлом упакованного ядра. Проверяются рабочий JWT, отказ без JWT, просроченная и поддельная подписи, alg=none, подмена RS256 на HS256 и отказ без клиентского сертификата mTLS. После проверки контейнер и временные ключи удаляются. Рабочие ключи не требуются; имя проверяемого образа обязательно передаётся аргументом.

Исходники ядра включены в проверяемый архив `node/docker/remnacust-core.tar.gz`. Если меняете ядро, клонируйте рядом [Remnacust-core](https://github.com/lottman/Remnacust-core), внесите изменения и из корня ноды выполните `python3 node/docker/package-remnacust-core.py`. Добавьте обновлённый архив и его SHA-256 в тот же коммит, затем пересоберите образ.

[Выпуск компонентов](https://github.com/lottman/Remnacust-installer/blob/main/docs/PUBLISHING.md).

## Нода 1.1.13

Встроенное ядро 1.1.8 отделяет предупреждения CLI от JSON-ответов. Профили с предупреждением об устаревшем freedom.domainStrategy больше не срывают применение из-за ошибки разбора JSON. Для установленной ноды обновите образ, а не только панель. Клиентские протоколы и права контейнера этим исправлением не меняются.
