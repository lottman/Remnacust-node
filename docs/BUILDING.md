# Сборка ноды

Проверка агента требует Node.js 24:

```bash
cd node
npm ci
npm run typecheck
npm run build
```

Runtime использует Linux и Unix-сокеты. Полный образ из корня checkout:

```bash
docker build -f node/docker/Dockerfile -t remnacust-node:1.1.1 node
bash scripts/test-node-startup.sh remnacust-node:1.1.1
```

Проверка запуска создаёт временные ключи и контейнер, проверяет версии, JWT и mTLS, затем удаляет тестовые файлы. Рабочие ключи не требуются.

Исходники ядра включены в проверяемый архив `node/docker/remnacust-core.tar.gz`. Если меняете ядро, клонируйте рядом [Remnacust-core](https://github.com/lottman/Remnacust-core), внесите изменения и из корня ноды выполните `python3 node/docker/package-remnacust-core.py`. Добавьте обновлённый архив и его SHA-256 в тот же коммит, затем пересоберите образ.

[Выпуск компонентов](https://github.com/lottman/Remnacust-installer/blob/main/docs/PUBLISHING.md).
